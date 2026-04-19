import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { applyFilePatch } from "../applyDiff.js";
import { computeGitDiff, hashContent } from "../../git/gitBranch.js";
import { gitSync, createTempRepo, removeTempRepo } from "../../__tests__/helpers/gitTestRepo.js";

describe("applyFilePatch (real git)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo("hoop-applydiff-e2e-");
  });

  afterEach(async () => {
    await removeTempRepo(repoDir);
  });

  it("applies a real patch and verifies result hash matches", async () => {
    const filePath = "src/app.ts";
    const originalContent = "export const version = 1;\nexport const name = \"app\";\n";
    const modifiedContent = "export const version = 2;\nexport const name = \"app\";\n";

    // Create and commit original file
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, filePath), originalContent);
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "initial"], repoDir);

    // Modify, generate diff, then restore
    await writeFile(join(repoDir, filePath), modifiedContent);
    const diffResult = await computeGitDiff(repoDir, filePath);
    expect(diffResult.ok).toBe(true);
    if (!diffResult.ok) return;

    // Restore to original state
    gitSync(["checkout", "--", filePath], repoDir);

    // Apply via applyFilePatch with correct hashes
    const baseHash = hashContent(originalContent);
    const resultHash = hashContent(modifiedContent);
    const result = await applyFilePatch(
      repoDir,
      filePath,
      diffResult.value,
      originalContent,
      baseHash,
      resultHash,
    );

    expect(result.ok).toBe(true);

    // Double-check the file on disk
    const actualContent = await readFile(join(repoDir, filePath), "utf-8");
    expect(actualContent).toBe(modifiedContent);
  });

  it("returns result-hash-mismatch when expected hash is wrong", async () => {
    const filePath = "file.txt";
    const originalContent = "hello\n";
    const modifiedContent = "hello world\n";

    await writeFile(join(repoDir, filePath), originalContent);
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "initial"], repoDir);

    // Generate a real patch
    await writeFile(join(repoDir, filePath), modifiedContent);
    const diffResult = await computeGitDiff(repoDir, filePath);
    expect(diffResult.ok).toBe(true);
    if (!diffResult.ok) return;

    // Restore
    gitSync(["checkout", "--", filePath], repoDir);

    const baseHash = hashContent(originalContent);
    const wrongResultHash = hashContent("not the real result");
    const result = await applyFilePatch(
      repoDir,
      filePath,
      diffResult.value,
      originalContent,
      baseHash,
      wrongResultHash,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("result-hash-mismatch");
    }
  });

  it("returns base-hash-mismatch when file has been modified since hash was computed", async () => {
    const filePath = "data.txt";
    const originalContent = "version 1\n";

    await writeFile(join(repoDir, filePath), originalContent);
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "initial"], repoDir);

    // Generate a valid patch
    await writeFile(join(repoDir, filePath), "version 2\n");
    const diffResult = await computeGitDiff(repoDir, filePath);
    expect(diffResult.ok).toBe(true);
    if (!diffResult.ok) return;

    gitSync(["checkout", "--", filePath], repoDir);

    // Simulate a concurrent edit: current content differs from what the hash claims
    const staleHash = hashContent("stale content");
    const result = await applyFilePatch(
      repoDir,
      filePath,
      diffResult.value,
      originalContent,
      staleHash,
      hashContent("version 2\n"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("base-hash-mismatch");
    }
  });

  it("returns patch-failed when patch does not apply to current file state", async () => {
    const filePath = "conflict.txt";
    const originalContent = "line A\nline B\nline C\n";

    await writeFile(join(repoDir, filePath), originalContent);
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "initial"], repoDir);

    // Generate patch for one change
    await writeFile(join(repoDir, filePath), "line A\nline B modified\nline C\n");
    const diffResult = await computeGitDiff(repoDir, filePath);
    expect(diffResult.ok).toBe(true);
    if (!diffResult.ok) return;

    // Instead of restoring, make a conflicting change
    const conflictContent = "line X\nline Y\nline Z\n";
    await writeFile(join(repoDir, filePath), conflictContent);
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "conflicting change"], repoDir);

    // Attempt to apply the old patch — content has changed, base hash won't match
    // But we'll pass the correct hash of current content to bypass base-hash check
    const baseHash = hashContent(conflictContent);
    const result = await applyFilePatch(
      repoDir,
      filePath,
      diffResult.value,
      conflictContent,
      baseHash,
      hashContent("doesn't matter"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("patch-failed");
    }
  });
});
