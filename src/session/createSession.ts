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
  readFromStream,
  writeToStream,
  type AuthRequest,
  type AuthResponse,
  type SyncRequest,
  type SyncResponse,
} from "../network/protocol.js";
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

const defaultGitOps: GitOps = {
  getGitRoot: defaultGetGitRoot,
  createSessionWorktree: defaultCreateSessionWorktree,
};

export const noOpGitOps: GitOps = {
  getGitRoot: async () => ({ ok: false, error: "disabled" }),
  createSessionWorktree: async () => ({ ok: false, error: "disabled" }),
};

export interface CreateSessionParams {
  password?: string;
  executionTarget: ExecutionTarget;
  networkConfig?: NetworkConfig;
  stateTree?: StateTree;
  gitOps?: GitOps;
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
  branchName?: string;
  worktreePath?: string;
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

  await node.handle(SYNC_PROTOCOL, async (stream, connection) => {
    await readFromStream<SyncRequest>(stream);
    const remotePeerId = connection.remotePeer.toString();
    if (passwordHash && !node.isPeerAuthenticated(remotePeerId)) {
      await writeToStream(stream, { stateTree: createEmptyStateTree() } as SyncResponse);
      return;
    }
    await writeToStream(stream, { stateTree } as SyncResponse);
  });

  store.update(sessionCode, {
    peerId: node.getPeerId(),
    listenAddresses: node.getListenAddresses(),
  });

  let branchName: string | undefined;
  let worktreePath: string | undefined;

  const gitOps = params.gitOps ?? defaultGitOps;
  const gitRootResult = await gitOps.getGitRoot();
  if (gitRootResult.ok) {
    branchName = `hoop/session-${sessionCode}`;
    const targetPath = join(gitRootResult.value, ".hoop", "sessions", sessionCode);
    const worktreeResult = await gitOps.createSessionWorktree(branchName, targetPath);
    if (worktreeResult.ok) {
      worktreePath = worktreeResult.value;
      store.update(sessionCode, { branchName, worktreePath });
    } else {
      branchName = undefined;
      console.warn(`[hoop] Failed to create session worktree: ${worktreeResult.error}`);
    }
  } else {
    console.warn(`[hoop] Not a git repository, skipping worktree creation: ${gitRootResult.error}`);
  }

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
  };
}
