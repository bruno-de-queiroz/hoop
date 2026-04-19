import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  getGitRoot,
  createSessionWorktree,
  computeGitDiff,
  applyGitPatch,
  hashContent,
} from "../gitBranch.js";

function gitSync(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(cwd: string): void {
  gitSync(["init"], cwd);
  gitSync(["config", "user.email", "test@test.com"], cwd);
  gitSync(["config", "user.name", "Test"], cwd);
}

describe("git operations (real)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "hoop-git-e2e-"));
    initRepo(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  describe("getGitRoot", () => {
    it("returns the real repo root", async () => {
      const result = await getGitRoot(repoDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(realpathSync(result.value)).toBe(realpathSync(repoDir));
      }
    });
  });

  describe("createSessionWorktree", () => {
    it("creates a worktree with a real branch", async () => {
      // Need at least one commit for worktree to work
      const filePath = join(repoDir, "init.txt");
      await writeFile(filePath, "init\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "initial"], repoDir);

      const worktreePath = join(repoDir, ".hoop", "sessions", "test-session");
      const result = await createSessionWorktree(
        "hoop/session-test",
        worktreePath,
        repoDir,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Verify the branch was actually created
        const branches = gitSync(["branch", "--list"], repoDir);
        expect(branches).toContain("hoop/session-test");

        // Verify the worktree directory exists with the file
        const content = await readFile(join(result.value, "init.txt"), "utf-8");
        expect(content).toBe("init\n");
      }

      // Cleanup worktree
      gitSync(["worktree", "remove", "--force", worktreePath], repoDir);
    });
  });

  describe("computeGitDiff + applyGitPatch round-trip", () => {
    it("generates a diff that can be applied to reproduce the change", async () => {
      // Setup: create and commit a file
      const filePath = "src/index.ts";
      const originalContent = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
      await mkdir(join(repoDir, "src"), { recursive: true });
      await writeFile(join(repoDir, filePath), originalContent);
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "add index.ts"], repoDir);

      // Modify the file (unstaged change)
      const modifiedContent = "const a = 1;\nconst b = 42;\nconst c = 3;\n";
      await writeFile(join(repoDir, filePath), modifiedContent);

      // Generate diff
      const diffResult = await computeGitDiff(repoDir, filePath);
      expect(diffResult.ok).toBe(true);
      if (!diffResult.ok) return;

      const patch = diffResult.value;
      expect(patch).toContain("-const b = 2;");
      expect(patch).toContain("+const b = 42;");

      // Restore original via git checkout
      gitSync(["checkout", "--", filePath], repoDir);

      // Apply the patch
      const applyResult = await applyGitPatch(repoDir, patch);
      if (!applyResult.ok) {
        throw new Error(`applyGitPatch failed: ${applyResult.error}`);
      }

      // Verify the file content matches the modified version
      const resultContent = await readFile(join(repoDir, filePath), "utf-8");
      expect(resultContent).toBe(modifiedContent);
      expect(hashContent(resultContent)).toBe(hashContent(modifiedContent));
    });

    it("dry-run rejects a patch that does not match current file state", async () => {
      const filePath = "file.txt";
      await writeFile(join(repoDir, filePath), "line1\nline2\nline3\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "add file"], repoDir);

      // Modify and get diff
      await writeFile(join(repoDir, filePath), "line1\nLINE2\nline3\n");
      const diffResult = await computeGitDiff(repoDir, filePath);
      expect(diffResult.ok).toBe(true);
      if (!diffResult.ok) return;

      // Now change the file to something completely different
      await writeFile(join(repoDir, filePath), "completely\ndifferent\ncontent\n");

      // Dry-run should fail because the context doesn't match
      const checkResult = await applyGitPatch(repoDir, diffResult.value, true);
      expect(checkResult.ok).toBe(false);
    });
  });

  describe("hashContent consistency", () => {
    it("hashes match between pre-computed and file-read content", async () => {
      const content = "const x = 42;\n";
      const filePath = join(repoDir, "hash-test.ts");
      await writeFile(filePath, content);

      const fileContent = await readFile(filePath, "utf-8");
      expect(hashContent(content)).toBe(hashContent(fileContent));
    });
  });
});
