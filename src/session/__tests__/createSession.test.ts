import { describe, it, expect, afterEach, vi } from "vitest";
import { createSession, stubGitOps, defaultAdmissionHandler, type CreateSessionResult, type GitOps } from "../createSession.js";
import { SessionStore } from "../session.js";
import { validateSessionCode } from "../sessionCode.js";

describe("createSession", () => {
  let result: CreateSessionResult | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await result?.node.stop();
    result = undefined;
  });

  it("creates a session with valid code, starts node, and updates store", async () => {
    const store = new SessionStore();

    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    expect(validateSessionCode(result.sessionCode)).toBe(true);
    expect(result.executionTarget).toBe("host-only");
    expect(result.passwordProtected).toBe(false);
    expect(result.peerId).toBeTruthy();
    expect(result.listenAddresses.length).toBeGreaterThan(0);
    expect(result.node.getState()).toBe("listening");

    const session = store.get(result.sessionCode);
    expect(session).toBeDefined();
    expect(session!.peerId).toBe(result.peerId);
    expect(session!.listenAddresses).toEqual(result.listenAddresses);
  }, 30_000);

  it("hashes password when provided", async () => {
    const store = new SessionStore();

    result = await createSession(
      {
        password: "secret123",
        executionTarget: "proponent-side",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    expect(result.passwordProtected).toBe(true);
    expect(result.executionTarget).toBe("proponent-side");

    const session = store.get(result.sessionCode);
    expect(session!.passwordHash).toBeDefined();
    expect(session!.passwordHash).not.toBe("secret123");
  }, 30_000);

  it("creates session without password", async () => {
    const store = new SessionStore();

    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    expect(result.passwordProtected).toBe(false);

    const session = store.get(result.sessionCode);
    expect(session!.passwordHash).toBeUndefined();
  }, 30_000);

  it("creates worktree, pushes branch, and stores branch info on successful git init", async () => {
    const mockGitOps: GitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo" }),
      createSessionWorktree: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo/.hoop/sessions/MOCK" }),
      removeSessionWorktree: vi.fn(),
      pushBranch: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      deleteRemoteBranch: vi.fn(),
      addAndCommit: vi.fn().mockResolvedValue({ ok: true, value: false }),
    };

    const store = new SessionStore();

    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: mockGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    // Branch name includes hostId for uniqueness
    expect(result.branchName).toMatch(/^hoop\/session-.+-/);
    expect(result.branchName).toContain(result.sessionCode);
    expect(result.worktreePath).toBe("/tmp/fakerepo/.hoop/sessions/MOCK");
    expect(mockGitOps.createSessionWorktree).toHaveBeenCalledWith(
      result.branchName,
      expect.stringContaining(result.sessionCode),
    );
    expect(mockGitOps.pushBranch).toHaveBeenCalledWith(result.branchName);

    const session = store.get(result.sessionCode);
    expect(session!.branchName).toBe(result.branchName);
    expect(session!.worktreePath).toBe(result.worktreePath);
  }, 30_000);

  it("throws and cleans up store when git root is not available", async () => {
    const mockGitOps: GitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: false, error: "fatal: not a git repository" }),
      createSessionWorktree: vi.fn(),
      removeSessionWorktree: vi.fn(),
      pushBranch: vi.fn(),
      deleteRemoteBranch: vi.fn(),
      addAndCommit: vi.fn().mockResolvedValue({ ok: true, value: false }),
    };

    const store = new SessionStore();

    await expect(
      createSession(
        {
          executionTarget: "host-only",
          networkConfig: { transportMode: "test" },
          gitOps: mockGitOps,
          onAdmissionRequest: defaultAdmissionHandler,
        },
        store,
      ),
    ).rejects.toThrow("Git repository required");

    expect(mockGitOps.createSessionWorktree).not.toHaveBeenCalled();
    // Store should be cleaned up
    expect([...store["sessions"].values()]).toHaveLength(0);
  }, 30_000);

  it("throws and cleans up store when worktree creation fails", async () => {
    const mockGitOps: GitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo" }),
      createSessionWorktree: vi.fn().mockResolvedValue({ ok: false, error: "branch already exists" }),
      removeSessionWorktree: vi.fn(),
      pushBranch: vi.fn(),
      deleteRemoteBranch: vi.fn(),
      addAndCommit: vi.fn().mockResolvedValue({ ok: true, value: false }),
    };

    const store = new SessionStore();

    await expect(
      createSession(
        {
          executionTarget: "host-only",
          networkConfig: { transportMode: "test" },
          gitOps: mockGitOps,
          onAdmissionRequest: defaultAdmissionHandler,
        },
        store,
      ),
    ).rejects.toThrow("Failed to create session worktree");

    expect(mockGitOps.pushBranch).not.toHaveBeenCalled();
    expect([...store["sessions"].values()]).toHaveLength(0);
  }, 30_000);

  it("throws, cleans up worktree, and removes store entry when push fails", async () => {
    const mockGitOps: GitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo" }),
      createSessionWorktree: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo/.hoop/sessions/MOCK" }),
      removeSessionWorktree: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      pushBranch: vi.fn().mockResolvedValue({ ok: false, error: "fatal: could not read from remote repository" }),
      deleteRemoteBranch: vi.fn(),
      addAndCommit: vi.fn().mockResolvedValue({ ok: true, value: false }),
    };

    const store = new SessionStore();

    await expect(
      createSession(
        {
          executionTarget: "host-only",
          networkConfig: { transportMode: "test" },
          gitOps: mockGitOps,
          onAdmissionRequest: defaultAdmissionHandler,
        },
        store,
      ),
    ).rejects.toThrow("Failed to push session branch");

    expect(mockGitOps.createSessionWorktree).toHaveBeenCalled();
    expect(mockGitOps.pushBranch).toHaveBeenCalled();
    expect(mockGitOps.removeSessionWorktree).toHaveBeenCalledWith(
      "/tmp/fakerepo/.hoop/sessions/MOCK",
      expect.stringMatching(/^hoop\/session-/),
    );
    expect([...store["sessions"].values()]).toHaveLength(0);
  }, 30_000);

  it("surfaces cleanup error in thrown message when both push and cleanup fail", async () => {
    const mockGitOps: GitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo" }),
      createSessionWorktree: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo/.hoop/sessions/MOCK" }),
      removeSessionWorktree: vi.fn().mockResolvedValue({ ok: false, error: "worktree locked" }),
      pushBranch: vi.fn().mockResolvedValue({ ok: false, error: "remote unreachable" }),
      deleteRemoteBranch: vi.fn(),
      addAndCommit: vi.fn().mockResolvedValue({ ok: true, value: false }),
    };

    const store = new SessionStore();

    await expect(
      createSession(
        {
          executionTarget: "host-only",
          networkConfig: { transportMode: "test" },
          gitOps: mockGitOps,
          onAdmissionRequest: defaultAdmissionHandler,
        },
        store,
      ),
    ).rejects.toThrow(/remote unreachable.*cleanup also failed.*worktree locked/);

    expect([...store["sessions"].values()]).toHaveLength(0);
  }, 30_000);

  it("publishUpdate centralizes accumulation, replay buffering, and notifications", async () => {
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
    );

    const update = {
      type: "metadata-update",
      peerId: "peer-1",
      key: "theme",
      value: "dark",
      timestamp: 1_000,
    } as const;
    const observed: Array<{ seqNo: number; update: typeof update }> = [];
    result.onPublishedUpdate((publication) => {
      observed.push({ seqNo: publication.seqNo, update: publication.update as typeof update });
    });

    const seqNo = result.publishUpdate(update);

    expect(seqNo).toBe(1);
    expect(result.accumulator.getMetadata("theme")).toEqual(update);
    expect(result.replayBuffer.replaySince(0)).toEqual([{ seqNo: 1, update }]);
    expect(observed).toEqual([{ seqNo: 1, update }]);
  }, 30_000);

  it("publishUpdate logs observer errors and continues notifying later observers", async () => {
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
    );

    const boom = new Error("observer failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const secondObserver = vi.fn();

    result.onPublishedUpdate(() => {
      throw boom;
    });
    result.onPublishedUpdate(secondObserver);

    const update = {
      type: "metadata-update",
      peerId: "peer-1",
      key: "language",
      value: "typescript",
      timestamp: 2_000,
    } as const;

    const seqNo = result.publishUpdate(update);

    expect(seqNo).toBe(1);
    expect(result.accumulator.getMetadata("language")).toEqual(update);
    expect(secondObserver).toHaveBeenCalledWith({ seqNo: 1, update, excludePeerId: undefined });
    expect(consoleError).toHaveBeenCalledWith("[hoop] publishUpdate observer error:", boom);
  }, 30_000);

  it("unsubscribe stops published update delivery", async () => {
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
    );

    const observer = vi.fn();
    const unsubscribe = result.onPublishedUpdate(observer);

    result.publishUpdate({
      type: "metadata-update",
      peerId: "peer-1",
      key: "first",
      value: true,
      timestamp: 1_000,
    });
    unsubscribe();
    result.publishUpdate({
      type: "metadata-update",
      peerId: "peer-1",
      key: "second",
      value: true,
      timestamp: 2_000,
    });

    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith({
      seqNo: 1,
      update: {
        type: "metadata-update",
        peerId: "peer-1",
        key: "first",
        value: true,
        timestamp: 1_000,
      },
      excludePeerId: undefined,
    });
  }, 30_000);

  it("publishUpdate notifies onLockChange for lock updates", async () => {
    const onLockChange = vi.fn();
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
        onLockChange,
      },
    );

    result.publishUpdate({
      type: "lock-acquire",
      peerId: "peer-1",
      timestamp: 1_000,
    });
    result.publishUpdate({
      type: "lock-release",
      peerId: "peer-1",
      timestamp: 2_000,
    });

    expect(onLockChange).toHaveBeenCalledTimes(2);
    expect(onLockChange).toHaveBeenNthCalledWith(1, {
      holderPeerId: "peer-1",
      acquiredAt: 1_000,
      status: "busy",
    });
    expect(onLockChange).toHaveBeenNthCalledWith(2, {
      holderPeerId: null,
      acquiredAt: null,
      status: "free",
    });
  }, 30_000);

  it("lock-release triggers addAndCommit and pushBranch", async () => {
    const addAndCommit = vi.fn().mockResolvedValue({ ok: true, value: true });
    const pushBranch = vi.fn().mockResolvedValue({ ok: true, value: undefined as never });
    const mockGitOps: GitOps = {
      ...stubGitOps,
      addAndCommit,
      pushBranch,
    };
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: mockGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
    );

    // Reset after session creation's initial push
    pushBranch.mockClear();

    result.publishUpdate({
      type: "lock-acquire",
      peerId: "peer-1",
      timestamp: 1_000,
    });
    result.publishUpdate({
      type: "lock-release",
      peerId: "peer-1",
      timestamp: 2_000,
    });

    // Wait for the async push to complete
    await vi.waitFor(() => {
      expect(addAndCommit).toHaveBeenCalledTimes(1);
    });

    expect(addAndCommit).toHaveBeenCalledWith(
      "hoop: sync after lock release by peer-1",
      ["."],
      result.worktreePath,
    );
    expect(pushBranch).toHaveBeenCalledTimes(1);
    expect(pushBranch).toHaveBeenCalledWith(result.branchName);
  }, 30_000);

  it("lock-release skips push when nothing was committed", async () => {
    const pushBranch = vi.fn().mockResolvedValue({ ok: true, value: undefined as never });
    const mockGitOps: GitOps = {
      ...stubGitOps,
      addAndCommit: vi.fn().mockResolvedValue({ ok: true, value: false }),
      pushBranch,
    };
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: mockGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
    );

    // Reset after session creation's initial push
    pushBranch.mockClear();

    result.publishUpdate({
      type: "lock-acquire",
      peerId: "peer-1",
      timestamp: 1_000,
    });
    result.publishUpdate({
      type: "lock-release",
      peerId: "peer-1",
      timestamp: 2_000,
    });

    await vi.waitFor(() => {
      expect(mockGitOps.addAndCommit).toHaveBeenCalledTimes(1);
    });

    expect(pushBranch).not.toHaveBeenCalled();
  }, 30_000);

  it("push failure does not block subsequent lock operations", async () => {
    const addAndCommit = vi.fn().mockResolvedValue({ ok: true, value: true });
    const pushBranch = vi.fn().mockResolvedValue({ ok: true, value: undefined as never });
    const mockGitOps: GitOps = {
      ...stubGitOps,
      addAndCommit,
      pushBranch,
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: mockGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
    );

    // Reset after session creation's initial push, then fail subsequent pushes
    pushBranch.mockClear();
    pushBranch.mockResolvedValue({ ok: false, error: "remote unavailable" });

    result.publishUpdate({
      type: "lock-acquire",
      peerId: "peer-1",
      timestamp: 1_000,
    });
    result.publishUpdate({
      type: "lock-release",
      peerId: "peer-1",
      timestamp: 2_000,
    });

    await vi.waitFor(() => {
      expect(pushBranch).toHaveBeenCalledTimes(1);
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[hoop] auto-push failed:",
      "remote unavailable",
    );

    // Lock can still be acquired after failed push
    const acquire = result.acquireLock("peer-2");
    expect(acquire.acquired).toBe(true);
    consoleSpy.mockRestore();
  }, 30_000);

  it("addAndCommit failure is logged", async () => {
    const pushBranch = vi.fn().mockResolvedValue({ ok: true, value: undefined as never });
    const mockGitOps: GitOps = {
      ...stubGitOps,
      addAndCommit: vi.fn().mockResolvedValue({ ok: false, error: "index.lock exists" }),
      pushBranch,
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: mockGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
    );

    // Reset after session creation's initial push
    pushBranch.mockClear();

    result.publishUpdate({
      type: "lock-acquire",
      peerId: "peer-1",
      timestamp: 1_000,
    });
    result.publishUpdate({
      type: "lock-release",
      peerId: "peer-1",
      timestamp: 2_000,
    });

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        "[hoop] auto-commit failed:",
        "index.lock exists",
      );
    });

    // pushBranch should not be called when addAndCommit fails
    expect(pushBranch).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  }, 30_000);

  it("consecutive rapid lock-releases chain sequentially", async () => {
    const callOrder: string[] = [];
    let resolveFirst!: (v: { ok: true; value: true }) => void;
    let resolveSecond!: (v: { ok: true; value: true }) => void;
    const addAndCommit = vi.fn()
      .mockImplementationOnce(() => {
        callOrder.push("commit-start:1");
        return new Promise((resolve) => {
          resolveFirst = () => { callOrder.push("commit-end:1"); resolve({ ok: true, value: true }); };
        });
      })
      .mockImplementationOnce(() => {
        callOrder.push("commit-start:2");
        return new Promise((resolve) => {
          resolveSecond = () => { callOrder.push("commit-end:2"); resolve({ ok: true, value: true }); };
        });
      });
    const pushBranch = vi.fn().mockResolvedValue({ ok: true, value: undefined as never });
    const mockGitOps: GitOps = {
      ...stubGitOps,
      addAndCommit,
      pushBranch,
    };
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: mockGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
    );

    // Reset after session creation's initial push
    pushBranch.mockClear();

    // First lock cycle
    result.publishUpdate({ type: "lock-acquire", peerId: "peer-1", timestamp: 1_000 });
    result.publishUpdate({ type: "lock-release", peerId: "peer-1", timestamp: 2_000 });

    // Second lock cycle fires immediately — before first push resolves
    result.publishUpdate({ type: "lock-acquire", peerId: "peer-2", timestamp: 3_000 });
    result.publishUpdate({ type: "lock-release", peerId: "peer-2", timestamp: 4_000 });

    // First commit started, second must not have started yet (chaining)
    await vi.waitFor(() => { expect(callOrder).toContain("commit-start:1"); });
    expect(callOrder).not.toContain("commit-start:2");

    // Resolve first — second should start only after first completes
    resolveFirst({ ok: true, value: true });
    await vi.waitFor(() => { expect(callOrder).toContain("commit-start:2"); });

    // Resolve second
    resolveSecond({ ok: true, value: true });
    await vi.waitFor(() => { expect(pushBranch).toHaveBeenCalledTimes(2); });

    // The key assertion: strict sequential ordering
    expect(callOrder).toEqual([
      "commit-start:1",
      "commit-end:1",
      "commit-start:2",
      "commit-end:2",
    ]);
  }, 30_000);

  it("drainPendingPush rejects when push exceeds timeout", async () => {
    const pushBranch = vi.fn().mockResolvedValue({ ok: true, value: undefined as never });
    const mockGitOps: GitOps = {
      ...stubGitOps,
      addAndCommit: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      pushBranch,
    };
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: mockGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
    );

    result.publishUpdate({ type: "lock-acquire", peerId: "peer-1", timestamp: 1_000 });
    result.publishUpdate({ type: "lock-release", peerId: "peer-1", timestamp: 2_000 });

    await expect(result.drainPendingPush(50)).rejects.toThrow("timed out");
  }, 30_000);

  it("forceReleaseLock releases another peer's lock", async () => {
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
    );

    const acquireResult = result.acquireLock("other-peer");
    expect(acquireResult.acquired).toBe(true);

    const forceResult = result.forceReleaseLock();
    expect(forceResult).toEqual({ released: true, holder: null, seqNo: expect.any(Number) });

    const lockStatus = result.getLockStatus();
    expect(lockStatus.status).toBe("free");
    expect(lockStatus.holderPeerId).toBeNull();
  }, 30_000);

  it("forceReleaseLock returns released:false when lock is free", async () => {
    result = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
    );

    const forceResult = result.forceReleaseLock();
    expect(forceResult).toEqual({ released: false, holder: null });
  }, 30_000);
});
