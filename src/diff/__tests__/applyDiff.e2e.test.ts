import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { applyFilePatch } from "../applyDiff.js";
import { computeContentDiff, hashContent } from "../../git/gitBranch.js";
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

    // Generate diff from content strings
    const diffResult = await computeContentDiff(filePath, originalContent, modifiedContent);
    expect(diffResult.ok).toBe(true);
    if (!diffResult.ok) return;

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

    // Generate diff from content strings
    const diffResult = await computeContentDiff(filePath, originalContent, modifiedContent);
    expect(diffResult.ok).toBe(true);
    if (!diffResult.ok) return;

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
    const modifiedContent = "version 2\n";

    await writeFile(join(repoDir, filePath), originalContent);
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "initial"], repoDir);

    // Generate a valid patch from content strings
    const diffResult = await computeContentDiff(filePath, originalContent, modifiedContent);
    expect(diffResult.ok).toBe(true);
    if (!diffResult.ok) return;

    // Simulate a concurrent edit: current content differs from what the hash claims
    const staleHash = hashContent("stale content");
    const result = await applyFilePatch(
      repoDir,
      filePath,
      diffResult.value,
      originalContent,
      staleHash,
      hashContent(modifiedContent),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("base-hash-mismatch");
    }
  });

  it("returns patch-failed when patch does not apply to current file state", async () => {
    const filePath = "conflict.txt";
    const originalContent = "line A\nline B\nline C\n";
    const modifiedContent = "line A\nline B modified\nline C\n";

    // Commit a conflicting version so the patch context won't match
    const conflictContent = "line X\nline Y\nline Z\n";
    await writeFile(join(repoDir, filePath), conflictContent);
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "initial"], repoDir);

    // Generate patch from content strings that don't match disk state
    const diffResult = await computeContentDiff(filePath, originalContent, modifiedContent);
    expect(diffResult.ok).toBe(true);
    if (!diffResult.ok) return;

    // Pass the correct hash of current content to bypass base-hash check,
    // but the patch context won't match the file on disk
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
