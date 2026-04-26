import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { writeSessionStatus, clearSessionStatus } from "./sessionStatusFile.js";
import {
  createSession,
  realGitOps,
  stubGitOps,
  type GitOps,
  type CreateSessionResult,
} from "../session/createSession.js";
import {
  joinSession,
  realJoinGitOps,
  stubJoinGitOps,
  type JoinGitOps,
  type JoinSessionResult,
} from "../session/joinSession.js";
import type { StateUpdate, MetadataUpdate, NonLockStateUpdate } from "../state/stateUpdate.js";
import {
  type GovernanceConfig,
  type GovernanceMode,
  type ZeroTrustThreshold,
  GOVERNANCE_MODES,
  GOVERNANCE_CONFIG_KEY,
  DEFAULT_GOVERNANCE_CONFIG,
  isGovernanceConfig,
  isZeroTrustThreshold,
} from "../session/session.js";
import type { ExecutionTarget } from "../session/session.js";
import { createFreeHoopLock } from "../state/hoopLock.js";
import { ActiveEditsTracker } from "../state/activeEditsTracker.js";
import { PendingUpdatesWriter } from "../state/pendingUpdatesWriter.js";
import { PendingAdmissionsWriter } from "../state/pendingAdmissionsWriter.js";
import { OutboundUpdatesReader } from "../state/outboundUpdatesReader.js";
import { LockStatusWriter } from "../state/lockStatusWriter.js";
import { PendingPromptRequestsWriter } from "../state/pendingPromptRequestsWriter.js";
import { PendingPatchReviewsWriter } from "../state/pendingPatchReviewsWriter.js";
import { PROMPT_PROTOCOL, writeHalf, readFromStream, writeToStream } from "../network/protocol.js";
import type { PromptRequestMessage, PromptStatusQuery, PromptResponse, PromptRequestStatus } from "../state/promptRequest.js";

// ── Types ───────────────────────────────────────────────────────────

interface PendingAdmission {
  email: string;
  peerId: string;
  resolve: (admitted: boolean) => void;
  requestedAt: number;
}

interface PeerPromptRequest {
  id: string;
  status: PromptRequestStatus;
}

interface ServerState {
  role: "host" | "peer" | null;
  hostSession: CreateSessionResult | null;
  peerSession: JoinSessionResult | null;
  stopHostUpdateMirror: (() => void) | null;
  stopPeerDisconnectCleanup: (() => void) | null;
  stopPeerBroadcastSubscription: (() => void) | null;
  pendingUpdates: StateUpdate[];
  pendingAdmissions: Map<string, PendingAdmission>;
  pendingAdmissionsWriter: PendingAdmissionsWriter | null;
  pendingPromptRequestsWriter: PendingPromptRequestsWriter | null;
  pendingPatchReviewsWriter: PendingPatchReviewsWriter | null;
  peerPromptRequests: Map<string, PeerPromptRequest>;
  activeEditsTracker: ActiveEditsTracker | null;
  pendingUpdatesWriter: PendingUpdatesWriter | null;
  outboundUpdatesReader: OutboundUpdatesReader | null;
  lockStatusWriter: LockStatusWriter | null;
  observedGovernanceConfig: GovernanceConfig;
  governanceAlert: string | null;
}

