import { describe, it, expect, afterEach, vi } from "vitest";
import { joinSession, stubJoinGitOps, type JoinSessionResult, type JoinGitOps } from "../joinSession.js";
import { createSession, stubGitOps, defaultAdmissionHandler, type CreateSessionResult } from "../createSession.js";
import { SessionStore } from "../session.js";

describe("joinSession", () => {
  let hostResult: CreateSessionResult | undefined;
  let joinResult: JoinSessionResult | undefined;

  afterEach(async () => {
    await Promise.all([joinResult?.node.stop(), hostResult?.node.stop()]);
    joinResult = undefined;
    hostResult = undefined;
  });

  it("connects to host session successfully", async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: "test" },
      gitOps: stubJoinGitOps,
    });

    expect(joinResult.sessionCode).toBe(hostResult.sessionCode);
    expect(joinResult.hostPeerId).toBe(hostResult.peerId);
    expect(joinResult.localPeerId).toBeTruthy();
    expect(joinResult.authenticated).toBe(false);
    expect(joinResult.node.getState()).toBe("listening");
  }, 30_000);

  it("reports password provided when given", async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        password: "secret",
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      password: "secret",
      email: 'test@example.com',
      networkConfig: { transportMode: "test" },
      gitOps: stubJoinGitOps,
    });

    expect(joinResult.authenticated).toBe(true);
  }, 30_000);

  it("throws on invalid session code", async () => {
    await expect(
      joinSession({
        sessionCode: "invalid",
        hostAddress: "/ip4/127.0.0.1/tcp/0",
        email: 'test@example.com',
        networkConfig: { transportMode: "test" },
        gitOps: stubJoinGitOps,
      }),
    ).rejects.toThrow("Invalid session code format");
  });

  it("throws and stops node on connection failure", async () => {
    await expect(
      joinSession({
        sessionCode: "ABC-XYZ",
        hostAddress: "/ip4/127.0.0.1/tcp/1",
        email: 'test@example.com',
        networkConfig: { transportMode: "test" },
        gitOps: stubJoinGitOps,
      }),
    ).rejects.toThrow("Failed to connect to host");
  }, 30_000);

  it("receives branchName from host and calls git ops", async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    const mockJoinGitOps: JoinGitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/peer-repo" }),
      fetchBranch: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      checkoutBranch: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: "test" },
      gitOps: mockJoinGitOps,
    });

    expect(joinResult.branchName).toBe(hostResult.branchName);
    expect(mockJoinGitOps.getGitRoot).toHaveBeenCalled();
    expect(mockJoinGitOps.fetchBranch).toHaveBeenCalledWith(hostResult.branchName);
    expect(mockJoinGitOps.checkoutBranch).toHaveBeenCalledWith(hostResult.branchName);
  }, 30_000);

  it("throws when git root is not available on peer", async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    const failingGitOps: JoinGitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: false, error: "fatal: not a git repository" }),
      fetchBranch: vi.fn(),
      checkoutBranch: vi.fn(),
    };

    await expect(
      joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress: hostResult.listenAddresses[0],
        email: 'test@example.com',
        networkConfig: { transportMode: "test" },
        gitOps: failingGitOps,
      }),
    ).rejects.toThrow("Git repository required");

    expect(failingGitOps.fetchBranch).not.toHaveBeenCalled();
  }, 30_000);

  it("throws when fetch fails on peer", async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    const failingGitOps: JoinGitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/peer-repo" }),
      fetchBranch: vi.fn().mockResolvedValue({ ok: false, error: "could not read from remote repository" }),
      checkoutBranch: vi.fn(),
    };

    await expect(
      joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress: hostResult.listenAddresses[0],
        email: 'test@example.com',
        networkConfig: { transportMode: "test" },
        gitOps: failingGitOps,
      }),
    ).rejects.toThrow("Failed to fetch session branch");

    expect(failingGitOps.checkoutBranch).not.toHaveBeenCalled();
  }, 30_000);

  it("throws when checkout fails on peer", async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    const failingGitOps: JoinGitOps = {
      getGitRoot: vi.fn().mockResolvedValue({ ok: true, value: "/tmp/peer-repo" }),
      fetchBranch: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      checkoutBranch: vi.fn().mockResolvedValue({ ok: false, error: "checkout conflict" }),
    };

    await expect(
      joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress: hostResult.listenAddresses[0],
        email: 'test@example.com',
        networkConfig: { transportMode: "test" },
        gitOps: failingGitOps,
      }),
    ).rejects.toThrow("Failed to checkout session branch");
  }, 30_000);
});
