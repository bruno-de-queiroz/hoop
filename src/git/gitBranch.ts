import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

function gitRaw(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function git(args: string[], cwd?: string): Promise<string> {
  return gitRaw(args, cwd).then((out) => out.trim());
}

function gitWithStdin(args: string[], stdin: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout);
      }
    });
    child.stdin!.end(stdin);
  });
}

export async function getGitRoot(cwd?: string): Promise<GitResult<string>> {
  try {
    const root = await git(["rev-parse", "--show-toplevel"], cwd);
    return { ok: true, value: root };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function fetchBranch(
  branchName: string,
  remote = "origin",
): Promise<GitResult> {
  try {
    await git(["fetch", remote, branchName]);
    return { ok: true, value: undefined as never };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function checkoutBranch(
  branchName: string,
): Promise<GitResult> {
  try {
    await git(["checkout", branchName]);
    return { ok: true, value: undefined as never };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function createSessionWorktree(
  branchName: string,
  worktreePath: string,
  cwd?: string,
): Promise<GitResult<string>> {
  try {
    const absolutePath = resolve(worktreePath);
    await git(["worktree", "add", "-b", branchName, absolutePath], cwd);
    return { ok: true, value: absolutePath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function computeGitDiff(
  worktreePath: string,
  filePath: string,
): Promise<GitResult<string>> {
  try {
    const diff = await gitRaw(["diff", "--no-color", "--", filePath], worktreePath);
    return { ok: true, value: diff };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface ApplyPatchOptions {
  check?: boolean;
  reverse?: boolean;
}

export async function applyGitPatch(
  worktreePath: string,
  patch: string,
  options: ApplyPatchOptions = {},
): Promise<GitResult> {
  try {
    const args = ["apply", "--whitespace=nowarn"];
    if (options.check) args.push("--check");
    if (options.reverse) args.push("--reverse");
    args.push("-");
    await gitWithStdin(args, patch, worktreePath);
    return { ok: true, value: undefined as never };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}
