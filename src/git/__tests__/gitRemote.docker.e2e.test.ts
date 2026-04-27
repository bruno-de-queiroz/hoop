import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  createSessionWorktree,
  pushBranch,
  fetchBranch,
  checkoutBranch,
  deleteRemoteBranch,
  addAndCommit,
} from "../gitBranch.js";
import { gitSync, createTempRepo, removeTempRepo } from "../../__tests__/helpers/gitTestRepo.js";

const GITEA_CLONE_URL = process.env.GITEA_CLONE_URL;

describe.skipIf(!GITEA_CLONE_URL)("git remote — Gitea HTTP", () => {
  let repoDir: string;
  const worktrees: string[] = [];
  const tempDirs: string[] = [];

  const uid = () => randomBytes(3).toString("hex");

  beforeEach(async () => {
    repoDir = await createTempRepo("hoop-gitea-");
    await writeFile(join(repoDir, "init.txt"), "init\n");
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "initial"], repoDir);
    gitSync(["remote", "add", "origin", GITEA_CLONE_URL!], repoDir);
  });

  afterEach(async () => {
    for (const wt of worktrees.splice(0)) {
      try { gitSync(["worktree", "remove", "--force", wt], repoDir); } catch {}
    }
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
    await removeTempRepo(repoDir);
  });

  it("pushes a branch to Gitea via HTTP and the branch appears on the remote", async () => {
    const branch = `hoop/docker-push-${uid()}`;
    const wtPath = join(repoDir, ".hoop", "sessions", branch);
    worktrees.push(wtPath);
    await createSessionWorktree(branch, wtPath, repoDir);

    const result = await pushBranch(branch, "origin", repoDir);
    expect(result.ok).toBe(true);

    const lsRemote = gitSync(["ls-remote", "--heads", "origin", branch], repoDir);
    expect(lsRemote).toContain(branch);
  });

  it("fetchBranch retrieves a commit pushed by another clone", async () => {
    const branch = `hoop/docker-fetch-${uid()}`;
    const wtPath = join(repoDir, ".hoop", "sessions", branch);
    worktrees.push(wtPath);
    await createSessionWorktree(branch, wtPath, repoDir);

    await writeFile(join(wtPath, "marker.txt"), "host-marker\n");
    await addAndCommit("hoop: marker commit", ["marker.txt"], wtPath);
    await pushBranch(branch, "origin", repoDir);

    // Peer clones and fetches the session branch
    const peerDir = await mkdtemp(join(tmpdir(), "hoop-peer-"));
    tempDirs.push(peerDir);
    gitSync(["clone", GITEA_CLONE_URL!, peerDir], repoDir);

    const fetchResult = await fetchBranch(branch, "origin", peerDir);
    expect(fetchResult.ok).toBe(true);

    const checkoutResult = await checkoutBranch(branch, peerDir);
    expect(checkoutResult.ok).toBe(true);

    const content = await readFile(join(peerDir, "marker.txt"), "utf-8");
    expect(content).toBe("host-marker\n");
  });

  it("deleteRemoteBranch removes the branch from Gitea", async () => {
    const branch = `hoop/docker-delete-${uid()}`;
    const wtPath = join(repoDir, ".hoop", "sessions", branch);
    worktrees.push(wtPath);
    await createSessionWorktree(branch, wtPath, repoDir);
    await pushBranch(branch, "origin", repoDir);

    const before = gitSync(["ls-remote", "--heads", "origin", branch], repoDir);
    expect(before).toContain(branch);

    const deleteResult = await deleteRemoteBranch(branch, "origin", repoDir);
    expect(deleteResult.ok).toBe(true);

    const after = gitSync(["ls-remote", "--heads", "origin", branch], repoDir);
    expect(after).not.toContain(branch);
  });

  it("pushBranch returns an error tuple on authentication failure", async () => {
    const branch = `hoop/docker-authfail-${uid()}`;
    const wtPath = join(repoDir, ".hoop", "sessions", branch);
    worktrees.push(wtPath);
    await createSessionWorktree(branch, wtPath, repoDir);

    // Swap correct token for a wrong one
    const badUrl = GITEA_CLONE_URL!.replace(/:([^:@]+)@/, ":INVALIDTOKEN@");
    gitSync(["remote", "set-url", "origin", badUrl], repoDir);

    const result = await pushBranch(branch, "origin", repoDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/authentication|credential|403|fatal/i);
    }
  });

  it("pushBranch returns an error when the remote has diverged (non-fast-forward)", async () => {
    const branch = `hoop/docker-nff-${uid()}`;
    const wtPath = join(repoDir, ".hoop", "sessions", branch);
    worktrees.push(wtPath);
    await createSessionWorktree(branch, wtPath, repoDir);
    await pushBranch(branch, "origin", repoDir);

    // A second clone advances the remote branch ahead
    const clone2 = await mkdtemp(join(tmpdir(), "hoop-clone2-"));
    tempDirs.push(clone2);
    gitSync(["clone", GITEA_CLONE_URL!, clone2], repoDir);
    await fetchBranch(branch, "origin", clone2);
    await checkoutBranch(branch, clone2);
    await writeFile(join(clone2, "advance.txt"), "ahead\n");
    gitSync(["add", "."], clone2);
    gitSync(["commit", "-m", "advance remote"], clone2);
    await pushBranch(branch, "origin", clone2);

    // Original clone makes a diverging commit and tries to push
    await writeFile(join(wtPath, "diverge.txt"), "diverged\n");
    gitSync(["add", "."], wtPath);
    gitSync(["commit", "-m", "diverging commit"], wtPath);

    const result = await pushBranch(branch, "origin", repoDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/rejected|non-fast-forward|fetch first/i);
    }
  });
});
