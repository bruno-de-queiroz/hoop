import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyFilePatch } from "../applyDiff.js";
import * as gitBranch from "../../git/gitBranch.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../../git/gitBranch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../git/gitBranch.js")>();
  return {
    ...actual,
    applyGitPatch: vi.fn(),
  };
});

import { readFile } from "node:fs/promises";

const mockApplyGitPatch = vi.mocked(gitBranch.applyGitPatch);
const mockReadFile = vi.mocked(readFile);

describe("applyFilePatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns base-hash-mismatch when current content hash differs", async () => {
    const result = await applyFilePatch(
      "/tmp/worktree",
      "file.txt",
      "some-patch",
      "current content",
      "wrong-expected-hash",
      "some-result-hash",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("base-hash-mismatch");
    }
  });

  it("returns patch-failed when dry-run fails", async () => {
    const content = "hello";
    const baseHash = gitBranch.hashContent(content);

    mockApplyGitPatch.mockResolvedValueOnce({
      ok: false,
      error: "error: patch does not apply",
    });

    const result = await applyFilePatch(
      "/tmp/worktree",
      "file.txt",
      "bad-patch",
      content,
      baseHash,
      "some-result-hash",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("patch-failed");
    }
  });

  it("returns patch-failed when apply fails after dry-run succeeds", async () => {
    const content = "hello";
    const baseHash = gitBranch.hashContent(content);

    mockApplyGitPatch
      .mockResolvedValueOnce({ ok: true, value: undefined as never }) // dry-run
      .mockResolvedValueOnce({ ok: false, error: "apply error" }); // actual

    const result = await applyFilePatch(
      "/tmp/worktree",
      "file.txt",
      "patch",
      content,
      baseHash,
      "some-result-hash",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("patch-failed");
    }
  });

  it("returns result-hash-mismatch when patched content hash differs", async () => {
    const content = "hello";
    const baseHash = gitBranch.hashContent(content);

    mockApplyGitPatch
      .mockResolvedValueOnce({ ok: true, value: undefined as never }) // dry-run
      .mockResolvedValueOnce({ ok: true, value: undefined as never }); // actual

    mockReadFile.mockResolvedValueOnce("unexpected result content");

    const result = await applyFilePatch(
      "/tmp/worktree",
      "file.txt",
      "valid-patch",
      content,
      baseHash,
      "expected-result-hash",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("result-hash-mismatch");
    }
  });

  it("returns success when all checks pass including result hash", async () => {
    const content = "hello";
    const baseHash = gitBranch.hashContent(content);
    const resultContent = "hello world";
    const resultHash = gitBranch.hashContent(resultContent);

    mockApplyGitPatch
      .mockResolvedValueOnce({ ok: true, value: undefined as never }) // dry-run
      .mockResolvedValueOnce({ ok: true, value: undefined as never }); // actual

    mockReadFile.mockResolvedValueOnce(resultContent);

    const result = await applyFilePatch(
      "/tmp/worktree",
      "file.txt",
      "valid-patch",
      content,
      baseHash,
      resultHash,
    );

    expect(result.ok).toBe(true);
  });
});
