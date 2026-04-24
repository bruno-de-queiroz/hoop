import { hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { HoopNode } from "../network/node.js";
import type { NetworkConfig } from "../network/types.js";
import {
  AUTH_PROTOCOL,
  AUTH_TIMEOUT_MS,
  ADMISSION_PROTOCOL,
  ADMISSION_COOLDOWN_MS,
  SYNC_PROTOCOL,
  BROADCAST_PROTOCOL,
  UPDATE_PROTOCOL,
  PROMPT_PROTOCOL,
  readFromStream,
  writeToStream,
  type AuthRequest,
  type AuthResponse,
  type AdmissionRequest,
  type AdmissionResponse,
  type SyncRequest,
  type SyncResponse,
  type StateUpdateResponse,
  type LockAcquireResponse,
  type LockReleaseResponse,
} from "../network/protocol.js";
import { BroadcastHub } from "../network/broadcastHub.js";
import { ReplayBuffer } from "../network/replayBuffer.js";
import {
  type StateUpdate,
  isStateUpdate,
  isAckMessage,
  type LockAcquireUpdate,
  type LockReleaseUpdate,
} from "../state/stateUpdate.js";
import { HostStateAccumulator } from "../state/hostStateAccumulator.js";
import { type HoopLock } from "../state/hoopLock.js";
import { isValidUnifiedDiff } from "../diff/validatePatch.js";
import {
  PromptRequestQueue,
  isPromptRequestMessage,
  isPromptStatusQuery,
  type PromptRequest,
  type PromptResponse,
} from "../state/promptRequest.js";
import { randomUUID } from "node:crypto";
import { type ExecutionTarget, type Session, SessionStore } from "./session.js";
import { generateSessionCode } from "./sessionCode.js";
import { type StateTree, createEmptyStateTree } from "../state/stateTree.js";
import {
  getGitRoot as defaultGetGitRoot,
  createSessionWorktree as defaultCreateSessionWorktree,
  removeSessionWorktree as defaultRemoveSessionWorktree,
  pushBranch as defaultPushBranch,
  deleteRemoteBranch as defaultDeleteRemoteBranch,
  addAndCommit as defaultAddAndCommit,
  type GitResult,
} from "../git/gitBranch.js";

export interface GitOps {
  getGitRoot: () => Promise<GitResult<string>>;
  createSessionWorktree: (branchName: string, worktreePath: string) => Promise<GitResult<string>>;
  removeSessionWorktree: (worktreePath: string, branchName: string) => Promise<GitResult>;
  pushBranch: (branchName: string, remote?: string) => Promise<GitResult>;
  deleteRemoteBranch: (branchName: string, remote?: string) => Promise<GitResult>;
  addAndCommit: (message: string, cwd?: string) => Promise<GitResult<boolean>>;
}

export const realGitOps: GitOps = {
  getGitRoot: defaultGetGitRoot,
  createSessionWorktree: defaultCreateSessionWorktree,
  removeSessionWorktree: defaultRemoveSessionWorktree,
  pushBranch: defaultPushBranch,
  deleteRemoteBranch: defaultDeleteRemoteBranch,
  addAndCommit: defaultAddAndCommit,
};

export const stubGitOps: GitOps = {
  getGitRoot: async () => ({ ok: true, value: "/tmp/hoop-stub" }),
  createSessionWorktree: async (_branch, path) => ({ ok: true, value: path }),
  removeSessionWorktree: async () => ({ ok: true, value: undefined as never }),
  pushBranch: async () => ({ ok: true, value: undefined as never }),
  deleteRemoteBranch: async () => ({ ok: true, value: undefined as never }),
  addAndCommit: async () => ({ ok: true, value: false }),
};

export const defaultAdmissionHandler = async (_email: string, _peerId: string): Promise<boolean> => true;

export interface CreateSessionParams {
  password?: string;
  onAdmissionRequest: (email: string, peerId: string) => Promise<boolean>;
  onLockChange?: (lock: HoopLock) => void;
  onPromptRequest?: (request: PromptRequest) => void;
  onPeerDisconnect?: (peerId: string) => void;
  executionTarget: ExecutionTarget;
  autoExecutePrompts?: boolean;
  networkConfig?: NetworkConfig;
  stateTree?: StateTree;
  gitOps: GitOps;
}

export interface LockAcquireResult {
  acquired: boolean;
  holder: string | null;
  seqNo?: number;
}

export interface LockReleaseResult {
  released: boolean;
  holder: string | null;
  seqNo?: number;
}

export interface PublishedUpdate {
  seqNo: number;
  update: StateUpdate;
  excludePeerId?: string;
}

export type PublishedUpdateListener = (publication: PublishedUpdate) => void;

export interface CreateSessionResult {
  sessionCode: string;
  hostId: string;
  executionTarget: ExecutionTarget;
  autoExecutePrompts: boolean;
  passwordProtected: boolean;
  peerId: string;
  listenAddresses: string[];
  node: HoopNode;
  stateTree: StateTree;
  branchName: string;
  worktreePath: string;
  broadcastHub: BroadcastHub;
  accumulator: HostStateAccumulator;
  replayBuffer: ReplayBuffer;
  promptRequestQueue: PromptRequestQueue;
  /**
   * Publishes a host-side update through the canonical accumulate → broadcast →
   * replay flow. Prefer acquireLock()/releaseLock() for lock updates so their
   * validation rules stay centralized.
   */
  publishUpdate: (update: StateUpdate, excludePeerId?: string) => number;
  onPublishedUpdate: (listener: PublishedUpdateListener) => (() => void);
  acquireLock: (peerId?: string, timestamp?: number) => LockAcquireResult;
  releaseLock: (peerId?: string, timestamp?: number) => LockReleaseResult;
  forceReleaseLock: (timestamp?: number) => LockReleaseResult;
  getLockStatus: () => HoopLock;
  /** Resolves when any in-flight auto-push completes. Rejects on timeout. Call during teardown. */
  drainPendingPush: (timeoutMs?: number) => Promise<void>;
}

export async function createSession(
  params: CreateSessionParams,
  store: SessionStore = new SessionStore(),
): Promise<CreateSessionResult> {
  const sessionCode = generateSessionCode();
  const stateTree = params.stateTree ?? createEmptyStateTree();

  let passwordHash: string | undefined;
  if (params.password) {
    passwordHash = await bcrypt.hash(params.password, 12);
  }

  let hostId: string;
  try {
    hostId = hostname();
  } catch {
    hostId = randomBytes(4).toString("hex");
  }

  const session: Session = {
    sessionCode,
    passwordHash,
    hostId,
    executionTarget: params.executionTarget,
    createdAt: new Date(),
  };

  store.create(session);

  const networkConfig: NetworkConfig = params.networkConfig ?? {
    transportMode: "local",
  };

  const node = new HoopNode(networkConfig);
  await node.start();

  const deniedPeers = new Map<string, number>();

  await node.handle(ADMISSION_PROTOCOL, async (stream, connection) => {
    try {
      const request = await readFromStream<AdmissionRequest>(stream);
      const remotePeerId = connection.remotePeer.toString();

      const deniedAt = deniedPeers.get(remotePeerId);
      if (deniedAt !== undefined) {
        const elapsed = Date.now() - deniedAt;
        if (elapsed < ADMISSION_COOLDOWN_MS) {
          const response: AdmissionResponse = {
            admitted: false,
            retryAfterMs: ADMISSION_COOLDOWN_MS - elapsed,
          };
          await writeToStream(stream, response);
          await connection.close();
          return;
        }
        deniedPeers.delete(remotePeerId);
      }

      const admitted = await params.onAdmissionRequest(request.email, remotePeerId);
      if (admitted) {
        node.markPeerAuthenticated(remotePeerId);
        await writeToStream(stream, { admitted: true } as AdmissionResponse);
      } else {
        deniedPeers.set(remotePeerId, Date.now());
        const response: AdmissionResponse = {
          admitted: false,
          retryAfterMs: ADMISSION_COOLDOWN_MS,
        };
        await writeToStream(stream, response);
        await connection.close();
      }
    } catch {
      await connection.close();
    }
  });

  if (passwordHash) {
    await node.handle(AUTH_PROTOCOL, async (stream, connection) => {
      try {
        const request = await readFromStream<AuthRequest>(stream);
        const matches = await bcrypt.compare(request.password, passwordHash);
        if (matches) {
          await writeToStream(stream, { accepted: true } as AuthResponse);
          node.markPeerAuthenticated(connection.remotePeer.toString());
        } else {
          await writeToStream(stream, { accepted: false, reason: "Invalid password" } as AuthResponse);
          await connection.close();
        }
      } catch {
        await connection.close();
      }
    });
  }

  node.addEventListener("peer:connect", (evt: CustomEvent) => {
    const peerId = evt.detail.toString();
    setTimeout(async () => {
      if (node.getState() !== "stopped" && !node.isPeerAuthenticated(peerId)) {
        await node.closeConnection(peerId);
      }
    }, AUTH_TIMEOUT_MS);
  });

  store.update(sessionCode, {
    peerId: node.getPeerId(),
    listenAddresses: node.getListenAddresses(),
  });

  const gitOps = params.gitOps;
  const gitRootResult = await gitOps.getGitRoot();
  if (!gitRootResult.ok) {
    store.delete(sessionCode);
    await node.stop();
    throw new Error(`Git repository required: ${gitRootResult.error}`);
  }

  const branchSuffix = randomBytes(4).toString("hex");
  const branchName = `hoop/session-${sessionCode}-${branchSuffix}`;
  const targetPath = join(gitRootResult.value, ".hoop", "sessions", sessionCode);
  const worktreeResult = await gitOps.createSessionWorktree(branchName, targetPath);
  if (!worktreeResult.ok) {
    store.delete(sessionCode);
    await node.stop();
    throw new Error(`Failed to create session worktree: ${worktreeResult.error}`);
  }

  const worktreePath = worktreeResult.value;

  const pushResult = await gitOps.pushBranch(branchName);
  if (!pushResult.ok) {
    const cleanupResult = await gitOps.removeSessionWorktree(worktreePath, branchName);
    store.delete(sessionCode);
    await node.stop();
    const cleanupDetail = cleanupResult.ok ? "" : ` (cleanup also failed: ${cleanupResult.error})`;
    throw new Error(`Failed to push session branch: ${pushResult.error}${cleanupDetail}`);
  }

  store.update(sessionCode, { branchName, worktreePath });

  const broadcastHub = new BroadcastHub();
  const accumulator = new HostStateAccumulator();
  const replayBuffer = new ReplayBuffer();
  const promptRequestQueue = new PromptRequestQueue();
  const autoExecutePrompts = params.autoExecutePrompts ?? false;
  const publishedUpdateListeners = new Set<PublishedUpdateListener>();
  let pendingPush: Promise<void> | null = null;

  const onPublishedUpdate = (listener: PublishedUpdateListener): (() => void) => {
    publishedUpdateListeners.add(listener);
    return () => {
      publishedUpdateListeners.delete(listener);
    };
  };

  const publishUpdate = (
    update: StateUpdate,
    excludePeerId?: string,
  ): number => {
    // Centralized host-side publication flow: every accepted update must be
    // accumulated before it is broadcast so snapshots, seqNos, and replay data
    // all reflect the same ordering. Host-only observers run afterward.
    accumulator.accumulate(update);
    const seqNo = broadcastHub.broadcast(update, excludePeerId);
    replayBuffer.push({ seqNo, update });

    if (update.type === "lock-acquire" || update.type === "lock-release") {
      params.onLockChange?.(accumulator.getLockSnapshot(update.timestamp));
    }

    // Auto-push fires for every lock-release regardless of origin (normal release,
    // force release, TTL expiry, peer disconnect). This is intentional: the host
    // worktree is the single source of truth, and any transition to "free" means
    // the next agent needs the latest state on the remote branch. Even if the
    // previous holder timed out or crashed, the worktree already contains whatever
    // partial work was applied — pushing it ensures remote peers start from reality
    // rather than a stale snapshot.
    if (update.type === "lock-release") {
      const previous = pendingPush ?? Promise.resolve();
      const current = previous.then(async () => {
        try {
          const commitResult = await gitOps.addAndCommit(
            `hoop: sync after lock release by ${update.peerId}`,
            worktreePath,
          );
          if (!commitResult.ok) {
            console.error("[hoop] auto-commit failed:", commitResult.error);
            return;
          }
          if (commitResult.value) {
            const autoPushResult = await gitOps.pushBranch(branchName);
            if (!autoPushResult.ok) {
              console.error("[hoop] auto-push failed:", autoPushResult.error);
            }
          }
        } catch (err) {
          console.error("[hoop] auto-push failed:", err);
        } finally {
          if (pendingPush === current) {
            pendingPush = null;
          }
        }
      });
      pendingPush = current;
    }

    for (const listener of publishedUpdateListeners) {
      try {
        listener({ seqNo, update, excludePeerId });
      } catch (err) {
        console.error("[hoop] publishUpdate observer error:", err);
      }
    }

    return seqNo;
  };

  const expireStaleLock = (timestamp: number = Date.now(), excludePeerId?: string): LockReleaseUpdate | undefined => {
    const releaseUpdate = accumulator.deriveExpiredLockRelease(timestamp);
    if (releaseUpdate) {
      publishUpdate(releaseUpdate, excludePeerId);
    }
    return releaseUpdate;
  };

  const getLockStatus = (timestamp: number = Date.now()): HoopLock => {
    return accumulator.getLockSnapshot(timestamp);
  };

  // Host-local acquires skip the pendingPush gate because the host already
  // has the latest worktree state on disk — it IS the filesystem authority.
  // Remote peers are gated in the UPDATE_PROTOCOL handler instead.
  const acquireLock = (
    peerId: string = node.getPeerId(),
    timestamp: number = Date.now(),
    excludePeerId?: string,
  ): LockAcquireResult => {
    expireStaleLock(timestamp, excludePeerId);
    const lock = accumulator.getLockSnapshot(timestamp);
    if (lock.status === "busy") {
      if (lock.holderPeerId === peerId) {
        return { acquired: true, holder: peerId };
      }
      return { acquired: false, holder: lock.holderPeerId };
    }

    const update: LockAcquireUpdate = {
      type: "lock-acquire",
      peerId,
      timestamp,
    };
    const seqNo = publishUpdate(update, excludePeerId);
    return { acquired: true, holder: peerId, seqNo };
  };

  const releaseLock = (
    peerId: string = node.getPeerId(),
    timestamp: number = Date.now(),
    excludePeerId?: string,
  ): LockReleaseResult => {
    expireStaleLock(timestamp, excludePeerId);
    const lock = accumulator.getLockSnapshot(timestamp);
    if (lock.status === "free") {
      return { released: false, holder: null };
    }
    if (lock.holderPeerId !== peerId) {
      return { released: false, holder: lock.holderPeerId };
    }

    const update: LockReleaseUpdate = {
      type: "lock-release",
      peerId,
      timestamp,
    };
    const seqNo = publishUpdate(update, excludePeerId);
    return { released: true, holder: null, seqNo };
  };

  const forceReleaseLock = (
    timestamp: number = Date.now(),
  ): LockReleaseResult => {
    expireStaleLock(timestamp);
    const lock = accumulator.getLockSnapshot(timestamp);
    if (lock.status === "free" || lock.holderPeerId === null) {
      return { released: false, holder: null };
    }

    const update: LockReleaseUpdate = {
      type: "lock-release",
      peerId: lock.holderPeerId,
      timestamp,
    };
    const seqNo = publishUpdate(update);
    return { released: true, holder: null, seqNo };
  };

  await node.handle(SYNC_PROTOCOL, async (stream, connection) => {
    const request = await readFromStream<SyncRequest>(stream);
    const remotePeerId = connection.remotePeer.toString();
    if (!node.isPeerAuthenticated(remotePeerId)) {
      await writeToStream(stream, { stateTree: createEmptyStateTree() } as SyncResponse);
      return;
    }
    expireStaleLock(Date.now(), remotePeerId);
    const response: SyncResponse = {
      stateTree,
      branchName,
      accumulatedState: accumulator.getSnapshot(),
      currentSeqNo: broadcastHub.getCurrentSeqNo(),
    };
    if (request.replayFromSeq !== undefined) {
      const oldest = replayBuffer.getOldestSeqNo();
      if (oldest !== undefined && request.replayFromSeq >= oldest - 1) {
        response.replayedUpdates = replayBuffer.replaySince(request.replayFromSeq);
      }
      // If gap exceeds buffer, client falls back to full accumulated state (already included)
    }
    await writeToStream(stream, response);
  });

  await node.handle(BROADCAST_PROTOCOL, async (stream, connection) => {
    const remotePeerId = connection.remotePeer.toString();
    if (!node.isPeerAuthenticated(remotePeerId)) {
      await stream.close();
      return;
    }
    broadcastHub.subscribe(remotePeerId, stream);
  });

  await node.handle(PROMPT_PROTOCOL, async (stream, connection) => {
    const remotePeerId = connection.remotePeer.toString();
    if (!node.isPeerAuthenticated(remotePeerId)) {
      await writeToStream(stream, {
        id: "",
        status: "denied",
        reason: "not-authenticated",
        timestamp: Date.now(),
      } as PromptResponse);
      return;
    }

    try {
      const message = await readFromStream<unknown>(stream);

      if (isPromptStatusQuery(message)) {
        const entry = promptRequestQueue.get(message.id);
        const response: PromptResponse = entry
          ? { id: message.id, status: entry.status, timestamp: Date.now() }
          : { id: message.id, status: "failed", error: "not-found", timestamp: Date.now() };
        await writeToStream(stream, response);
        return;
      }

      if (isPromptRequestMessage(message)) {
        const id = randomUUID();
        const request: PromptRequest = {
          id,
          prompt: message.prompt,
          model: message.model,
          requestedBy: remotePeerId,
          timestamp: Date.now(),
        };
        const response = promptRequestQueue.enqueue(request, autoExecutePrompts);
        params.onPromptRequest?.(request);
        await writeToStream(stream, response);
        return;
      }

      await writeToStream(stream, {
        id: "",
        status: "failed",
        error: "invalid-message",
        timestamp: Date.now(),
      } as PromptResponse);
    } catch {
      await writeToStream(stream, {
        id: "",
        status: "failed",
        error: "internal-error",
        timestamp: Date.now(),
      } as PromptResponse);
    }
  });

  await node.handle(UPDATE_PROTOCOL, async (stream, connection) => {
    const remotePeerId = connection.remotePeer.toString();
    if (!node.isPeerAuthenticated(remotePeerId)) {
      await stream.close();
      return;
    }
    const message = await readFromStream<unknown>(stream);

    // Handle ACK messages (not broadcast to other peers)
    if (isAckMessage(message)) {
      broadcastHub.recordAck(remotePeerId, message.lastSeqNo);
      return;
    }

    const update = message as StateUpdate;

    if (!isStateUpdate(update)) {
      const response: StateUpdateResponse = {
        kind: "state-update",
        accepted: false,
        reason: "invalid-update",
      };
      await writeToStream(stream, response);
      return;
    }

    if ((update.type === "lock-acquire" || update.type === "lock-release") && update.peerId !== remotePeerId) {
      expireStaleLock(update.timestamp, remotePeerId);
      const lock = getLockStatus(update.timestamp);
      const response: LockAcquireResponse | LockReleaseResponse = update.type === "lock-acquire"
        ? {
            kind: "lock-acquire",
            acquired: false,
            holder: lock.holderPeerId,
            reason: "invalid-peer",
            lock,
          }
        : {
            kind: "lock-release",
            released: false,
            holder: lock.holderPeerId,
            reason: "invalid-peer",
            lock,
          };
      await writeToStream(stream, response);
      return;
    }

    if (update.type === "lock-acquire") {
      if (pendingPush) {
        await pendingPush;
      }
      const result = acquireLock(update.peerId, update.timestamp, remotePeerId);
      const response: LockAcquireResponse = result.acquired
        ? {
            kind: "lock-acquire",
            acquired: true,
            holder: result.holder,
            seqNo: result.seqNo,
            lock: getLockStatus(update.timestamp),
          }
        : {
            kind: "lock-acquire",
            acquired: false,
            holder: result.holder,
            reason: "lock-busy",
            lock: getLockStatus(update.timestamp),
          };
      await writeToStream(stream, response);
      return;
    }

    if (update.type === "lock-release") {
      const result = releaseLock(update.peerId, update.timestamp, remotePeerId);
      const response: LockReleaseResponse = result.released
        ? {
            kind: "lock-release",
            released: true,
            holder: result.holder,
            seqNo: result.seqNo,
            lock: getLockStatus(update.timestamp),
          }
        : {
            kind: "lock-release",
            released: false,
            holder: result.holder,
            reason: result.holder === null ? "lock-not-held" : "lock-held-by-other-peer",
            lock: getLockStatus(update.timestamp),
          };
      await writeToStream(stream, response);
      return;
    }

    if (update.type === "file-change" && !isValidUnifiedDiff(update.patch)) {
      const response: StateUpdateResponse = {
        kind: "state-update",
        accepted: false,
        reason: "invalid-patch",
      };
      await writeToStream(stream, response);
      return;
    }

    // Conflict resolution: metadata LWW
    if (update.type === "metadata-update") {
      const existing = accumulator.getMetadata(update.key);
      if (existing && (update.timestamp < existing.timestamp ||
          (update.timestamp === existing.timestamp && update.peerId <= existing.peerId))) {
        const response: StateUpdateResponse = {
          kind: "state-update",
          accepted: false,
          reason: "stale-metadata",
        };
        await writeToStream(stream, response);
        return;
      }
    }

    // Conflict resolution: file-change baseHash check
    if (update.type === "file-change") {
      const lastHash = accumulator.getFileHash(update.filePath);
      if (lastHash !== undefined && update.baseHash !== lastHash) {
        const response: StateUpdateResponse = {
          kind: "state-update",
          accepted: false,
          reason: "base-hash-mismatch",
        };
        await writeToStream(stream, response);
        return;
      }
    }

    const seqNo = publishUpdate(update, remotePeerId);
    const response: StateUpdateResponse = {
      kind: "state-update",
      accepted: true,
      seqNo,
    };
    await writeToStream(stream, response);
  });

  node.addEventListener("peer:disconnect", (evt: CustomEvent) => {
    const peerId = evt.detail.toString();
    broadcastHub.unsubscribe(peerId);
    accumulator.removePeerPresence(peerId);
    try {
      params.onPeerDisconnect?.(peerId);
    } catch (err) {
      console.error("[hoop] peer disconnect cleanup error:", err);
    }

    const releaseUpdate = accumulator.deriveLockReleaseForPeer(peerId);
    if (releaseUpdate) {
      publishUpdate(releaseUpdate);
    }
  });

  const DRAIN_TIMEOUT_MS = 10_000;

  const drainPendingPush = async (timeoutMs: number = DRAIN_TIMEOUT_MS): Promise<void> => {
    if (!pendingPush) return;
    await Promise.race([
      pendingPush,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("drainPendingPush timed out")), timeoutMs),
      ),
    ]);
  };

  return {
    sessionCode,
    hostId,
    executionTarget: params.executionTarget,
    autoExecutePrompts,
    passwordProtected: passwordHash !== undefined,
    peerId: node.getPeerId(),
    listenAddresses: node.getListenAddresses(),
    node,
    stateTree,
    branchName,
    worktreePath,
    broadcastHub,
    accumulator,
    replayBuffer,
    promptRequestQueue,
    publishUpdate,
    onPublishedUpdate,
    acquireLock,
    releaseLock,
    forceReleaseLock,
    getLockStatus,
    drainPendingPush,
  };
}