export interface HoopMcpDeps {
  gitOps?: GitOps;
  joinGitOps?: JoinGitOps;
  conflictRegistryPath?: string;
  pendingUpdatesRegistryPath?: string;
  pendingAdmissionsRegistryPath?: string;
  outboundUpdatesRegistryPath?: string;
  lockStatusRegistryPath?: string;
  pendingPromptRequestsRegistryPath?: string;
  pendingPatchReviewsRegistryPath?: string;
  sessionStatusPath?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

// ── Server factory ──────────────────────────────────────────────────

export function createHoopMcpServer(deps?: HoopMcpDeps) {
  const gitOps = deps?.gitOps ?? realGitOps;
  const joinGitOps = deps?.joinGitOps ?? realJoinGitOps;

  const conflictRegistryPath = deps?.conflictRegistryPath;
  const pendingUpdatesRegistryPath = deps?.pendingUpdatesRegistryPath;
  const pendingAdmissionsRegistryPath = deps?.pendingAdmissionsRegistryPath;
  const outboundUpdatesRegistryPath = deps?.outboundUpdatesRegistryPath;
  const lockStatusRegistryPath = deps?.lockStatusRegistryPath;
  const pendingPromptRequestsRegistryPath = deps?.pendingPromptRequestsRegistryPath;
  const pendingPatchReviewsRegistryPath = deps?.pendingPatchReviewsRegistryPath;

  const state: ServerState = {
    role: null,
    hostSession: null,
    peerSession: null,
    stopHostUpdateMirror: null,
    stopPeerDisconnectCleanup: null,
    stopPeerBroadcastSubscription: null,
    pendingUpdates: [],
    pendingAdmissions: new Map(),
    pendingAdmissionsWriter: null,
    pendingPromptRequestsWriter: null,
    pendingPatchReviewsWriter: null,
    peerPromptRequests: new Map(),
    activeEditsTracker: null,
    pendingUpdatesWriter: null,
    outboundUpdatesReader: null,
    lockStatusWriter: null,
    observedGovernanceConfig: DEFAULT_GOVERNANCE_CONFIG,
    governanceAlert: null,
  };

  const server = new McpServer({ name: "hoop", version: "0.1.0" });

  function listPendingAdmissions() {
    return Array.from(state.pendingAdmissions.values()).map(
      ({ email, peerId, requestedAt }) => ({ email, peerId, requestedAt }),
    );
  }

  function syncPendingAdmissions(): void {
    state.pendingAdmissionsWriter?.sync(listPendingAdmissions());
  }

  function shouldQueuePendingUpdate(update: StateUpdate): boolean {
    return update.type !== "lock-acquire" && update.type !== "lock-release";
  }

  function getCurrentLockStatus() {
    if (state.role === "host" && state.hostSession) {
      return state.hostSession.getLockStatus();
    }
    if (state.role === "peer" && state.peerSession) {
      return state.peerSession.getLockStatus();
    }
    return createFreeHoopLock();
  }

  function flushLockStatus(): void {
    state.lockStatusWriter?.update(getCurrentLockStatus());
  }

  function revalidateGovernanceThreshold(): void {
    if (!state.hostSession) return;
    const config = state.observedGovernanceConfig;
    if (config.mode !== "zero-trust" || typeof config.threshold !== "number") return;

    const partySize = 1 + state.hostSession.broadcastHub.getSubscriberCount();
    if (config.threshold <= partySize) return;

    const newConfig: GovernanceConfig = { mode: "zero-trust", threshold: "consensus" };
    state.governanceAlert = partySize === 2
      ? `Peer disconnected. Threshold ${config.threshold} exceeds party size ${partySize}. Falling back to consensus.`
      : `Peer disconnected. Threshold ${config.threshold} exceeds party size ${partySize}. Falling back to consensus. You may set a new threshold up to ${partySize}.`;

    const configUpdate: MetadataUpdate = {
      type: "metadata-update",
      peerId: state.hostSession.peerId,
      key: GOVERNANCE_CONFIG_KEY,
      value: newConfig,
      timestamp: Date.now(),
    };
    state.hostSession.publishUpdate(configUpdate);
    state.observedGovernanceConfig = newConfig;
  }

  function mirrorObservedUpdate(update: StateUpdate, selfPeerId: string): void {
    // Guard against post-shutdown deliveries: handlers registered during
    // join/create may fire one more time after gracefulShutdown clears
    // state.role. Mutating activeEditsTracker / pendingUpdatesWriter on
    // those late deliveries would corrupt the next session's state.
    if (state.role === null) return;

    if (update.peerId !== selfPeerId && shouldQueuePendingUpdate(update)) {
      state.pendingUpdates.push(update);
    }
    if (update.type === "metadata-update" && update.key === GOVERNANCE_CONFIG_KEY && isGovernanceConfig(update.value)) {
      state.observedGovernanceConfig = update.value;
    }
    state.activeEditsTracker?.handleUpdate(update);
    state.pendingUpdatesWriter?.handleUpdate(update);
  }

  function syncPromptRequests(): void {
    if (!state.hostSession) return;
    const entries = state.hostSession.promptRequestQueue.listActive().map((e) => ({
      id: e.request.id,
      prompt: e.request.prompt,
      model: e.request.model,
      requestedBy: e.request.requestedBy,
      status: e.status,
      requestedAt: e.request.timestamp,
    }));
    state.pendingPromptRequestsWriter?.sync(entries);
  }

  function syncPatchReviews(): void {
    if (!state.hostSession) return;
    const pending = state.hostSession.patchReviewQueue.listPending();
    const entries = pending.map((r) => ({
      reviewId: r.reviewId,
      peerId: r.peerId,
      status: r.status,
      createdAt: r.createdAt,
      files: r.entries.map((e) => ({
        filePath: e.filePath,
        patchPreview: e.patch.split("\n").slice(0, 20).join("\n"),
      })),
    }));
    state.pendingPatchReviewsWriter?.sync(entries);
  }

  // ── Helpers: resolve session settings via elicit form ─────────────
  //
  // Skills (/hoop:new, /hoop:settings) call the underlying tools argless
  // so the MCP server owns the UX entirely — it elicits a form via
  // server.elicitInput rather than relying on the model to interpret a
  // numbered menu in the skill markdown. Tests and headless environments
  // (HOOP_ADMISSION_MODE=tool, or clients without elicit capability)
  // bypass elicitation: callers either pass the args directly or accept
  // the defaults.

  async function elicitZeroTrustThreshold(): Promise<ZeroTrustThreshold> {
    const form = await server.server.elicitInput({
      message: "Zero-trust approval threshold",
      requestedSchema: {
        type: "object",
        properties: {
          threshold: {
            type: "string",
            enum: ["consensus", "majority", "other"],
            description: [
              "Approval threshold required to apply changes.",
              "  • consensus — 100% of connected peers must approve",
              "  • majority  — more than 50% of connected peers must approve",
              "  • other     — exact peer count (set customCount below)",
            ].join("\n"),
          },
          customCount: {
            type: "integer",
            minimum: 1,
            description: "Used only when threshold = other. The exact number of peers required to approve.",
          },
        },
        required: ["threshold"],
      },
    });
    if (form.action !== "accept" || !form.content) {
      throw new Error("Threshold selection cancelled");
    }
    const choice = form.content as { threshold: string; customCount?: number };
    if (choice.threshold === "other") {
      if (typeof choice.customCount !== "number" || !isZeroTrustThreshold(choice.customCount)) {
        throw new Error("'Other' threshold requires a positive integer count");
      }
      return choice.customCount;
    }
    return choice.threshold as "consensus" | "majority";
  }

  async function resolveGovernance(opts: {
    mode?: GovernanceMode;
    threshold?: ZeroTrustThreshold;
  }): Promise<GovernanceConfig> {
    // Tool mode (tests, headless docker E2E): args win, fall back to defaults.
    // Elicit mode (interactive REPL): the form fires unconditionally — args
    // from the model are ignored. We can't trust the model to "remember to
    // call argless"; the harness must own the form regardless.
    if ((process.env.HOOP_ADMISSION_MODE ?? "elicit") === "tool") {
      // Reject inconsistent inputs explicitly rather than silently dropping
      // them. Caller passing { mode: "yolo", threshold: "majority" } is a
      // contract bug, not something to paper over.
      if (opts.mode && opts.mode !== "zero-trust" && opts.threshold !== undefined) {
        throw new Error("Threshold is only valid for zero-trust mode.");
      }
      if (opts.mode === undefined && opts.threshold !== undefined) {
        throw new Error("Threshold cannot be set without a mode.");
      }
      if (opts.mode) {
        return opts.mode === "zero-trust"
          ? { mode: "zero-trust", threshold: opts.threshold ?? "majority" }
          : { mode: opts.mode };
      }
      return { mode: "captain" };
    }

    const form = await server.server.elicitInput({
      message: "Update session governance",
      requestedSchema: {
        type: "object",
        properties: {
          governanceMode: {
            type: "string",
            enum: ["captain", "zero-trust", "yolo"],
            description: [
              "How changes are approved during this session.",
              "  • captain    — the host approves or rejects every change",
              "  • zero-trust — a configurable number of peers must approve",
              "  • yolo       — no approval gate, every change auto-applies",
            ].join("\n"),
          },
        },
        required: ["governanceMode"],
      },
    });
    if (form.action !== "accept" || !form.content) {
      throw new Error("Settings update cancelled");
    }
    const { governanceMode } = form.content as { governanceMode: GovernanceMode };
    if (governanceMode !== "zero-trust") {
      return { mode: governanceMode };
    }
    const threshold = await elicitZeroTrustThreshold();
    return { mode: "zero-trust", threshold };
  }

  async function resolveSessionSettings(opts: {
    executionTarget?: ExecutionTarget;
    governanceMode?: GovernanceMode;
    threshold?: ZeroTrustThreshold;
  }): Promise<{ executionTarget: ExecutionTarget; governance: GovernanceConfig }> {
    // Tool mode (tests, headless docker E2E): args win, fall back to defaults.
    // Elicit mode (interactive REPL): the form fires unconditionally — args
    // from the model are ignored. We can't trust the model to "remember to
    // call argless"; the harness must own the form regardless.
    if ((process.env.HOOP_ADMISSION_MODE ?? "elicit") === "tool") {
      const argMode = opts.governanceMode;
      const argThreshold = opts.threshold;
      return {
        executionTarget: opts.executionTarget ?? "host-only",
        governance: argMode === "zero-trust"
          ? { mode: "zero-trust", threshold: argThreshold ?? "majority" }
          : { mode: argMode ?? "captain" },
      };
    }

    const form1 = await server.server.elicitInput({
      message: "Configure your Hoop session",
      requestedSchema: {
        type: "object",
        properties: {
          executionTarget: {
            type: "string",
            enum: ["host-only", "proponent-side"],
            description: [
              "Where agent tool calls actually execute.",
              "  • host-only      — only the host machine runs changes",
              "  • proponent-side — each peer's host agent runs its own changes",
            ].join("\n"),
          },
          governanceMode: {
            type: "string",
            enum: ["captain", "zero-trust", "yolo"],
            description: [
              "How changes are approved during this session.",
              "  • captain    — the host approves or rejects every change",
              "  • zero-trust — a configurable number of peers must approve",
              "  • yolo       — no approval gate, every change auto-applies",
            ].join("\n"),
          },
        },
        required: ["executionTarget", "governanceMode"],
      },
    });

    if (form1.action !== "accept" || !form1.content) {
      throw new Error("Session setup cancelled");
    }
    const { executionTarget: pickedTarget, governanceMode: pickedMode } =
      form1.content as { executionTarget: ExecutionTarget; governanceMode: GovernanceMode };

    if (pickedMode !== "zero-trust") {
      return {
        executionTarget: pickedTarget,
        governance: { mode: pickedMode },
      };
    }

    const resolvedThreshold = await elicitZeroTrustThreshold();
    return {
      executionTarget: pickedTarget,
      governance: { mode: "zero-trust", threshold: resolvedThreshold },
    };
  }

  // ── 1. hoop_create_session ──────────────────────────────────────

  server.registerTool(
    "hoop_create_session",
    {
      description:
        "Start a P2P node, create a git worktree, and begin hosting a collaborative session. Returns the session code and listen addresses for peers to connect. INTERACTIVE: when called with only `password` (or argless), the server elicits executionTarget + governanceMode (+ threshold if zero-trust) via a form — this is the expected path for the /hoop:new skill. The other fields are reserved for non-interactive callers (programmatic tests).",
      inputSchema: z.object({
        password: z.string().optional(),
        executionTarget: z.enum(["host-only", "proponent-side"]).optional()
          .describe("[Programmatic only] Leave undefined to elicit via the server form. Skill callers must NOT set this — doing so bypasses the interactive form and silently uses the supplied value."),
        governanceMode: z.enum(GOVERNANCE_MODES).optional()
          .describe("[Programmatic only] Leave undefined to elicit via the server form. Skill callers must NOT set this."),
        threshold: z.union([
          z.literal("majority"),
          z.literal("consensus"),
          z.number().refine(isZeroTrustThreshold, "Must be a positive safe integer"),
        ]).optional()
          .describe("[Programmatic only] Zero-trust approval threshold. Leave undefined to elicit via the server form."),
        autoExecutePrompts: z.boolean().optional()
          .describe("[Programmatic only] Auto-execute peer prompt requests without confirmation. Leave undefined unless explicitly required."),
      }),
    },
    async ({ password, executionTarget, governanceMode, threshold, autoExecutePrompts }) => {
      if (state.role !== null) {
        return errorResult("Session already active. Leave current session first.");
      }

      let resolved: Awaited<ReturnType<typeof resolveSessionSettings>>;
      try {
        resolved = await resolveSessionSettings({ executionTarget, governanceMode, threshold });
      } catch (e) {
        return errorResult(
          e instanceof Error ? e.message : String(e),
        );
      }
      const resolvedTarget = resolved.executionTarget;
      const resolvedGovernance = resolved.governance;

      try {
        // Initialize before createSession resolves so admission requests that
        // arrive during startup are mirrored to disk immediately for hooks.
        state.pendingAdmissionsWriter = new PendingAdmissionsWriter(
          pendingAdmissionsRegistryPath,
        );
        syncPendingAdmissions();

        state.pendingPromptRequestsWriter = new PendingPromptRequestsWriter(
          pendingPromptRequestsRegistryPath,
        );
        state.pendingPatchReviewsWriter = new PendingPatchReviewsWriter(
          pendingPatchReviewsRegistryPath,
        );

        const result = await createSession({
          password,
          executionTarget: resolvedTarget,
          autoExecutePrompts,
          gitOps,
          isCaptainMode: () => state.observedGovernanceConfig.mode === "captain",
          onAdmissionRequest: async (email, peerId) => {
            // Default: ask the operator via MCP elicitation (server→client
            // JSON-RPC).  Claude Code surfaces this as an Ask UI prompt in
            // interactive REPL mode — even when claude is idle at end_turn,
            // the prompt fires reactively the moment the libp2p admission
            // handler invokes this callback.  If elicitation isn't supported
            // (older clients, headless --print, or the client throws because
            // the form capability isn't advertised) we fall back to the
            // tool-based path: queue a pending admission that
            // hoop_admit_peer / hoop_deny_peer / hoop_check_admissions can
            // drive.  The fallback also kicks in when the env var
            // HOOP_ADMISSION_MODE is set to "tool" — used by the docker E2E
            // suite which runs --print and auto-cancels elicitations.
            const mode = process.env.HOOP_ADMISSION_MODE ?? "elicit";

            if (mode === "elicit") {
              try {
                const result = await server.server.elicitInput({
                  message: [
                    "A peer wants to join this Hoop session.",
                    "",
                    `  peerId (cryptographic, verified): ${peerId}`,
                    `  email  (peer-supplied, NOT verified): ${email}`,
                    "",
                    "Admit?",
                  ].join("\n"),
                  requestedSchema: {
                    type: "object",
                    properties: {
                      admit: {
                        type: "boolean",
                        description: "Admit this peer to the session",
                      },
                    },
                    required: ["admit"],
                  },
                });
                if (result.action === "accept") {
                  return result.content?.admit === true;
                }
                // decline / cancel — treat as deny.  No fallback: the operator
                // explicitly answered (or explicitly closed the prompt).
                return false;
              } catch (err) {
                const errObj = err as { code?: number; message?: string };
                const methodNotFound = errObj?.code === -32601;
                const capabilityMissing = typeof errObj?.message === "string"
                  && /does not support .* elicitation/i.test(errObj.message);
                if (!methodNotFound && !capabilityMissing) {
                  console.error("[hoop] unexpected elicitInput failure, falling back to tool flow:", err);
                }
                // fall through to tool-based path
              }
            }

            // Tool-based: queue the admission and resolve when hoop_admit_peer
            // (or hoop_deny_peer) is called.
            return new Promise<boolean>((resolve) => {
              state.pendingAdmissions.set(peerId, {
                email,
                peerId,
                resolve,
                requestedAt: Date.now(),
              });
              syncPendingAdmissions();
            });
          },
          onPromptRequest: () => syncPromptRequests(),
          onLockChange: () => flushLockStatus(),
          onPeerDisconnect: (peerId) => {
            state.activeEditsTracker?.removePeer(peerId);
            revalidateGovernanceThreshold();
          },
        });

        state.hostSession = result;
        state.role = "host";

        // Apply the elicited governance config locally. Broadcast the
        // metadata update only when the resolved config differs from the
        // default — late-joining peers fall back to DEFAULT_GOVERNANCE_CONFIG
        // when no metadata is present, so unconditional broadcasting would
        // bump seqNo for every default session and break consumers that
        // assume the first user-driven publish is seqNo=1.
        state.observedGovernanceConfig = resolvedGovernance;
        // Structural equality against DEFAULT_GOVERNANCE_CONFIG. The previous
        // form (`mode === DEFAULT.mode && mode !== "zero-trust"`) coincidentally
        // worked because today's default is "captain" (non-zero-trust); if the
        // default ever changes to a zero-trust shape, the threshold must be
        // compared too. JSON.stringify is enough because GovernanceConfig is a
        // flat tagged union with primitive fields.
        const isDefaultGovernance =
          JSON.stringify(resolvedGovernance) === JSON.stringify(DEFAULT_GOVERNANCE_CONFIG);
        if (!isDefaultGovernance) {
          const initialGovernanceUpdate: MetadataUpdate = {
            type: "metadata-update",
            peerId: result.peerId,
            key: GOVERNANCE_CONFIG_KEY,
            value: resolvedGovernance,
            timestamp: Date.now(),
          };
          result.publishUpdate(initialGovernanceUpdate);
        }

        writeSessionStatus({
          role: "host",
          sessionCode: result.sessionCode,
          branchName: result.branchName,
          executionTarget: result.executionTarget,
          worktreePath: result.worktreePath,
          passwordProtected: result.passwordProtected,
          listenAddresses: result.listenAddresses,
        }, deps?.sessionStatusPath);
        state.activeEditsTracker = new ActiveEditsTracker(
          result.peerId,
          conflictRegistryPath,
        );
        state.pendingUpdatesWriter = new PendingUpdatesWriter(
          result.peerId,
          pendingUpdatesRegistryPath,
        );
        state.lockStatusWriter = new LockStatusWriter(
          result.peerId,
          lockStatusRegistryPath,
        );
        flushLockStatus();

        // Mirror every host-side publication through one observer path so MCP
        // sees peer updates without patching the accumulator implementation.
        state.stopHostUpdateMirror = result.onPublishedUpdate(({ update }) => {
          mirrorObservedUpdate(update, result.peerId);
        });

        // Watch for outbound updates from PostToolUse hook
        state.outboundUpdatesReader = new OutboundUpdatesReader((outbound) => {
          const update: StateUpdate = {
            type: "file-change",
            peerId: result.peerId,
            filePath: outbound.filePath,
            patch: outbound.patch,
            baseHash: outbound.baseHash,
            resultHash: outbound.resultHash,
            timestamp: outbound.timestamp,
          };
          result.publishUpdate(update);
        }, outboundUpdatesRegistryPath);
        state.outboundUpdatesReader.start();

        return jsonResult({
          sessionCode: result.sessionCode,
          hostId: result.hostId,
          peerId: result.peerId,
          executionTarget: result.executionTarget,
          governance: resolvedGovernance,
          autoExecutePrompts: result.autoExecutePrompts,
          passwordProtected: result.passwordProtected,
          listenAddresses: result.listenAddresses,
          branchName: result.branchName,
          worktreePath: result.worktreePath,
        });
      } catch (e) {
        state.pendingAdmissions.clear();
        state.pendingAdmissionsWriter?.clear();
        state.pendingAdmissionsWriter = null;
        state.pendingPromptRequestsWriter?.clear();
        state.pendingPromptRequestsWriter = null;
        return errorResult(
          `Failed to create session: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  // ── 2. hoop_join_session ────────────────────────────────────────

  server.registerTool(
    "hoop_join_session",
    {
      description:
        "Connect to an existing session hosted by another peer. Authenticates, requests admission, and syncs state.",
      inputSchema: z.object({
        sessionCode: z.string(),
        hostAddress: z.string(),
        password: z.string().optional(),
        email: z.string().optional(),
      }),
    },
    async ({ sessionCode, hostAddress, password, email }) => {
      if (state.role !== null) {
        return errorResult("Session already active. Leave current session first.");
      }

      try {
        const result = await joinSession({
          sessionCode,
          hostAddress,
          password,
          email,
          onLockChange: () => flushLockStatus(),
          gitOps: joinGitOps,
        });

        state.peerSession = result;
        state.role = "peer";

        // Hydrate governance config from the host's accumulated state snapshot
        const syncedConfig = result.accumulatedState?.metadata[GOVERNANCE_CONFIG_KEY]?.value;
        if (isGovernanceConfig(syncedConfig)) {
          state.observedGovernanceConfig = syncedConfig;
        }
        if (result.branchName) {
          writeSessionStatus({
            role: "peer",
            sessionCode: result.sessionCode,
            branchName: result.branchName,
            hostPeerId: result.hostPeerId,
            executionTarget: result.executionTarget,
          }, deps?.sessionStatusPath);
        }
        state.activeEditsTracker = new ActiveEditsTracker(
          result.localPeerId,
          conflictRegistryPath,
        );
        state.pendingUpdatesWriter = new PendingUpdatesWriter(
          result.localPeerId,
          pendingUpdatesRegistryPath,
        );
        state.lockStatusWriter = new LockStatusWriter(
          result.localPeerId,
          lockStatusRegistryPath,
        );
        flushLockStatus();

        // Queue incoming broadcasts for hoop_check_updates
        state.stopPeerBroadcastSubscription = result.onBroadcast((update) => {
          mirrorObservedUpdate(update, result.localPeerId);
        });

        const peerDisconnectHandler = (evt: CustomEvent) => {
          state.activeEditsTracker?.removePeer(evt.detail.toString());
        };
        result.node.addEventListener("peer:disconnect", peerDisconnectHandler);
        state.stopPeerDisconnectCleanup = () => {
          result.node.removeEventListener("peer:disconnect", peerDisconnectHandler);
        };

        // Watch for outbound updates from PostToolUse hook
        state.outboundUpdatesReader = new OutboundUpdatesReader((outbound) => {
          const update: StateUpdate = {
            type: "file-change",
            peerId: result.localPeerId,
            filePath: outbound.filePath,
            patch: outbound.patch,
            baseHash: outbound.baseHash,
            resultHash: outbound.resultHash,
            timestamp: outbound.timestamp,
          };
          result.sendUpdate(update).catch(() => {
            // Best-effort: fire-and-forget
          });
        }, outboundUpdatesRegistryPath);
        state.outboundUpdatesReader.start();

        return jsonResult({
          sessionCode: result.sessionCode,
          localPeerId: result.localPeerId,
          hostPeerId: result.hostPeerId,
          authenticated: result.authenticated,
          admitted: result.admitted,
          branchName: result.branchName,
        });
      } catch (e) {
        return errorResult(
          `Failed to join session: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  // ── 3. hoop_check_updates ──────────────────────────────────────

  server.registerTool(
    "hoop_check_updates",
    {
      description:
        "Return and drain pending incoming changes from peers. Called by the PreToolUse hook to inject peer updates.",
      inputSchema: z.object({}),
    },
    async () => {
      if (state.role === null) {
        return errorResult("No active session.");
      }
      const updates = state.pendingUpdates.splice(0);
      return jsonResult({ count: updates.length, updates });
    },
  );

  // ── 4. hoop_check_conflicts ──────────────────────────────────

  server.registerTool(
    "hoop_check_conflicts",
    {
      description:
        "Check if a file is being actively edited by a peer. Returns conflict info if another peer has a dirty buffer or recent file change on the path.",
      inputSchema: z.object({
        filePath: z.string().describe("The file path to check for conflicts"),
      }),
    },
    async ({ filePath }) => {
      if (state.role === null || !state.activeEditsTracker) {
        return jsonResult({ hasConflict: false, conflict: null });
      }
      return jsonResult(state.activeEditsTracker.checkConflict(filePath));
    },
  );

  // ── 5. hoop_check_admissions ───────────────────────────────────

  server.registerTool(
    "hoop_check_admissions",
    {
      description:
        "Return pending admission requests from peers waiting to join. Host only. Called by the UserPromptSubmit hook.",
      inputSchema: z.object({}),
    },
    async () => {
      if (state.role !== "host") {
        return errorResult("Only the host can check admissions.");
      }
      const requests = listPendingAdmissions();
      syncPendingAdmissions();
      return jsonResult({ count: requests.length, requests });
    },
  );

  // ── 6. hoop_admit_peer ─────────────────────────────────────────

  server.registerTool(
    "hoop_admit_peer",
    {
      description: "Approve a pending admission request. Host only.",
      inputSchema: z.object({ peerId: z.string() }),
    },
    async ({ peerId }) => {
      if (state.role !== "host") {
        return errorResult("Only the host can admit peers.");
      }
      const pending = state.pendingAdmissions.get(peerId);
      if (!pending) return errorResult(`No pending admission for peer: ${peerId}`);

      pending.resolve(true);
      state.pendingAdmissions.delete(peerId);
      syncPendingAdmissions();
      return jsonResult({ admitted: true, peerId, email: pending.email });
    },
  );

  // ── 7. hoop_deny_peer ──────────────────────────────────────────

  server.registerTool(
    "hoop_deny_peer",
    {
      description: "Deny a pending admission request. Host only.",
      inputSchema: z.object({ peerId: z.string() }),
    },
    async ({ peerId }) => {
      if (state.role !== "host") {
        return errorResult("Only the host can deny peers.");
      }
      const pending = state.pendingAdmissions.get(peerId);
      if (!pending) return errorResult(`No pending admission for peer: ${peerId}`);

      pending.resolve(false);
      state.pendingAdmissions.delete(peerId);
      syncPendingAdmissions();
      return jsonResult({ denied: true, peerId, email: pending.email });
    },
  );

  // ── 8. hoop_send_update ────────────────────────────────────────

  server.registerTool(
    "hoop_send_update",
    {
      description:
        "Send a state update (file change, cursor position, buffer state, or metadata) to peers.",
      inputSchema: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("cursor-update"),
          filePath: z.string(),
          line: z.number(),
          column: z.number(),
        }),
        z.object({
          type: z.literal("buffer-update"),
          filePath: z.string(),
          contentHash: z.string(),
          version: z.number(),
          dirty: z.boolean(),
        }),
        z.object({
          type: z.literal("metadata-update"),
          key: z.string(),
          value: z.unknown(),
        }),
        z.object({
          type: z.literal("file-change"),
          filePath: z.string(),
          patch: z.string(),
          baseHash: z.string(),
          resultHash: z.string(),
        }),
      ]),
    },
    async (input) => {
      if (state.role === null) {
        return errorResult("No active session.");
      }

      try {
        if (state.role === "host" && state.hostSession) {
          const update = {
            ...input,
            peerId: state.hostSession.peerId,
            timestamp: Date.now(),
          } as StateUpdate;
          const seqNo = state.hostSession.publishUpdate(update);
          return jsonResult({ accepted: true, seqNo });
        }

        if (state.role === "peer" && state.peerSession) {
          const update = {
            ...input,
            peerId: state.peerSession.localPeerId,
            timestamp: Date.now(),
          } as NonLockStateUpdate;
          const response = await state.peerSession.sendUpdate(update);
          return jsonResult({
            accepted: response.accepted,
            ...(response.seqNo !== undefined ? { seqNo: response.seqNo } : {}),
            ...(response.reason !== undefined ? { reason: response.reason } : {}),
          });
        }

        return errorResult("Unexpected state.");
      } catch (e) {
        return errorResult(
          `Failed to send update: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  // ── 9. hoop_acquire_lock ───────────────────────────────────────

  server.registerTool(
    "hoop_acquire_lock",
    {
      description:
        "Attempt to acquire the Hot Seat lock. Only one peer can hold it at a time.",
      inputSchema: z.object({}),
    },
    async () => {
      if (state.role === null) {
        return errorResult("No active session.");
      }

      if (state.role === "host" && state.hostSession) {
        const result = state.hostSession.acquireLock(state.hostSession.peerId);
        return jsonResult({ acquired: result.acquired, holder: result.holder });
      }

      if (state.role === "peer" && state.peerSession) {
        const result = await state.peerSession.acquireLock();
        return jsonResult(result);
      }

      return errorResult("Unexpected state.");
    },
  );

  // ── 10. hoop_release_lock ──────────────────────────────────────

  server.registerTool(
    "hoop_release_lock",
    {
      description: "Release the Hot Seat lock if held by the current peer.",
      inputSchema: z.object({}),
    },
    async () => {
      if (state.role === null) {
        return errorResult("No active session.");
      }

      if (state.role === "host" && state.hostSession) {
        const result = state.hostSession.releaseLock(state.hostSession.peerId);
        return jsonResult({ released: result.released, holder: result.holder });
      }

      if (state.role === "peer" && state.peerSession) {
        const result = await state.peerSession.releaseLock();
        return jsonResult(result);
      }

      return errorResult("Unexpected state.");
    },
  );

  // ── 11. hoop_lock_status ───────────────────────────────────────

  server.registerTool(
    "hoop_lock_status",
    {
      description: "Return the current Hot Seat lock state without mutating it.",
      inputSchema: z.object({}),
    },
    async () => jsonResult(getCurrentLockStatus()),
  );

  // ── 12. hoop_force_unlock ──────────────────────────────────────

  server.registerTool(
    "hoop_force_unlock",
    {
      description:
        "Force-release the Hot Seat lock regardless of who holds it. Host only. Use when a peer agent hangs or crashes.",
      inputSchema: z.object({}),
    },
    async () => {
      if (state.role === null) {
        return errorResult("No active session.");
      }
      if (state.role !== "host") {
        return errorResult("Only the host can force-unlock.");
      }
      if (!state.hostSession) {
        return errorResult("Internal error: host session missing.");
      }

      const result = state.hostSession.forceReleaseLock();
      return jsonResult({ released: result.released, holder: result.holder });
    },
  );

  // ── 13. hoop_get_status ────────────────────────────────────────

  server.registerTool(
    "hoop_get_status",
    {
      description:
        "Get current session status including role, connected peers, branch name, and execution target.",
      inputSchema: z.object({}),
    },
    async () => {
      if (state.role === null) {
        return jsonResult({ active: false });
      }

      if (state.role === "host" && state.hostSession) {
        const s = state.hostSession;
        return jsonResult({
          active: true,
          role: "host",
          sessionCode: s.sessionCode,
          hostId: s.hostId,
          peerId: s.peerId,
          executionTarget: s.executionTarget,
          governance: state.observedGovernanceConfig,
          autoExecutePrompts: s.autoExecutePrompts,
          passwordProtected: s.passwordProtected,
          connectedPeers: s.broadcastHub.getSubscribers(),
          peerCount: s.broadcastHub.getSubscriberCount(),
          branchName: s.branchName,
          worktreePath: s.worktreePath,
          pendingAdmissions: state.pendingAdmissions.size,
          activePromptRequests: s.promptRequestQueue.listActive().length,
          pendingUpdates: state.pendingUpdates.length,
          lock: s.getLockStatus(),
          ...(state.governanceAlert ? { governanceAlert: state.governanceAlert } : {}),
        });
      }

      if (state.role === "peer" && state.peerSession) {
        const s = state.peerSession;
        return jsonResult({
          active: true,
          role: "peer",
          sessionCode: s.sessionCode,
          localPeerId: s.localPeerId,
          hostPeerId: s.hostPeerId,
          authenticated: s.authenticated,
          admitted: s.admitted,
          branchName: s.branchName,
          executionTarget: s.executionTarget,
          governance: state.observedGovernanceConfig,
          lastSeqNo: s.getLastSeqNo(),
          pendingUpdates: state.pendingUpdates.length,
          lock: s.getLockStatus(),
        });
      }

      return errorResult("Unexpected state.");
    },
  );

  // ── 14. hoop_request_host_execution ─────────────────────────────

  server.registerTool(
    "hoop_request_host_execution",
    {
      description:
        "Send a prompt to the host for execution. Peer only. Returns a request ID and initial status. The host must approve the request before execution begins (unless autoExecutePrompts is enabled).",
      inputSchema: z.object({
        prompt: z.string().describe("The task for the host to execute"),
        model: z.string().optional().describe("Optional model override: opus, sonnet, or haiku"),
      }),
    },
    async ({ prompt, model }) => {
      if (state.role !== "peer" || !state.peerSession) {
        return errorResult("Only peers can request host execution.");
      }

      try {
        const message: PromptRequestMessage = {
          type: "prompt-request",
          prompt,
          model,
          timestamp: Date.now(),
        };

        const hostAddress = state.peerSession.hostAddress;
        const stream = await state.peerSession.node.openStream(hostAddress, PROMPT_PROTOCOL);
        await writeHalf(stream, message);
        const response = await readFromStream<PromptResponse>(stream);

        const hostId = response.id;
        state.peerPromptRequests.set(hostId, { id: hostId, status: response.status });
        return jsonResult({ requestId: hostId, status: response.status });
      } catch (e) {
        return errorResult(
          `Failed to send prompt to host: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  // ── 15. hoop_poll_execution_result ────────────────────────────────

  server.registerTool(
    "hoop_poll_execution_result",
    {
      description:
        "Poll for the status of a prompt execution request. Peer only. Returns the current status: pending-approval, approved, executing, completed, failed, or denied.",
      inputSchema: z.object({
        requestId: z.string().describe("The request ID returned by hoop_request_host_execution"),
      }),
    },
    async ({ requestId }) => {
      if (state.role !== "peer" || !state.peerSession) {
        return errorResult("Only peers can poll execution results.");
      }

      const tracked = state.peerPromptRequests.get(requestId);
      if (!tracked) {
        return errorResult(`No prompt request found with ID: ${requestId}`);
      }

      try {
        const query: PromptStatusQuery = { type: "status-query", id: requestId };
        const hostAddress = state.peerSession.hostAddress;
        const stream = await state.peerSession.node.openStream(hostAddress, PROMPT_PROTOCOL);
        await writeToStream(stream, query);
        const response = await readFromStream<PromptResponse>(stream);

        tracked.status = response.status;
        return jsonResult({
          requestId,
          status: response.status,
          ...(response.error ? { error: response.error } : {}),
          ...(response.reason ? { reason: response.reason } : {}),
        });
      } catch (e) {
        return errorResult(
          `Failed to poll host: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  // ── 16. hoop_check_prompt_requests ────────────────────────────────

  server.registerTool(
    "hoop_check_prompt_requests",
    {
      description:
        "List pending prompt requests from peers. Host only. Returns requests awaiting approval or execution.",
      inputSchema: z.object({}),
    },
    async () => {
      if (state.role !== "host" || !state.hostSession) {
        return errorResult("Only the host can check prompt requests.");
      }

      const pending = state.hostSession.promptRequestQueue.listActive();
      const requests = pending.map((e) => ({
        id: e.request.id,
        prompt: e.request.prompt,
        model: e.request.model,
        requestedBy: e.request.requestedBy,
        status: e.status,
        requestedAt: e.request.timestamp,
      }));
      syncPromptRequests();
      return jsonResult({ count: requests.length, requests });
    },
  );

  // ── 17. hoop_approve_prompt_request ───────────────────────────────

  server.registerTool(
    "hoop_approve_prompt_request",
    {
      description:
        "Approve a pending prompt request for execution. Host only. Transitions the request from pending-approval to approved.",
      inputSchema: z.object({
        requestId: z.string().describe("The prompt request ID to approve"),
      }),
    },
    async ({ requestId }) => {
      if (state.role !== "host" || !state.hostSession) {
        return errorResult("Only the host can approve prompt requests.");
      }

      const response = state.hostSession.promptRequestQueue.approve(requestId);
      if (!response) {
        return errorResult(`No pending-approval request found with ID: ${requestId}`);
      }
      syncPromptRequests();
      return jsonResult(response);
    },
  );

  // ── 18. hoop_deny_prompt_request ──────────────────────────────────

  server.registerTool(
    "hoop_deny_prompt_request",
    {
      description:
        "Deny a pending prompt request. Host only. The proponent will be notified of the denial.",
      inputSchema: z.object({
        requestId: z.string().describe("The prompt request ID to deny"),
        reason: z.string().optional().describe("Optional reason for denial"),
      }),
    },
    async ({ requestId, reason }) => {
      if (state.role !== "host" || !state.hostSession) {
        return errorResult("Only the host can deny prompt requests.");
      }

      const response = state.hostSession.promptRequestQueue.deny(requestId, reason);
      if (!response) {
        return errorResult(`No pending-approval request found with ID: ${requestId}`);
      }
      syncPromptRequests();
      return jsonResult(response);
    },
  );

  // ── 19. hoop_complete_prompt_request ──────────────────────────────

  server.registerTool(
    "hoop_complete_prompt_request",
    {
      description:
        "Mark an approved prompt request as completed or failed. Host only. Call this after the host has finished executing the prompt.",
      inputSchema: z.object({
        requestId: z.string().describe("The prompt request ID to complete"),
        error: z.string().optional().describe("Error message if execution failed"),
      }),
    },
    async ({ requestId, error }) => {
      if (state.role !== "host" || !state.hostSession) {
        return errorResult("Only the host can complete prompt requests.");
      }

      const response = state.hostSession.promptRequestQueue.complete(requestId, error);
      if (!response) {
        return errorResult(`No executing request found with ID: ${requestId}`);
      }
      syncPromptRequests();
      return jsonResult(response);
    },
  );

  // ── Patch review tools (captain mode) ─────────────────────────────

  server.registerTool(
    "hoop_check_patch_reviews",
    {
      description:
        "List pending patch review batches. Host only. Returns per-peer batches of file-change patches awaiting captain review.",
      inputSchema: z.object({}),
    },
    async () => {
      if (state.role !== "host" || !state.hostSession) {
        return errorResult("Only the host can check patch reviews.");
      }

      const pending = state.hostSession.patchReviewQueue.listPending();
      return jsonResult({
        reviews: pending.map((r) => ({
          reviewId: r.reviewId,
          peerId: r.peerId,
          status: r.status,
          createdAt: r.createdAt,
          files: r.entries.map((e) => ({
            filePath: e.filePath,
            patchPreview: e.patch.split("\n").slice(0, 20).join("\n"),
          })),
        })),
      });
    },
  );

  server.registerTool(
    "hoop_approve_patches",
    {
      description:
        "Approve all pending file-change patches from a peer. Host only. The held updates are accumulated and broadcast to all peers.",
      inputSchema: z.object({
        peerId: z.string().describe("The peer whose patches to approve"),
      }),
    },
    async ({ peerId }) => {
      if (state.role !== "host" || !state.hostSession) {
        return errorResult("Only the host can approve patches.");
      }

      const review = state.hostSession.patchReviewQueue.approve(peerId);
      if (!review) {
        return errorResult(`No pending patch review found for peer: ${peerId}`);
      }

      const seqNos: number[] = [];
      for (const entry of review.entries) {
        const seqNo = state.hostSession.publishUpdate(entry.update, peerId);
        seqNos.push(seqNo);
      }

      syncPatchReviews();
      return jsonResult({
        approved: true,
        reviewId: review.reviewId,
        peerId,
        fileCount: review.entries.length,
        seqNos,
      });
    },
  );

  server.registerTool(
    "hoop_reject_patches",
    {
      description:
        "Reject all pending file-change patches from a peer. Host only. The peer will be notified and should revert the changes.",
      inputSchema: z.object({
        peerId: z.string().describe("The peer whose patches to reject"),
        reason: z.string().optional().describe("Reason for rejection"),
      }),
    },
    async ({ peerId, reason }) => {
      if (state.role !== "host" || !state.hostSession) {
        return errorResult("Only the host can reject patches.");
      }

      const review = state.hostSession.patchReviewQueue.reject(peerId, reason);
      if (!review) {
        return errorResult(`No pending patch review found for peer: ${peerId}`);
      }

      syncPatchReviews();
      return jsonResult({
        rejected: true,
        reviewId: review.reviewId,
        peerId,
        fileCount: review.entries.length,
        reason,
      });
    },
  );

  server.registerTool(
    "hoop_poll_patch_status",
    {
      description:
        "Poll the status of a patch review by reviewId. Used by peers to check whether their patches were approved or rejected.",
      inputSchema: z.object({
        reviewId: z.string().describe("The review ID returned from hoop_send_update"),
      }),
    },
    async ({ reviewId }) => {
      if (state.role === null) {
        return errorResult("No active session.");
      }

      // Peers poll their own reviews; host can also poll
      const queue = state.role === "host"
        ? state.hostSession?.patchReviewQueue
        : undefined;

      // For peers, the review lives on the host side — we need a peer-side tracking mechanism.
      // For now, the peer sends the poll via the UPDATE_PROTOCOL to the host.
      // TODO: implement peer-side poll over protocol in a follow-up
      if (!queue) {
        return errorResult("Patch status polling is currently only available on the host side.");
      }

      const review = queue.get(reviewId);
      if (!review) {
        return errorResult(`No patch review found with ID: ${reviewId}`);
      }

      return jsonResult({
        reviewId: review.reviewId,
        peerId: review.peerId,
        status: review.status,
        reason: review.reason,
        fileCount: review.entries.length,
        files: review.entries.map((e) => e.filePath),
      });
    },
  );

  // ── hoop_leave_session ────────────────────────────────────────────

  function cleanupState(): void {
    state.outboundUpdatesReader?.stop();
    state.outboundUpdatesReader = null;
    state.activeEditsTracker?.clear();
    state.activeEditsTracker = null;
    state.pendingUpdatesWriter?.clear();
    state.pendingUpdatesWriter = null;
    state.lockStatusWriter?.clear();
    state.lockStatusWriter = null;
    state.pendingAdmissions.clear();
    state.pendingAdmissionsWriter?.clear();
    state.pendingAdmissionsWriter = null;
    state.pendingPromptRequestsWriter?.clear();
    state.pendingPromptRequestsWriter = null;
    state.pendingPatchReviewsWriter?.clear();
    state.pendingPatchReviewsWriter = null;
    state.peerPromptRequests.clear();
    state.stopHostUpdateMirror?.();
    state.stopHostUpdateMirror = null;
    state.stopPeerDisconnectCleanup?.();
    state.stopPeerDisconnectCleanup = null;
    state.stopPeerBroadcastSubscription?.();
    state.stopPeerBroadcastSubscription = null;
    // Intentionally do NOT clearSessionStatus here — signal-triggered shutdowns
    // (SIGTERM/SIGINT) should leave the status file so external tooling can
    // detect the zombie session.  Explicit hoop_leave_session clears it after
    // gracefulShutdown returns.
    state.role = null;
    state.hostSession = null;
    state.peerSession = null;
    state.pendingUpdates.length = 0;
    state.observedGovernanceConfig = DEFAULT_GOVERNANCE_CONFIG;
    state.governanceAlert = null;
  }

  async function gracefulShutdown(): Promise<{ left: boolean; previousRole: string | null; sessionCode: string | undefined }> {
    const previousRole = state.role;
    const sessionCode =
      state.role === "host"
        ? state.hostSession?.sessionCode
        : state.peerSession?.sessionCode;

    try {
      if (state.role === "host" && state.hostSession) {
        // Teardown order matters:
        // 1. Stop EXTERNAL inputs first (outbound-update reader watching the
        //    PostToolUse hook's file, host update mirror) so no new events
        //    flow into the publish path while the node is stopping.
        // 2. Gate auto-pushes BEFORE node.stop so the cascade of
        //    peer:disconnect events doesn't trigger N concurrent `git push`.
        // 3. Clear pending auth timeouts so they don't fire after node is gone.
        // 4. Drain admin queues, close broadcast hub, then node.stop.
        // 5. cleanupState() clears writers afterwards (idempotent).
        state.outboundUpdatesReader?.stop();
        state.stopHostUpdateMirror?.();

        state.hostSession.markShuttingDown();
        state.hostSession.clearAuthTimeouts();

        for (const pending of state.pendingAdmissions.values()) {
          pending.resolve(false);
        }
        state.hostSession.promptRequestQueue.clear();
        state.hostSession.patchReviewQueue.clear();
        state.hostSession.broadcastHub.close();
        await state.hostSession.node.stop();
      }

      if (state.role === "peer" && state.peerSession) {
        // Symmetric to host: stop external inputs and broadcast subscription
        // before stopping the libp2p node so in-flight broadcasts don't get
        // mirrored into a teardown-state writer.
        state.outboundUpdatesReader?.stop();
        state.stopPeerDisconnectCleanup?.();
        state.stopPeerDisconnectCleanup = null;
        state.stopPeerBroadcastSubscription?.();
        state.stopPeerBroadcastSubscription = null;
        state.peerSession.stopAckInterval();
        await state.peerSession.node.stop();
      }
    } finally {
      cleanupState();
    }

    return { left: true, previousRole, sessionCode };
  }

  // ── 21. hoop_set_settings ─────────────────────────────────────────

  server.registerTool(
    "hoop_set_settings",
    {
      description:
        "Update session settings on the active host session. Host only. INTERACTIVE: when called argless, the server elicits governanceMode (+ threshold if zero-trust) via a form — this is the expected path for the /hoop:settings skill. Skill callers must NOT pass `mode` or `threshold`; those fields are reserved for non-interactive programmatic callers.",
      inputSchema: z.object({
        mode: z.enum(GOVERNANCE_MODES).optional()
          .describe("[Programmatic only] Leave undefined to elicit via the server form. Skill callers must NOT set this — doing so bypasses the interactive form and silently uses the supplied value."),
        threshold: z.union([
          z.literal("majority"),
          z.literal("consensus"),
          z.number().refine(isZeroTrustThreshold, "Must be a positive safe integer"),
        ]).optional()
          .describe("[Programmatic only] Zero-trust approval threshold. Leave undefined to elicit via the server form."),
      }),
    },
    async ({ mode, threshold }) => {
      if (state.role !== "host") {
        return errorResult("Only the host can update session settings.");
      }
      if (!state.hostSession) {
        return errorResult("No active host session.");
      }

      // Always go through resolveGovernance — it gates on tool-mode vs
      // elicit-mode internally. Conditional dispatch on `mode === undefined`
      // would let a model in elicit-mode bypass the form by passing `mode`
      // directly, which is exactly the harness-owns-UX guarantee we built
      // resolveGovernance to enforce.
      try {
        const resolved = await resolveGovernance({ mode, threshold });
        mode = resolved.mode;
        threshold = resolved.mode === "zero-trust" ? resolved.threshold : undefined;
      } catch (e) {
        return errorResult(
          e instanceof Error ? e.message : String(e),
        );
      }

      if (mode !== "zero-trust" && threshold !== undefined) {
        return errorResult("Threshold is only valid for zero-trust mode.");
      }

      // Build the new atomic config
      let newConfig: GovernanceConfig;
      if (mode === "zero-trust") {
        const currentThreshold = state.observedGovernanceConfig.mode === "zero-trust"
          ? state.observedGovernanceConfig.threshold
          : "majority";
        const effectiveThreshold = threshold ?? currentThreshold;

        // Fallback: if integer threshold exceeds current party size, default to consensus
        if (typeof effectiveThreshold === "number") {
          const partySize = 1 + state.hostSession.broadcastHub.getSubscriberCount();
          if (effectiveThreshold > partySize) {
            newConfig = { mode: "zero-trust", threshold: "consensus" };
            const warning = partySize === 2
              ? `Threshold ${effectiveThreshold} exceeds party size ${partySize}. Falling back to consensus.`
              : `Threshold ${effectiveThreshold} exceeds party size ${partySize}. Falling back to consensus. You may set a new threshold up to ${partySize}.`;
            state.governanceAlert = warning;

            const configUpdate: MetadataUpdate = {
              type: "metadata-update",
              peerId: state.hostSession.peerId,
              key: GOVERNANCE_CONFIG_KEY,
              value: newConfig,
              timestamp: Date.now(),
            };
            const seqNo = state.hostSession.publishUpdate(configUpdate);
            state.observedGovernanceConfig = newConfig;

            return jsonResult({
              accepted: true,
              governance: newConfig,
              executionTarget: state.hostSession.executionTarget,
              seqNo,
              warning,
            });
          }
        }

        newConfig = { mode: "zero-trust", threshold: effectiveThreshold };
      } else {
        newConfig = { mode };
      }

      // Idempotency: skip if config is unchanged
      const current = state.observedGovernanceConfig;
      const unchanged = current.mode === newConfig.mode
        && (current.mode !== "zero-trust" || (newConfig.mode === "zero-trust"
          && current.threshold === newConfig.threshold));

      if (unchanged) {
        state.governanceAlert = null;
        return jsonResult({
          accepted: true,
          governance: newConfig,
          executionTarget: state.hostSession.executionTarget,
          seqNo: null,
          unchanged: true,
        });
      }

      // Single atomic broadcast
      const configUpdate: MetadataUpdate = {
        type: "metadata-update",
        peerId: state.hostSession.peerId,
        key: GOVERNANCE_CONFIG_KEY,
        value: newConfig,
        timestamp: Date.now(),
      };
      const seqNo = state.hostSession.publishUpdate(configUpdate);
      state.observedGovernanceConfig = newConfig;
      state.governanceAlert = null;

      return jsonResult({
        accepted: true,
        governance: newConfig,
        executionTarget: state.hostSession.executionTarget,
        seqNo,
      });
    },
  );

  /**
   * High-level "leave the active hoop session" path.
   *
   * Both the MCP tool (`hoop_leave_session`, model-driven) and the
   * harness signal handler (`SIGUSR2`, hook-driven, model-bypassed)
   * call this. The contract: tear down the libp2p node and writers,
   * then clear the on-disk session-status file so external tooling
   * (and the next `/hoop:new`) sees a clean slate. The MCP server
   * process itself stays alive — only the session is gone.
   */
  async function leaveSession(): Promise<{ left: boolean; previousRole: string | null; sessionCode: string | undefined }> {
    if (state.role === null) {
      return { left: false, previousRole: null, sessionCode: undefined };
    }
    const result = await gracefulShutdown();
    clearSessionStatus(deps?.sessionStatusPath);
    return result;
  }

  // ── 22. hoop_leave_session ──────────────────────────────────────

  server.registerTool(
    "hoop_leave_session",
    {
      description:
        "Disconnect from the current session, stop the P2P node, and clean up all state.",
      inputSchema: z.object({}),
    },
    async () => {
      if (state.role === null) {
        return errorResult("No active session.");
      }

      try {
        const result = await leaveSession();
        return jsonResult(result);
      } catch (e) {
        return errorResult(
          `Failed to leave session: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  return { server, state, gracefulShutdown, leaveSession, revalidateGovernanceThreshold };
}
