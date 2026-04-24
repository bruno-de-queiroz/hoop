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
  drainPendingPush?: () => Promise<void>;
}

export interface DestroySessionResult {
  errors: string[];
}

export async function destroySession(
  params: DestroySessionParams,
): Promise<DestroySessionResult> {
  const { sessionCode, branchName, worktreePath, node, store, gitOps, drainPendingPush } = params;
  const errors: string[] = [];

  // Stop the node first — this fires peer:disconnect events which may trigger
  // final lock-releases and their auto-pushes. Drain runs afterward to await
  // any pushes created during shutdown.
  try {
    await node.stop();
  } catch (err) {
    console.error("[hoop] destroySession: failed to stop node:", err);
    errors.push(`Failed to stop node: ${(err as Error).message}`);
  }

  if (drainPendingPush) {
    try {
      await drainPendingPush();
    } catch (err) {
      console.error("[hoop] destroySession: failed to drain pending push:", err);
      errors.push(`Failed to drain pending push: ${(err as Error).message}`);
    }
  }

  try {
    const remoteResult = await gitOps.deleteRemoteBranch(branchName);
    if (!remoteResult.ok) {
      console.error("[hoop] destroySession: failed to delete remote branch:", remoteResult.error);
      errors.push(`Failed to delete remote branch: ${remoteResult.error}`);
    }
  } catch (err) {
    console.error("[hoop] destroySession: failed to delete remote branch:", err);
    errors.push(`Failed to delete remote branch: ${(err as Error).message}`);
  }

  try {
    const worktreeResult = await gitOps.removeSessionWorktree(worktreePath, branchName);
    if (!worktreeResult.ok) {
      console.error("[hoop] destroySession: failed to remove worktree:", worktreeResult.error);
      errors.push(`Failed to remove worktree: ${worktreeResult.error}`);
    }
  } catch (err) {
    console.error("[hoop] destroySession: failed to remove worktree:", err);
    errors.push(`Failed to remove worktree: ${(err as Error).message}`);
  }

  store.delete(sessionCode);

  return { errors };
}
