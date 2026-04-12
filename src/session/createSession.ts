import { hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { HoopNode } from "../network/node.js";
import type { NetworkConfig } from "../network/types.js";
import {
  AUTH_PROTOCOL,
  AUTH_TIMEOUT_MS,
  SYNC_PROTOCOL,
  BROADCAST_PROTOCOL,
  UPDATE_PROTOCOL,
  readFromStream,
  writeToStream,
  type AuthRequest,
  type AuthResponse,
  type SyncRequest,
  type SyncResponse,
  type UpdateResponse,
} from "../network/protocol.js";
import { BroadcastHub } from "../network/broadcastHub.js";
import { ReplayBuffer } from "../network/replayBuffer.js";
import { type StateUpdate, isStateUpdate, isAckMessage, type FileChangeUpdate } from "../state/stateUpdate.js";
import { HostStateAccumulator } from "../state/hostStateAccumulator.js";
import { isValidUnifiedDiff } from "../diff/validatePatch.js";
import { type ExecutionTarget, type Session, SessionStore } from "./session.js";
import { generateSessionCode } from "./sessionCode.js";
import { type StateTree, createEmptyStateTree } from "../state/stateTree.js";
import {
  getGitRoot as defaultGetGitRoot,
  createSessionWorktree as defaultCreateSessionWorktree,
  type GitResult,
} from "../git/gitBranch.js";

export interface GitOps {
  getGitRoot: () => Promise<GitResult<string>>;
  createSessionWorktree: (branchName: string, worktreePath: string) => Promise<GitResult<string>>;
}

export const realGitOps: GitOps = {
  getGitRoot: defaultGetGitRoot,
  createSessionWorktree: defaultCreateSessionWorktree,
};

export const stubGitOps: GitOps = {
  getGitRoot: async () => ({ ok: true, value: "/tmp/hoop-stub" }),
  createSessionWorktree: async (_branch, path) => ({ ok: true, value: path }),
};

export interface CreateSessionParams {
  password?: string;
  executionTarget: ExecutionTarget;
  networkConfig?: NetworkConfig;
  stateTree?: StateTree;
  gitOps: GitOps;
}

export interface CreateSessionResult {
  sessionCode: string;
  hostId: string;
  executionTarget: ExecutionTarget;
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

    node.addEventListener("peer:connect", (evt: CustomEvent) => {
      const peerId = evt.detail.toString();
      setTimeout(async () => {
        if (node.getState() !== "stopped" && !node.isPeerAuthenticated(peerId)) {
          await node.closeConnection(peerId);
        }
      }, AUTH_TIMEOUT_MS);
    });
  }

  store.update(sessionCode, {
    peerId: node.getPeerId(),
    listenAddresses: node.getListenAddresses(),
  });

  const gitOps = params.gitOps;
  const gitRootResult = await gitOps.getGitRoot();
  if (!gitRootResult.ok) {
    await node.stop();
    throw new Error(`Git repository required: ${gitRootResult.error}`);
  }

  const branchName = `hoop/session-${sessionCode}`;
  const targetPath = join(gitRootResult.value, ".hoop", "sessions", sessionCode);
  const worktreeResult = await gitOps.createSessionWorktree(branchName, targetPath);
  if (!worktreeResult.ok) {
    await node.stop();
    throw new Error(`Failed to create session worktree: ${worktreeResult.error}`);
  }

  const worktreePath = worktreeResult.value;
  store.update(sessionCode, { branchName, worktreePath });

  const broadcastHub = new BroadcastHub();
  const accumulator = new HostStateAccumulator();
  const replayBuffer = new ReplayBuffer();

  await node.handle(SYNC_PROTOCOL, async (stream, connection) => {
    const request = await readFromStream<SyncRequest>(stream);
    const remotePeerId = connection.remotePeer.toString();
    if (passwordHash && !node.isPeerAuthenticated(remotePeerId)) {
      await writeToStream(stream, { stateTree: createEmptyStateTree() } as SyncResponse);
      return;
    }
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
    if (passwordHash && !node.isPeerAuthenticated(remotePeerId)) {
      await stream.close();
      return;
    }
    broadcastHub.subscribe(remotePeerId, stream);
  });

  await node.handle(UPDATE_PROTOCOL, async (stream, connection) => {
    const remotePeerId = connection.remotePeer.toString();
    if (passwordHash && !node.isPeerAuthenticated(remotePeerId)) {
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
      const response: UpdateResponse = { accepted: false, reason: "invalid-update" };
      await writeToStream(stream, response);
      return;
    }

    if (update.type === "file-change" && !isValidUnifiedDiff(update.patch)) {
      const response: UpdateResponse = { accepted: false, reason: "invalid-patch" };
      await writeToStream(stream, response);
      return;
    }

    // Conflict resolution: metadata LWW
    if (update.type === "metadata-update") {
      const existing = accumulator.getMetadata(update.key);
      if (existing && (update.timestamp < existing.timestamp ||
          (update.timestamp === existing.timestamp && update.peerId <= existing.peerId))) {
        const response: UpdateResponse = { accepted: false, reason: "stale-metadata" };
        await writeToStream(stream, response);
        return;
      }
    }

    // Conflict resolution: file-change baseHash check
    if (update.type === "file-change") {
      const lastHash = accumulator.getFileHash(update.filePath);
      if (lastHash !== undefined && update.baseHash !== lastHash) {
        const response: UpdateResponse = { accepted: false, reason: "base-hash-mismatch" };
        await writeToStream(stream, response);
        return;
      }
    }

    accumulator.accumulate(update);
    const seqNo = broadcastHub.broadcast(update, remotePeerId);
    replayBuffer.push({ seqNo, update });
    const response: UpdateResponse = { accepted: true, seqNo };
    await writeToStream(stream, response);
  });

  node.addEventListener("peer:disconnect", (evt: CustomEvent) => {
    const peerId = evt.detail.toString();
    broadcastHub.unsubscribe(peerId);
    accumulator.removePeer(peerId);
  });

  return {
    sessionCode,
    hostId,
    executionTarget: params.executionTarget,
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
  };
}
