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

  try {
    await node.stop();
  } catch (err) {
    errors.push(`Failed to stop node: ${(err as Error).message}`);
  }

  try {
    const remoteResult = await gitOps.deleteRemoteBranch(branchName);
    if (!remoteResult.ok) {
      errors.push(`Failed to delete remote branch: ${remoteResult.error}`);
    }
  } catch (err) {
    errors.push(`Failed to delete remote branch: ${(err as Error).message}`);
  }

  try {
    const worktreeResult = await gitOps.removeSessionWorktree(worktreePath, branchName);
    if (!worktreeResult.ok) {
      errors.push(`Failed to remove worktree: ${worktreeResult.error}`);
    }
  } catch (err) {
    errors.push(`Failed to remove worktree: ${(err as Error).message}`);
  }

  store.delete(sessionCode);

  return { errors };
}
