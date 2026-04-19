import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { computeFileDiff } from "../computeDiff.js";
import { applyFilePatch } from "../applyDiff.js";
import { createTempRepo, removeTempRepo, gitSync } from "../../__tests__/helpers/gitTestRepo.js";

describe("computeFileDiff → applyFilePatch (real git)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo("hoop-computediff-e2e-");
  });

  afterEach(async () => {
    await removeTempRepo(repoDir);
  });

  it("generates a patch from provided content that applies correctly", async () => {
    const filePath = "src/app.ts";
    const oldContent = "export const version = 1;\nexport const name = \"app\";\n";
    const newContent = "export const version = 2;\nexport const name = \"app\";\n";

    // Set up the repo with the original file
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, filePath), oldContent);
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "initial"], repoDir);

    // Generate diff purely from the provided content strings
    const diff = await computeFileDiff(filePath, oldContent, newContent);

    expect(diff.patch).toContain("--- a/src/app.ts");
    expect(diff.patch).toContain("+++ b/src/app.ts");

    // Apply the generated patch to the repo
    const result = await applyFilePatch(
      repoDir,
      filePath,
      diff.patch,
      oldContent,
      diff.baseHash,
      diff.resultHash,
    );

    expect(result.ok).toBe(true);

    // Verify the file on disk matches the expected new content
    const actualContent = await readFile(join(repoDir, filePath), "utf-8");
    expect(actualContent).toBe(newContent);
  });

  it("diffs provided content, not on-disk state", async () => {
    const filePath = "data.txt";
    const bufferOld = "line A\nline B\nline C\n";
    const bufferNew = "line A\nline B modified\nline C\n";
    const diskContent = "line X\nline Y\nline Z\n";

    // Commit disk content that is completely different from the buffer
    await writeFile(join(repoDir, filePath), diskContent);
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "initial with divergent content"], repoDir);

    // computeFileDiff diffs the provided content, not the disk state
    const diff = await computeFileDiff(filePath, bufferOld, bufferNew);

    // Patch reflects the buffer changes, not the disk changes
    expect(diff.patch).toContain("-line B");
    expect(diff.patch).toContain("+line B modified");
    expect(diff.patch).not.toContain("line X");
    expect(diff.patch).not.toContain("line Y");
    expect(diff.patch).not.toContain("line Z");

    // Apply to a fresh repo that starts from bufferOld
    const applyRepo = await createTempRepo("hoop-computediff-apply-");
    try {
      await writeFile(join(applyRepo, filePath), bufferOld);
      gitSync(["add", "."], applyRepo);
      gitSync(["commit", "-m", "start from bufferOld"], applyRepo);

      const result = await applyFilePatch(
        applyRepo,
        filePath,
        diff.patch,
        bufferOld,
        diff.baseHash,
        diff.resultHash,
      );

      expect(result.ok).toBe(true);

      const actualContent = await readFile(join(applyRepo, filePath), "utf-8");
      expect(actualContent).toBe(bufferNew);
    } finally {
      await removeTempRepo(applyRepo);
    }
  });

  it("returns empty patch and matching hashes for identical content", async () => {
    const content = "unchanged content\n";
    const diff = await computeFileDiff("file.txt", content, content);

    expect(diff.patch).toBe("");
    expect(diff.baseHash).toBe(diff.resultHash);
  });
});
