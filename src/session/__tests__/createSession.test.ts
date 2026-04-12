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
});
