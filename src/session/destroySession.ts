import type { HoopNode } from "../network/node.js";
import type { GitOps } from "./createSession.js";
import type { SessionStore } from "./session.js";

export interface DestroySessionParams {
  sessionCode: string;
  branchName: string;
  worktreePath: string;
  node: HoopNode;
  store: SessionStore;
  gitOps: Pick<GitOps, "removeSessionWorktree" | "deleteRemoteBranch">;
}

export interface DestroySessionResult {
  errors: string[];
}

export async function destroySession(
  params: DestroySessionParams,
): Promise<DestroySessionResult> {
  const { sessionCode, branchName, worktreePath, node, store, gitOps } = params;
  const errors: string[] = [];

  // 1. Stop the network node first so no new protocol messages arrive
  try {
    await node.stop();
  } catch (err) {
    errors.push(`Failed to stop node: ${(err as Error).message}`);
  }

  // 2. Delete the remote branch
  const remoteResult = await gitOps.deleteRemoteBranch(branchName);
  if (!remoteResult.ok) {
    errors.push(`Failed to delete remote branch: ${remoteResult.error}`);
  }

  // 3. Remove local worktree and branch
  const worktreeResult = await gitOps.removeSessionWorktree(worktreePath, branchName);
  if (!worktreeResult.ok) {
    errors.push(`Failed to remove worktree: ${worktreeResult.error}`);
  }

  // 4. Clean up session store
  store.delete(sessionCode);

  return { errors };
}
