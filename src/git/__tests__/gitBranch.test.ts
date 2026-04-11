import { describe, it, expect, vi, beforeEach } from "vitest";
import { getGitRoot, createSessionWorktree } from "../gitBranch.js";
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
