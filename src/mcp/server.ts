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
import type { StateUpdate, NonLockStateUpdate } from "../state/stateUpdate.js";
import { createFreeHoopLock } from "../state/hoopLock.js";
import { ActiveEditsTracker } from "../state/activeEditsTracker.js";
import { PendingUpdatesWriter } from "../state/pendingUpdatesWriter.js";
import { PendingAdmissionsWriter } from "../state/pendingAdmissionsWriter.js";
import { OutboundUpdatesReader } from "../state/outboundUpdatesReader.js";
import { LockStatusWriter } from "../state/lockStatusWriter.js";

// ── Types ───────────────────────────────────────────────────────────

interface PendingAdmission {
  email: string;
  peerId: string;
  resolve: (admitted: boolean) => void;
  requestedAt: number;
}

interface ServerState {
  role: "host" | "peer" | null;
  hostSession: CreateSessionResult | null;
  peerSession: JoinSessionResult | null;
  origAccumulate: ((update: StateUpdate) => void) | null;
  pendingUpdates: StateUpdate[];
  pendingAdmissions: Map<string, PendingAdmission>;
  pendingAdmissionsWriter: PendingAdmissionsWriter | null;
  activeEditsTracker: ActiveEditsTracker | null;
  pendingUpdatesWriter: PendingUpdatesWriter | null;
  outboundUpdatesReader: OutboundUpdatesReader | null;
  lockStatusWriter: LockStatusWriter | null;
}

export interface HoopMcpDeps {
  gitOps?: GitOps;
  joinGitOps?: JoinGitOps;
  conflictRegistryPath?: string;
  pendingUpdatesRegistryPath?: string;
  pendingAdmissionsRegistryPath?: string;
  outboundUpdatesRegistryPath?: string;
  lockStatusRegistryPath?: string;
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

