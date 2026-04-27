import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyFilePatch } from "../applyDiff.js";
import * as gitBranch from "../../git/gitBranch.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn() };
});

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

  it("returns result-hash-mismatch and rolls back when patched content hash differs", async () => {
    const content = "hello";
    const baseHash = gitBranch.hashContent(content);

    mockApplyGitPatch
      .mockResolvedValueOnce({ ok: true, value: undefined as never }) // dry-run
      .mockResolvedValueOnce({ ok: true, value: undefined as never }) // actual
      .mockResolvedValueOnce({ ok: true, value: undefined as never }); // reverse

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
    expect(mockApplyGitPatch).toHaveBeenCalledTimes(3);
    expect(mockApplyGitPatch).toHaveBeenNthCalledWith(
      3, "/tmp/worktree", "valid-patch", { reverse: true },
    );
  });

  it("rolls back and returns patch-failed when readFile fails after apply", async () => {
    const content = "hello";
    const baseHash = gitBranch.hashContent(content);

    mockApplyGitPatch
      .mockResolvedValueOnce({ ok: true, value: undefined as never }) // dry-run
      .mockResolvedValueOnce({ ok: true, value: undefined as never }) // actual
      .mockResolvedValueOnce({ ok: true, value: undefined as never }); // reverse

    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

    const result = await applyFilePatch(
      "/tmp/worktree",
      "file.txt",
      "valid-patch",
      content,
      baseHash,
      "some-result-hash",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("patch-failed");
      expect(result.message).toContain("Cannot read patched file");
    }
    expect(mockApplyGitPatch).toHaveBeenCalledTimes(3);
    expect(mockApplyGitPatch).toHaveBeenNthCalledWith(
      3, "/tmp/worktree", "valid-patch", { reverse: true },
    );
  });

  it("rejects path traversal attempts via filePath argument", async () => {
    const content = "hello";
    const baseHash = gitBranch.hashContent(content);

    const result = await applyFilePatch(
      "/tmp/worktree",
      "../../etc/passwd",
      "patch",
      content,
      baseHash,
      "some-hash",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("patch-failed");
      expect(result.message).toContain("Invalid file path");
    }
    expect(mockApplyGitPatch).not.toHaveBeenCalled();
  });

  it("rejects patches with path-traversal in patch headers (+++ b/../../escape)", async () => {
    const content = "hello";
    const baseHash = gitBranch.hashContent(content);

    const maliciousPatch = `--- a/file.txt
+++ b/../../etc/passwd
@@ -1 +1 @@
-hello
+hacked`;

    const result = await applyFilePatch(
      "/tmp/worktree",
      "file.txt",
      maliciousPatch,
      content,
      baseHash,
      "some-hash",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("patch-failed");
      expect(result.message).toContain("path validation failed");
    }
    // applyGitPatch should not be called because validation happens first
    expect(mockApplyGitPatch).not.toHaveBeenCalled();
  });

  it("rejects multi-file patches", async () => {
    const content = "hello";
    const baseHash = gitBranch.hashContent(content);

    const multiFilePatch = `--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-hello
+world
--- a/other.txt
+++ b/other.txt
@@ -1 +1 @@
-foo
+bar`;

    const result = await applyFilePatch(
      "/tmp/worktree",
      "file.txt",
      multiFilePatch,
      content,
      baseHash,
      "some-hash",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("patch-failed");
      expect(result.message).toContain("Multi-file patches not supported");
    }
    expect(mockApplyGitPatch).not.toHaveBeenCalled();
  });

  it("accepts single-file patches with both --- and +++ headers for the same path", async () => {
    const content = "hello";
    const baseHash = gitBranch.hashContent(content);
    const resultContent = "world";
    const resultHash = gitBranch.hashContent(resultContent);

    const singleFilePatch = `--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-hello
+world`;

    mockApplyGitPatch
      .mockResolvedValueOnce({ ok: true, value: undefined as never })
      .mockResolvedValueOnce({ ok: true, value: undefined as never });
    mockReadFile.mockResolvedValueOnce(resultContent);

    const result = await applyFilePatch(
      "/tmp/worktree",
      "file.txt",
      singleFilePatch,
      content,
      baseHash,
      resultHash,
    );

    expect(result.ok).toBe(true);
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
