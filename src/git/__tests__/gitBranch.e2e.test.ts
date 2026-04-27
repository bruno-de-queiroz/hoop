import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  getGitRoot,
  createSessionWorktree,
  removeSessionWorktree,
  pushBranch,
  fetchBranch,
  checkoutBranch,
  computeContentDiff,
  applyGitPatch,
  addAndCommit,
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

  describe("removeSessionWorktree", () => {
    it("removes worktree and deletes branch", async () => {
      const filePath = join(repoDir, "init.txt");
      await writeFile(filePath, "init\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "initial"], repoDir);

      const worktreePath = join(repoDir, ".hoop", "sessions", "rm-test");
      await createSessionWorktree("hoop/session-rm", worktreePath, repoDir);

      // Branch and worktree exist
      const branchesBefore = gitSync(["branch", "--list"], repoDir);
      expect(branchesBefore).toContain("hoop/session-rm");

      const result = await removeSessionWorktree(worktreePath, "hoop/session-rm", repoDir);
      expect(result.ok).toBe(true);

      // Branch and worktree are gone
      const branchesAfter = gitSync(["branch", "--list"], repoDir);
      expect(branchesAfter).not.toContain("hoop/session-rm");
    });

    it("returns failure for nonexistent worktree path", async () => {
      const filePath = join(repoDir, "init.txt");
      await writeFile(filePath, "init\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "initial"], repoDir);

      const result = await removeSessionWorktree("/tmp/nonexistent-wt", "hoop/session-nope", repoDir);
      expect(result.ok).toBe(false);
    });
  });

  describe("pushBranch", () => {
    let bareRemote: string;
    const worktrees: string[] = [];
    const tempDirs: string[] = [];

    beforeEach(async () => {
      bareRemote = await mkdtemp(join(tmpdir(), "hoop-bare-"));
      gitSync(["init", "--bare"], bareRemote);

      // Every pushBranch test needs at least one commit
      const filePath = join(repoDir, "init.txt");
      await writeFile(filePath, "init\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "initial"], repoDir);
    });

    afterEach(async () => {
      for (const wt of worktrees) {
        try { gitSync(["worktree", "remove", "--force", wt], repoDir); } catch {}
      }
      worktrees.length = 0;
      for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true });
      }
      tempDirs.length = 0;
      await rm(bareRemote, { recursive: true, force: true });
    });

    it("pushes a session branch to a bare remote", async () => {
      gitSync(["remote", "add", "origin", bareRemote], repoDir);

      const worktreePath = join(repoDir, ".hoop", "sessions", "push-test");
      worktrees.push(worktreePath);
      await createSessionWorktree("hoop/session-push", worktreePath, repoDir);

      const result = await pushBranch("hoop/session-push", "origin", repoDir);
      expect(result.ok).toBe(true);

      // Verify the branch exists on the bare remote
      const remoteBranches = gitSync(["branch", "--list"], bareRemote);
      expect(remoteBranches).toContain("hoop/session-push");
    });

    it("allows a peer to fetch and checkout a pushed session branch", async () => {
      gitSync(["remote", "add", "origin", bareRemote], repoDir);

      const worktreePath = join(repoDir, ".hoop", "sessions", "fetch-test");
      worktrees.push(worktreePath);
      await createSessionWorktree("hoop/session-fetch", worktreePath, repoDir);

      // Commit a unique file on the session branch so we can prove checkout
      await writeFile(join(worktreePath, "session-marker.txt"), "session-only\n");
      gitSync(["add", "session-marker.txt"], worktreePath);
      gitSync(["commit", "-m", "session branch commit"], worktreePath);

      await pushBranch("hoop/session-fetch", "origin", repoDir);

      // Peer: clone from bare remote, fetch and checkout the session branch
      const peerDir = join(tmpdir(), `hoop-peer-${Date.now()}`);
      tempDirs.push(peerDir);
      gitSync(["clone", bareRemote, peerDir], repoDir);

      const fetchResult = await fetchBranch("hoop/session-fetch", "origin", peerDir);
      expect(fetchResult.ok).toBe(true);

      const checkoutResult = await checkoutBranch("hoop/session-fetch", peerDir);
      expect(checkoutResult.ok).toBe(true);

      // Verify the peer has the session-branch-only file
      const content = await readFile(join(peerDir, "session-marker.txt"), "utf-8");
      expect(content).toBe("session-only\n");

      // Verify we're on the correct branch
      const currentBranch = gitSync(["rev-parse", "--abbrev-ref", "HEAD"], peerDir);
      expect(currentBranch).toBe("hoop/session-fetch");
    });

    it("returns failure when remote does not exist", async () => {
      const worktreePath = join(repoDir, ".hoop", "sessions", "no-remote");
      worktrees.push(worktreePath);
      await createSessionWorktree("hoop/session-noremote", worktreePath, repoDir);

      const result = await pushBranch("hoop/session-noremote", "origin", repoDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("origin");
      }
    });

    it("returns failure when pushing a nonexistent branch", async () => {
      gitSync(["remote", "add", "origin", bareRemote], repoDir);

      const result = await pushBranch("hoop/session-nonexistent", "origin", repoDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/src refspec|error/i);
      }
    });
  });

  describe("computeContentDiff + applyGitPatch round-trip", () => {
    it("generates a diff from content that can be applied to reproduce the change", async () => {
      const filePath = "src/index.ts";
      const originalContent = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
      const modifiedContent = "const a = 1;\nconst b = 42;\nconst c = 3;\n";

      await mkdir(join(repoDir, "src"), { recursive: true });
      await writeFile(join(repoDir, filePath), originalContent);
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "add index.ts"], repoDir);

      // Generate diff purely from content strings
      const diffResult = await computeContentDiff(filePath, originalContent, modifiedContent);
      expect(diffResult.ok).toBe(true);
      if (!diffResult.ok) return;

      const patch = diffResult.value;
      expect(patch).toContain("-const b = 2;");
      expect(patch).toContain("+const b = 42;");

      // Apply the patch
      const applyResult = await applyGitPatch(repoDir, patch);
      expect(applyResult).toMatchObject({ ok: true });

      // Verify the file content matches the modified version
      const resultContent = await readFile(join(repoDir, filePath), "utf-8");
      expect(resultContent).toBe(modifiedContent);
    });

    it("dry-run rejects a patch that does not match current file state", async () => {
      const filePath = "file.txt";
      const originalContent = "line1\nline2\nline3\n";
      const modifiedContent = "line1\nLINE2\nline3\n";

      await writeFile(join(repoDir, filePath), "completely\ndifferent\ncontent\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "add file"], repoDir);

      // Generate a diff from content that doesn't match what's on disk
      const diffResult = await computeContentDiff(filePath, originalContent, modifiedContent);
      expect(diffResult.ok).toBe(true);
      if (!diffResult.ok) return;

      // Dry-run should fail because the context doesn't match
      const checkResult = await applyGitPatch(repoDir, diffResult.value, { check: true });
      expect(checkResult.ok).toBe(false);
    });
  });

  describe("addAndCommit", () => {
    it("commits staged changes and returns true", async () => {
      await writeFile(join(repoDir, "init.txt"), "init\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "initial"], repoDir);

      await writeFile(join(repoDir, "new-file.txt"), "hello\n");

      const result = await addAndCommit("hoop: test commit", ["new-file.txt"], repoDir);
      expect(result).toEqual({ ok: true, value: true });

      const log = gitSync(["log", "--oneline", "-1"], repoDir);
      expect(log).toContain("hoop: test commit");
    });

    it("returns false when there is nothing to commit", async () => {
      await writeFile(join(repoDir, "init.txt"), "init\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "initial"], repoDir);

      const result = await addAndCommit("hoop: empty", ["init.txt"], repoDir);
      expect(result).toEqual({ ok: true, value: false });
    });

    it("stages deletions and modifications", async () => {
      await writeFile(join(repoDir, "a.txt"), "aaa\n");
      await writeFile(join(repoDir, "b.txt"), "bbb\n");
      gitSync(["add", "."], repoDir);
      gitSync(["commit", "-m", "initial"], repoDir);

      // Modify a.txt, delete b.txt
      await writeFile(join(repoDir, "a.txt"), "modified\n");
      await rm(join(repoDir, "b.txt"));

      const result = await addAndCommit("hoop: modify and delete", ["a.txt", "b.txt"], repoDir);
      expect(result).toEqual({ ok: true, value: true });

      const show = gitSync(["show", "--stat", "--oneline", "HEAD"], repoDir);
      expect(show).toContain("a.txt");
      expect(show).toContain("b.txt");
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
