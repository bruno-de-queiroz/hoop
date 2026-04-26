import { describe, it, expect, vi, beforeEach } from "vitest";
import { getGitRoot, createSessionWorktree, removeSessionWorktree, fetchBranch, checkoutBranch, pushBranch, computeContentDiff } from "../gitBranch.js";
import { execFile } from "node:child_process";
import { resolve } from "node:path";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

function simulateExecFile(stdout: string, stderr = "") {
  mockExecFile.mockImplementation(
    ((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string, stderr: string) => void)(
        null,
        stdout,
        stderr,
      );
    }) as typeof execFile,
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
    }) as typeof execFile,
  );
}

describe("getGitRoot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the git root path on success", async () => {
    simulateExecFile("/home/user/project");

    const result = await getGitRoot();

    expect(result).toEqual({ ok: true, value: "/home/user/project" });
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: undefined },
      expect.any(Function),
    );
  });

  it("returns failure when not in a git repo", async () => {
    simulateExecFileError(
      "exit code 128",
      "fatal: not a git repository",
    );

    const result = await getGitRoot();

    expect(result).toEqual({
      ok: false,
      error: "fatal: not a git repository",
    });
  });
});

describe("createSessionWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a worktree with a new branch on success", async () => {
    simulateExecFile("Preparing worktree (new branch 'hoop/session-ABC-XYZ')");

    const result = await createSessionWorktree(
      "hoop/session-ABC-XYZ",
      "/home/user/project/.hoop/sessions/ABC-XYZ",
    );

    const expectedPath = resolve("/home/user/project/.hoop/sessions/ABC-XYZ");
    expect(result).toEqual({ ok: true, value: expectedPath });
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "hoop/session-ABC-XYZ", expectedPath],
      { cwd: undefined },
      expect.any(Function),
    );
  });

  it("returns failure when branch already exists", async () => {
    simulateExecFileError(
      "exit code 128",
      "fatal: a branch named 'hoop/session-ABC-XYZ' already exists",
    );

    const result = await createSessionWorktree(
      "hoop/session-ABC-XYZ",
      "/tmp/worktree",
    );

    expect(result).toEqual({
      ok: false,
      error: "fatal: a branch named 'hoop/session-ABC-XYZ' already exists",
    });
  });

  it("returns failure when git is not available", async () => {
    simulateExecFileError("spawn git ENOENT");

    const result = await createSessionWorktree(
      "hoop/session-TEST",
      "/tmp/worktree",
    );

    expect(result).toEqual({
      ok: false,
      error: "spawn git ENOENT",
    });
  });
});

describe("removeSessionWorktree", () => {
  let callCount: number;

  beforeEach(() => {
    vi.clearAllMocks();
    callCount = 0;
  });

  it("removes worktree then deletes branch on success", async () => {
    mockExecFile.mockImplementation(
      ((_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        callCount++;
        (cb as (err: Error | null, stdout: string, stderr: string) => void)(null, "", "");
      }) as typeof execFile,
    );

    const result = await removeSessionWorktree("/tmp/wt", "hoop/session-ABC", "/tmp/repo");

    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["worktree", "remove", "--force", "/tmp/wt"],
      { cwd: "/tmp/repo" },
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["branch", "-D", "hoop/session-ABC"],
      { cwd: "/tmp/repo" },
      expect.any(Function),
    );
  });

  it("returns failure when worktree remove fails", async () => {
    simulateExecFileError("exit code 128", "fatal: '/tmp/wt' is not a working tree");

    const result = await removeSessionWorktree("/tmp/wt", "hoop/session-ABC");

    expect(result).toEqual({
      ok: false,
      error: "fatal: '/tmp/wt' is not a working tree",
    });
  });

  it("returns failure when branch delete fails after worktree removal", async () => {
    mockExecFile.mockImplementation(
      ((_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        callCount++;
        if (callCount === 1) {
          (cb as (err: Error | null, stdout: string, stderr: string) => void)(null, "", "");
        } else {
          const err = new Error("exit code 1");
          (cb as (err: Error | null, stdout: string, stderr: string) => void)(
            err,
            "",
            "error: branch 'hoop/session-ABC' not found",
          );
        }
      }) as typeof execFile,
    );

    const result = await removeSessionWorktree("/tmp/wt", "hoop/session-ABC");

    expect(result).toEqual({
      ok: false,
      error: "error: branch 'hoop/session-ABC' not found",
    });
  });
});

