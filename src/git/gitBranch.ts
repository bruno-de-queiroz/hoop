import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

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

function gitRawAllowExitCode(
  args: string[],
  allowedCodes: number[],
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof error.code === "number" ? error.code : undefined;
        if (code !== undefined && allowedCodes.includes(code)) {
          resolve(stdout);
        } else {
          reject(new Error(stderr.trim() || error.message));
        }
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
  cwd?: string,
): Promise<GitResult> {
  try {
    await git(["fetch", remote, branchName], cwd);
    return { ok: true, value: undefined as never };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function checkoutBranch(
  branchName: string,
  cwd?: string,
): Promise<GitResult> {
  try {
    await git(["checkout", branchName], cwd);
    return { ok: true, value: undefined as never };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function pushBranch(
  branchName: string,
  remote = "origin",
  cwd?: string,
): Promise<GitResult> {
  try {
    await git(["push", remote, branchName], cwd);
    return { ok: true, value: undefined as never };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function deleteRemoteBranch(
  branchName: string,
  remote = "origin",
  cwd?: string,
): Promise<GitResult> {
  try {
    await git(["push", remote, "--delete", branchName], cwd);
    return { ok: true, value: undefined as never };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function removeSessionWorktree(
  worktreePath: string,
  branchName: string,
  cwd?: string,
): Promise<GitResult> {
  try {
    await git(["worktree", "remove", "--force", worktreePath], cwd);
    await git(["branch", "-D", branchName], cwd);
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

export async function computeContentDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
): Promise<GitResult<string>> {
  // Validate filePath before using it in regex/string substitution
  if (filePath.includes("\n") || filePath.includes("\r") || filePath.includes("\0")) {
    return {
      ok: false,
      error: "Invalid filePath: contains forbidden control characters",
    };
  }

  const segments = filePath.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      return {
        ok: false,
        error: "Invalid filePath: contains path-escape segment",
      };
    }
  }

  if (oldContent === newContent) {
    return { ok: true, value: "" };
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "hoop-diff-"));
  const oldFile = join(tmpDir, "old");
  const newFile = join(tmpDir, "new");

  try {
    await writeFile(oldFile, oldContent);
    await writeFile(newFile, newContent);

    // git diff --no-index exits with 1 when files differ — that's expected
    const diff = await gitRawAllowExitCode(
      ["diff", "--no-index", "--no-color", "--", oldFile, newFile],
      [1],
    );

    // Rewrite only the known header lines to use the actual filePath.
    // Replacer functions avoid $ special-pattern interpolation in filePath.
    const fixed = diff
      .replace(/^diff --git a\/.*? b\/.*$/m, () => `diff --git a/${filePath} b/${filePath}`)
      .replace(/^--- a\/.*$/m, () => `--- a/${filePath}`)
      .replace(/^\+\+\+ b\/.*$/m, () => `+++ b/${filePath}`);

    return { ok: true, value: fixed };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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

/**
 * Stages explicit paths then commits with the given message. Returns `true`
 * when a commit was created, `false` when the working tree was already clean.
 * Requires explicit paths — git add -A is unsafe in shared worktrees.
 */
export async function addAndCommit(
  message: string,
  paths: string[],
  cwd?: string,
): Promise<GitResult<boolean>> {
  if (paths.length === 0) {
    return {
      ok: false,
      error: "addAndCommit requires explicit paths — git add -A is unsafe in shared worktrees",
    };
  }

  try {
    await git(["add", "--", ...paths], cwd);
    const staged = await git(["diff", "--cached", "--name-only"], cwd);
    if (staged === "") {
      return { ok: true, value: false };
    }
    await git(["commit", "-m", message], cwd);
    return { ok: true, value: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}
