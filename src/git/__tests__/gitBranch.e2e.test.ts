import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  getGitRoot,
  createSessionWorktree,
  pushBranch,
  fetchBranch,
  computeGitDiff,
  applyGitPatch,
  hashContent,
} from "../gitBranch.js";
import { gitSync, createTempRepo, removeTempRepo } from "../../__tests__/helpers/gitTestRepo.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("git operations (real)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo("hoop-git-e2e-");
  });

  afterEach(async () => {
    await removeTempRepo(repoDir);
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

        // Cleanup worktree
        gitSync(["worktree", "remove", "--force", worktreePath], repoDir);
      }
    });
  });

  describe("pushBranch", () => {
    let bareRemote: string;

    beforeEach(async () => {
      bareRemote = await mkdtemp(join(tmpdir(), "hoop-bare-"));
      gitSync(["init", "--bare"], bareRemote);
    });

    afterEach(async () => {
      await rm(bareRemote, { recursive: true, force: true });
    });

    it("pushes a session branch to a bare remote", async () => {
      const filePath = join(repoDir, "init.txt");
      await writeFile(filePath, "init\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "initial"], repoDir);
      gitSync(["remote", "add", "origin", bareRemote], repoDir);

      const worktreePath = join(repoDir, ".hoop", "sessions", "push-test");
      await createSessionWorktree("hoop/session-push", worktreePath, repoDir);

      const result = await pushBranch("hoop/session-push", "origin", repoDir);
      expect(result.ok).toBe(true);

      // Verify the branch exists on the bare remote
      const remoteBranches = gitSync(["branch", "--list"], bareRemote);
      expect(remoteBranches).toContain("hoop/session-push");

      gitSync(["worktree", "remove", "--force", worktreePath], repoDir);
    });

    it("allows a peer to fetch a pushed session branch", async () => {
      // Host: create repo, commit, add remote, create worktree, push
      const filePath = join(repoDir, "init.txt");
      await writeFile(filePath, "init\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "initial"], repoDir);
      gitSync(["remote", "add", "origin", bareRemote], repoDir);

      const worktreePath = join(repoDir, ".hoop", "sessions", "fetch-test");
      await createSessionWorktree("hoop/session-fetch", worktreePath, repoDir);
      await pushBranch("hoop/session-fetch", "origin", repoDir);

      // Peer: clone from bare remote, fetch the session branch
      const peerDir = await mkdtemp(join(tmpdir(), "hoop-peer-"));
      gitSync(["clone", bareRemote, peerDir], peerDir);

      const fetchResult = await fetchBranch("hoop/session-fetch", "origin", peerDir);
      expect(fetchResult.ok).toBe(true);

      await rm(peerDir, { recursive: true, force: true });
      gitSync(["worktree", "remove", "--force", worktreePath], repoDir);
    });

    it("returns failure when remote does not exist", async () => {
      const filePath = join(repoDir, "init.txt");
      await writeFile(filePath, "init\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "initial"], repoDir);

      const worktreePath = join(repoDir, ".hoop", "sessions", "no-remote");
      await createSessionWorktree("hoop/session-noremote", worktreePath, repoDir);

      const result = await pushBranch("hoop/session-noremote", "origin", repoDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("origin");
      }

      gitSync(["worktree", "remove", "--force", worktreePath], repoDir);
    });

    it("returns failure when pushing a nonexistent branch", async () => {
      const filePath = join(repoDir, "init.txt");
      await writeFile(filePath, "init\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "initial"], repoDir);
      gitSync(["remote", "add", "origin", bareRemote], repoDir);

      const result = await pushBranch("hoop/session-nonexistent", "origin", repoDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/src refspec|error/i);
      }
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
      expect(applyResult).toMatchObject({ ok: true });

      // Verify the file content matches the modified version
      const resultContent = await readFile(join(repoDir, filePath), "utf-8");
      expect(resultContent).toBe(modifiedContent);
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
      const checkResult = await applyGitPatch(repoDir, diffResult.value, { check: true });
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
