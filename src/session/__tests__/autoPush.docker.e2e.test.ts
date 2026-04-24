import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSession,
  defaultAdmissionHandler,
  type CreateSessionResult,
  type GitOps,
} from "../createSession.js";
import { destroySession } from "../destroySession.js";
import { SessionStore } from "../session.js";
import {
  getGitRoot,
  createSessionWorktree,
  removeSessionWorktree,
  pushBranch,
  deleteRemoteBranch,
  addAndCommit,
} from "../../git/gitBranch.js";
import { gitSync, createTempRepo, removeTempRepo } from "../../__tests__/helpers/gitTestRepo.js";

const GITEA_CLONE_URL = process.env.GITEA_CLONE_URL;

function makeGitOps(cwd: string): GitOps {
  return {
    getGitRoot: () => getGitRoot(cwd),
    createSessionWorktree: (branch, path) => createSessionWorktree(branch, path, cwd),
    removeSessionWorktree: (path, branch) => removeSessionWorktree(path, branch, cwd),
    pushBranch: (branch) => pushBranch(branch, "origin", cwd),
    deleteRemoteBranch: (branch) => deleteRemoteBranch(branch, "origin", cwd),
    addAndCommit: (msg, worktreeCwd) => addAndCommit(msg, worktreeCwd ?? cwd),
  };
}

describe.skipIf(!GITEA_CLONE_URL)("auto-push on lock release — Gitea remote", () => {
  let repoDir: string;
  let session: CreateSessionResult | undefined;
  let store: SessionStore;

  beforeEach(async () => {
    repoDir = await createTempRepo("hoop-autopush-");
    await writeFile(join(repoDir, "README.md"), "# Test\n");
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "initial"], repoDir);
    gitSync(["remote", "add", "origin", GITEA_CLONE_URL!], repoDir);
    store = new SessionStore();
  });

  afterEach(async () => {
    if (session) {
      try {
        await destroySession({
          sessionCode: session.sessionCode,
          branchName: session.branchName,
          worktreePath: session.worktreePath,
          node: session.node,
          store,
          gitOps: makeGitOps(repoDir),
          drainPendingPush: session.drainPendingPush,
        });
      } catch {}
      session = undefined;
    }
    await removeTempRepo(repoDir);
  });

  it("pushes a commit to Gitea when the lock is released after a file change", async () => {
    session = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: makeGitOps(repoDir),
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    session.acquireLock();

    // Write a file into the session worktree
    await writeFile(join(session.worktreePath, "work.txt"), "changes\n");

    session.releaseLock();

    // Wait for the auto-push chain to complete
    await session.drainPendingPush();

    // Verify: fetch from Gitea and check the remote branch has the commit
    gitSync(["fetch", "origin", session.branchName], repoDir);
    const log = gitSync(
      ["log", "--oneline", "-1", `origin/${session.branchName}`],
      repoDir,
    );
    expect(log).toContain("hoop: sync after lock release");
  });

  it("destroySession completes even when the push fails (wrong credentials)", async () => {
    session = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: makeGitOps(repoDir),
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    // Break the remote credentials so the auto-push will fail
    const badUrl = GITEA_CLONE_URL!.replace(/:([^:@]+)@/, ":BADTOKEN@");
    gitSync(["remote", "set-url", "origin", badUrl], repoDir);

    session.acquireLock();
    await writeFile(join(session.worktreePath, "work.txt"), "changes\n");
    session.releaseLock();

    // destroySession must finish within 15 s even though the push fails
    const result = await Promise.race([
      destroySession({
        sessionCode: session.sessionCode,
        branchName: session.branchName,
        worktreePath: session.worktreePath,
        node: session.node,
        store,
        gitOps: makeGitOps(repoDir),
        drainPendingPush: session.drainPendingPush,
      }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("destroySession timed out")), 15_000),
      ),
    ]);

    // Errors are collected, not thrown
    expect(Array.isArray(result.errors)).toBe(true);
    session = undefined;
  });

  it("drainPendingPush rejects after the configured timeout if the push hangs", async () => {
    let resolveHang!: () => void;
    const hangPromise = new Promise<void>(res => { resolveHang = res; });

    // Use real git ops for the initial session push, then swap to the hanging
    // mock so only the auto-push (triggered by lock release) hangs.
    let blockPush = false;
    const slowGitOps: GitOps = {
      ...makeGitOps(repoDir),
      pushBranch: (branch) =>
        blockPush
          ? hangPromise.then(() => ({ ok: true, value: undefined as never }))
          : pushBranch(branch, "origin", repoDir),
    };

    session = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: slowGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );
    blockPush = true;

    session.acquireLock();
    await writeFile(join(session.worktreePath, "work.txt"), "changes\n");
    session.releaseLock();

    await expect(session.drainPendingPush(500)).rejects.toThrow("timed out");

    resolveHang(); // let the hanging push resolve so resources are freed
  });

  it("consecutive lock releases chain pushes sequentially to Gitea", async () => {
    session = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: makeGitOps(repoDir),
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    for (let i = 1; i <= 3; i++) {
      session.acquireLock();
      await writeFile(join(session.worktreePath, `file${i}.txt`), `edit ${i}\n`);
      session.releaseLock();
    }

    await session.drainPendingPush();

    gitSync(["fetch", "origin", session.branchName], repoDir);
    const log = gitSync(
      ["log", "--oneline", "-3", `origin/${session.branchName}`],
      repoDir,
    );
    // Three consecutive lock releases should produce at most three commits
    // (some may be empty if git found nothing to stage between releases)
    expect(log).toContain("hoop: sync after lock release");
  });
});