  const state: ServerState = {
    role: null,
    hostSession: null,
    peerSession: null,
    origAccumulate: null,
    pendingUpdates: [],
    pendingAdmissions: new Map(),
    pendingAdmissionsWriter: null,
    activeEditsTracker: null,
    pendingUpdatesWriter: null,
    outboundUpdatesReader: null,
    lockStatusWriter: null,
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

  // ── 1. hoop_create_session ──────────────────────────────────────

  server.registerTool(
    "hoop_create_session",
    {
      description:
        "Start a P2P node, create a git worktree, and begin hosting a collaborative session. Returns the session code and listen addresses for peers to connect.",
      inputSchema: z.object({
        password: z.string().optional(),
        executionTarget: z.enum(["host-only", "proponent-side"]),
      }),
    },
    async ({ password, executionTarget }) => {
      if (state.role !== null) {
        return errorResult("Session already active. Leave current session first.");
      }

      try {
        // Initialize before createSession resolves so admission requests that
        // arrive during startup are mirrored to disk immediately for hooks.
        state.pendingAdmissionsWriter = new PendingAdmissionsWriter(
          pendingAdmissionsRegistryPath,
        );
        syncPendingAdmissions();

        const result = await createSession({
          password,
          executionTarget,
          gitOps,
          onAdmissionRequest: (email, peerId) =>
            new Promise<boolean>((resolve) => {
              state.pendingAdmissions.set(peerId, {
                email,
                peerId,
                resolve,
                requestedAt: Date.now(),
              });
              syncPendingAdmissions();
            }),
          onLockChange: () => flushLockStatus(),
        });

        state.hostSession = result;
        state.role = "host";
        writeSessionStatus({
          role: "host",
          sessionCode: result.sessionCode,
          branchName: result.branchName,
          executionTarget: result.executionTarget,
          worktreePath: result.worktreePath,
          passwordProtected: result.passwordProtected,
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

        // Intercept peer updates so hoop_check_updates can drain them
        state.origAccumulate = result.accumulator.accumulate.bind(result.accumulator);
        result.accumulator.accumulate = (update: StateUpdate) => {
          state.origAccumulate!(update);
          if (shouldQueuePendingUpdate(update)) {
            state.pendingUpdates.push(update);
          }
          if (update.type === "lock-acquire" || update.type === "lock-release") {
            flushLockStatus();
          }
          state.activeEditsTracker?.handleUpdate(update);
          state.pendingUpdatesWriter?.handleUpdate(update);
        };

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
          // Bypass the interceptor so host's own updates don't queue
          state.origAccumulate!(update);
          const seqNo = result.broadcastHub.broadcast(update);
          result.replayBuffer.push({ seqNo, update });
        }, outboundUpdatesRegistryPath);
        state.outboundUpdatesReader.start();

        return jsonResult({
          sessionCode: result.sessionCode,
          hostId: result.hostId,
          peerId: result.peerId,
          executionTarget: result.executionTarget,
          passwordProtected: result.passwordProtected,
          listenAddresses: result.listenAddresses,
          branchName: result.branchName,
          worktreePath: result.worktreePath,
        });
      } catch (e) {
        state.pendingAdmissions.clear();
        state.pendingAdmissionsWriter?.clear();
        state.pendingAdmissionsWriter = null;
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
        if (result.branchName) {
          writeSessionStatus({
            role: "peer",
            sessionCode: result.sessionCode,
            branchName: result.branchName,
            hostPeerId: result.hostPeerId,
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
        result.onBroadcast((update) => {
          if (shouldQueuePendingUpdate(update)) {
            state.pendingUpdates.push(update);
          }
          if (update.type === "lock-acquire" || update.type === "lock-release") {
            flushLockStatus();
          }
          state.activeEditsTracker?.handleUpdate(update);
          state.pendingUpdatesWriter?.handleUpdate(update);
        });

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
          // Bypass the interceptor so host's own updates don't queue
          state.origAccumulate!(update);
          const seqNo = state.hostSession.broadcastHub.broadcast(update);
          state.hostSession.replayBuffer.push({ seqNo, update });
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
        flushLockStatus();
        return jsonResult({ acquired: result.acquired, holder: result.holder });
      }

      if (state.role === "peer" && state.peerSession) {
        const result = await state.peerSession.acquireLock();
        flushLockStatus();
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
        flushLockStatus();
        return jsonResult({ released: result.released, holder: result.holder });
      }

      if (state.role === "peer" && state.peerSession) {
        const result = await state.peerSession.releaseLock();
        flushLockStatus();
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
      flushLockStatus();
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
          passwordProtected: s.passwordProtected,
          connectedPeers: s.broadcastHub.getSubscribers(),
          peerCount: s.broadcastHub.getSubscriberCount(),
          branchName: s.branchName,
          worktreePath: s.worktreePath,
          pendingAdmissions: state.pendingAdmissions.size,
          pendingUpdates: state.pendingUpdates.length,
          lock: s.getLockStatus(),
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
          lastSeqNo: s.getLastSeqNo(),
          pendingUpdates: state.pendingUpdates.length,
          lock: s.getLockStatus(),
        });
      }

      return errorResult("Unexpected state.");
    },
  );

  // ── 14. hoop_leave_session ─────────────────────────────────────

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
    clearSessionStatus(deps?.sessionStatusPath);
    state.role = null;
    state.hostSession = null;
    state.peerSession = null;
    state.origAccumulate = null;
    state.pendingUpdates.length = 0;
  }

  async function gracefulShutdown(): Promise<{ left: boolean; previousRole: string | null; sessionCode: string | undefined }> {
    const previousRole = state.role;
    const sessionCode =
      state.role === "host"
        ? state.hostSession?.sessionCode
        : state.peerSession?.sessionCode;

    try {
      if (state.role === "host" && state.hostSession) {
        for (const pending of state.pendingAdmissions.values()) {
          pending.resolve(false);
        }
        state.hostSession.broadcastHub.close();
        await state.hostSession.node.stop();
      }

      if (state.role === "peer" && state.peerSession) {
        state.peerSession.stopAckInterval();
        await state.peerSession.node.stop();
      }
    } finally {
      cleanupState();
    }

    return { left: true, previousRole, sessionCode };
  }

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
        const result = await gracefulShutdown();
        return jsonResult(result);
      } catch (e) {
        return errorResult(
          `Failed to leave session: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  return { server, state, gracefulShutdown };
}
