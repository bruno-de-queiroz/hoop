import { describe, it, expect, afterEach, vi } from "vitest";
import { createSession, stubGitOps, defaultAdmissionHandler, type CreateSessionResult, type GitOps } from "../createSession.js";
import { SessionStore } from "../session.js";
import { validateSessionCode } from "../sessionCode.js";

describe("createSession", () => {
  let result: CreateSessionResult | undefined;

  afterEach(async () => {
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

  it("creates worktree and stores branch info on successful git init", async () => {
    const mockGitOps: GitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo" }),
      createSessionWorktree: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/fakerepo/.hoop/sessions/MOCK" }),
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

    const session = store.get(result.sessionCode);
    expect(session!.branchName).toBe(result.branchName);
    expect(session!.worktreePath).toBe(result.worktreePath);
  }, 30_000);

  it("throws when git root is not available", async () => {
    const mockGitOps: GitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: false, error: "fatal: not a git repository" }),
      createSessionWorktree: vi.fn(),
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
    const unsubscribe = result.onPublishedUpdate((publication) => {
      observed.push({ seqNo: publication.seqNo, update: publication.update as typeof update });
    });

    const seqNo = result.publishUpdate(update);
    unsubscribe();

    expect(seqNo).toBe(1);
    expect(result.accumulator.getMetadata("theme")).toEqual(update);
    expect(result.replayBuffer.replaySince(0)).toEqual([{ seqNo: 1, update }]);
    expect(observed).toEqual([{ seqNo: 1, update }]);
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
