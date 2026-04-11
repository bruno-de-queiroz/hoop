import { execFile } from "node:child_process";
import { resolve } from "node:path";

export interface GitSuccess<T = void> {
  ok: true;
  value: T;
}

export interface GitFailure {
  ok: false;
  error: string;
}

export type GitResult<T = void> = GitSuccess<T> | GitFailure;

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export async function getGitRoot(): Promise<GitResult<string>> {
  try {
    const root = await git(["rev-parse", "--show-toplevel"]);
    return { ok: true, value: root };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function createSessionWorktree(
  branchName: string,
  worktreePath: string,
): Promise<GitResult<string>> {
  try {
    const absolutePath = resolve(worktreePath);
    await git(["worktree", "add", "-b", branchName, absolutePath]);
    return { ok: true, value: absolutePath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
