import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeGitDiff, applyGitPatch, hashContent } from "../gitBranch.js";
import { execFile } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

function simulateExecFile(stdout: string) {
  mockExecFile.mockImplementation(
    ((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string, stderr: string) => void)(
        null,
        stdout,
        "",
      );
      return { stdin: { end: vi.fn() } };
    }) as unknown as typeof execFile,
  );
}

function simulateExecFileError(message: string, stderr = "") {
  mockExecFile.mockImplementation(
    ((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      const err = new Error(message);
      (cb as (err: Error | null, stdout: string, stderr: string) => void)(
        err,
        "",
        stderr,
      );
      return { stdin: { end: vi.fn() } };
    }) as unknown as typeof execFile,
  );
}

describe("computeGitDiff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns diff output on success", async () => {
    const diffOutput = `--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new`;
    simulateExecFile(diffOutput);

    const result = await computeGitDiff("/tmp/worktree", "file.txt");

    expect(result).toEqual({ ok: true, value: diffOutput + "\n" });
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["diff", "--no-color", "--", "file.txt"],
      { cwd: "/tmp/worktree" },
      expect.any(Function),
    );
  });

  it("returns failure when git fails", async () => {
    simulateExecFileError("exit code 128", "fatal: not a git repository");

    const result = await computeGitDiff("/tmp/worktree", "file.txt");

    expect(result).toEqual({
      ok: false,
      error: "fatal: not a git repository",
    });
  });
});

describe("applyGitPatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies patch successfully", async () => {
    simulateExecFile("");

    const result = await applyGitPatch("/tmp/worktree", "patch-content");

    expect(result.ok).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["apply", "--whitespace=nowarn", "-"],
      { cwd: "/tmp/worktree" },
      expect.any(Function),
    );
  });

  it("runs dry-run check when check=true", async () => {
    simulateExecFile("");

    const result = await applyGitPatch("/tmp/worktree", "patch-content", true);

    expect(result.ok).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["apply", "--whitespace=nowarn", "--check", "-"],
      { cwd: "/tmp/worktree" },
      expect.any(Function),
    );
  });

  it("returns failure when patch cannot be applied", async () => {
    simulateExecFileError("exit code 1", "error: patch does not apply");

    const result = await applyGitPatch("/tmp/worktree", "bad-patch");

    expect(result).toEqual({
      ok: false,
      error: "error: patch does not apply",
    });
  });
});

describe("hashContent", () => {
  it("returns consistent MD5 hash for same content", () => {
    const hash1 = hashContent("hello world");
    const hash2 = hashContent("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(32);
  });

  it("returns different hashes for different content", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });

  it("handles empty string", () => {
    const hash = hashContent("");
    expect(hash).toHaveLength(32);
  });
});
