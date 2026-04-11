import { describe, it, expect, vi, beforeEach } from "vitest";
import { getGitRoot, createSessionWorktree, fetchBranch, checkoutBranch } from "../gitBranch.js";
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
