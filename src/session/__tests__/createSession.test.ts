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

    expect(result.branchName).toBe(`hoop/session-${result.sessionCode}`);
    expect(result.worktreePath).toBeTruthy();
    expect(mockGitOps.createSessionWorktree).toHaveBeenCalledWith(
      `hoop/session-${result.sessionCode}`,
      expect.stringContaining(result.sessionCode),
    );
    expect(mockGitOps.pushBranch).toHaveBeenCalledWith(
      `hoop/session-${result.sessionCode}`,
    );

    const session = store.get(result.sessionCode);
    expect(session!.branchName).toBe(result.branchName);
    expect(session!.worktreePath).toBe(result.worktreePath);
  }, 30_000);

  it("throws when git root is not available", async () => {
    const mockGitOps: GitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: false, error: "fatal: not a git repository" }),
      createSessionWorktree: vi.fn(),
      removeSessionWorktree: vi.fn(),
      pushBranch: vi.fn(),
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
  }, 30_000);

  it("throws when worktree creation fails", async () => {
    const mockGitOps: GitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo" }),
      createSessionWorktree: vi.fn().mockResolvedValue({ ok: false, error: "branch already exists" }),
      removeSessionWorktree: vi.fn(),
      pushBranch: vi.fn(),
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
  }, 30_000);

  it("throws and cleans up worktree when push fails", async () => {
    const mockGitOps: GitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo" }),
      createSessionWorktree: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo/.hoop/sessions/MOCK" }),
      removeSessionWorktree: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      pushBranch: vi.fn().mockResolvedValue({ ok: false, error: "fatal: could not read from remote repository" }),
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
