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

export async function computeContentDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
): Promise<GitResult<string>> {
  if (oldContent === newContent) {
    return { ok: true, value: "" };
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "hoop-diff-"));
  const oldFile = join(tmpDir, "old");
  const newFile = join(tmpDir, "new");

  try {
    await writeFile(oldFile, oldContent);
    await writeFile(newFile, newContent);

    const diff = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["diff", "--no-index", "--no-color", "--", oldFile, newFile],
        (error, stdout, stderr) => {
          // git diff --no-index exits with 1 when files differ — that's expected.
          // The exit code is a number at runtime but typed as string|undefined.
          const exitCode = (error as unknown as { code?: number } | null)?.code;
          if (error && exitCode !== 1) {
            reject(new Error(stderr.trim() || error.message));
          } else {
            resolve(stdout);
          }
        },
      );
    });

    // Replace temp file paths with the actual filePath so git apply works correctly.
    // git diff --no-index strips the leading "/" from absolute paths in headers.
    const oldLabel = oldFile.replace(/^\//, "");
    const newLabel = newFile.replace(/^\//, "");
    const fixed = diff
      .replaceAll(`a/${oldLabel}`, `a/${filePath}`)
      .replaceAll(`b/${newLabel}`, `b/${filePath}`);

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

export function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}