describe("pushBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pushes branch to default remote on success", async () => {
    simulateExecFile("");

    const result = await pushBranch("hoop/session-ABC-XYZ");

    expect(result.ok).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "hoop/session-ABC-XYZ"],
      { cwd: undefined },
      expect.any(Function),
    );
  });

  it("uses custom remote when specified", async () => {
    simulateExecFile("");

    await pushBranch("hoop/session-ABC-XYZ", "upstream");

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "upstream", "hoop/session-ABC-XYZ"],
      { cwd: undefined },
      expect.any(Function),
    );
  });

  it("passes cwd to git", async () => {
    simulateExecFile("");

    await pushBranch("hoop/session-ABC-XYZ", "origin", "/some/repo");

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "hoop/session-ABC-XYZ"],
      { cwd: "/some/repo" },
      expect.any(Function),
    );
  });

  it("returns failure when remote is unreachable", async () => {
    simulateExecFileError(
      "exit code 128",
      "fatal: could not read from remote repository",
    );

    const result = await pushBranch("hoop/session-ABC-XYZ");

    expect(result).toEqual({
      ok: false,
      error: "fatal: could not read from remote repository",
    });
  });

  it("returns failure on permission denied", async () => {
    simulateExecFileError(
      "exit code 128",
      "fatal: unable to access 'https://github.com/...': The requested URL returned error: 403",
    );

    const result = await pushBranch("hoop/session-ABC-XYZ");

    expect(result).toEqual({
      ok: false,
      error: "fatal: unable to access 'https://github.com/...': The requested URL returned error: 403",
    });
  });

  it("returns failure when remote does not exist", async () => {
    simulateExecFileError(
      "exit code 128",
      "fatal: 'nonexistent' does not appear to be a git repository",
    );

    const result = await pushBranch("hoop/session-ABC-XYZ", "nonexistent");

    expect(result).toEqual({
      ok: false,
      error: "fatal: 'nonexistent' does not appear to be a git repository",
    });
  });
});

describe("fetchBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches branch from remote on success", async () => {
    simulateExecFile("");

    const result = await fetchBranch("hoop/session-ABC-XYZ");

    expect(result.ok).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "hoop/session-ABC-XYZ"],
      { cwd: undefined },
      expect.any(Function),
    );
  });

  it("uses custom remote when specified", async () => {
    simulateExecFile("");

    await fetchBranch("hoop/session-ABC-XYZ", "upstream");

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["fetch", "upstream", "hoop/session-ABC-XYZ"],
      { cwd: undefined },
      expect.any(Function),
    );
  });

  it("returns failure on permission denied", async () => {
    simulateExecFileError(
      "exit code 128",
      "fatal: could not read from remote repository",
    );

    const result = await fetchBranch("hoop/session-ABC-XYZ");

    expect(result).toEqual({
      ok: false,
      error: "fatal: could not read from remote repository",
    });
  });
});

describe("checkoutBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checks out branch on success", async () => {
    simulateExecFile("Switched to branch 'hoop/session-ABC-XYZ'");

    const result = await checkoutBranch("hoop/session-ABC-XYZ");

    expect(result.ok).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["checkout", "hoop/session-ABC-XYZ"],
      { cwd: undefined },
      expect.any(Function),
    );
  });

  it("returns failure when branch does not exist", async () => {
    simulateExecFileError(
      "exit code 1",
      "error: pathspec 'hoop/session-ABC-XYZ' did not match any file(s) known to git",
    );

    const result = await checkoutBranch("hoop/session-ABC-XYZ");

    expect(result).toEqual({
      ok: false,
      error: "error: pathspec 'hoop/session-ABC-XYZ' did not match any file(s) known to git",
    });
  });
});

describe("computeContentDiff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when filePath contains newline", async () => {
    const result = await computeContentDiff(
      "file\n../../escape.txt",
      "old content",
      "new content",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("forbidden control characters");
    }
  });

  it("returns error when filePath contains carriage return", async () => {
    const result = await computeContentDiff(
      "file\r../../escape.txt",
      "old content",
      "new content",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("forbidden control characters");
    }
  });

  it("returns error when filePath contains null byte", async () => {
    const result = await computeContentDiff(
      "file\0../../escape.txt",
      "old content",
      "new content",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("forbidden control characters");
    }
  });

  it("returns error when filePath has .. path-escape segment", async () => {
    const result = await computeContentDiff(
      "../escape/file.txt",
      "old content",
      "new content",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("path-escape segment");
    }
  });

  it("returns error when filePath has .. in the middle", async () => {
    const result = await computeContentDiff(
      "foo/../../../escape.txt",
      "old content",
      "new content",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("path-escape segment");
    }
  });

  it("accepts valid filePath with legitimate nested paths", async () => {
    simulateExecFile(`diff --git a/src/file.txt b/src/file.txt
index 1234567..abcdef0 100644
--- a/src/file.txt
+++ b/src/file.txt
@@ -1 +1 @@
-old
+new`);

    const result = await computeContentDiff(
      "src/components/Button.tsx",
      "old content",
      "new content",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain("src/components/Button.tsx");
    }
  });

  it("accepts filePath with double-dots in filename (not path-escape)", async () => {
    simulateExecFile(`diff --git a/foo..bar.txt b/foo..bar.txt
index 1234567..abcdef0 100644
--- a/foo..bar.txt
+++ b/foo..bar.txt
@@ -1 +1 @@
-old
+new`);

    const result = await computeContentDiff(
      "foo..bar.txt",
      "old content",
      "new content",
    );

    expect(result.ok).toBe(true);
  });
});
