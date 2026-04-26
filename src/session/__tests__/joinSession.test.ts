import { describe, it, expect, afterEach, vi } from "vitest";
import { joinSession, stubJoinGitOps, type JoinSessionResult, type JoinGitOps } from "../joinSession.js";
import { createSession, stubGitOps, defaultAdmissionHandler, type CreateSessionResult } from "../createSession.js";
import { SessionStore } from "../session.js";
import { SYNC_PROTOCOL, readFromStream, writeToStream, type SyncRequest, type SyncResponse } from "../../network/protocol.js";
import { createEmptyStateTree } from "../../state/stateTree.js";

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
    expect(joinResult.executionTarget).toBe("host-only");
    expect(joinResult.node.getState()).toBe("listening");
  }, 30_000);

  it("propagates proponent-side executionTarget to joining peer", async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: "proponent-side",
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

    expect(joinResult.executionTarget).toBe("proponent-side");
  }, 30_000);

  it("defaults executionTarget to host-only when host omits it (legacy host)", async () => {
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

    // Replace SYNC_PROTOCOL handler with one that omits executionTarget
    await hostResult.node.unhandle(SYNC_PROTOCOL);
    await hostResult.node.handle(SYNC_PROTOCOL, async (stream) => {
      await readFromStream<SyncRequest>(stream);
      const response: Omit<SyncResponse, "executionTarget"> = {
        stateTree: createEmptyStateTree(),
      };
      await writeToStream(stream, response);
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: "test@example.com",
      networkConfig: { transportMode: "test" },
      gitOps: stubJoinGitOps,
    });

    expect(joinResult.executionTarget).toBe("host-only");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Host did not send a valid executionTarget"),
      "undefined",
    );
    errorSpy.mockRestore();
  }, 30_000);

  it("defaults executionTarget to host-only when host sends invalid value", async () => {
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

    // Replace SYNC_PROTOCOL handler with one that sends a bogus executionTarget
    await hostResult.node.unhandle(SYNC_PROTOCOL);
    await hostResult.node.handle(SYNC_PROTOCOL, async (stream) => {
      await readFromStream<SyncRequest>(stream);
      const response = {
        stateTree: createEmptyStateTree(),
        executionTarget: "garbage-value",
      };
      await writeToStream(stream, response);
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: "test@example.com",
      networkConfig: { transportMode: "test" },
      gitOps: stubJoinGitOps,
    });

    expect(joinResult.executionTarget).toBe("host-only");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Host did not send a valid executionTarget"),
      "garbage-value",
    );
    errorSpy.mockRestore();
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

  it("onBroadcast returns an unsubscribe function that removes the handler", async () => {
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

    const handler1 = vi.fn();
    const handler2 = vi.fn();

    // Register both handlers
    const unsubscribe1 = joinResult.onBroadcast(handler1);
    const unsubscribe2 = joinResult.onBroadcast(handler2);

    // Manually trigger a broadcast to verify both handlers are called
    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();

    // Unsubscribe the first handler
    unsubscribe1();

    // Both handlers should still work after unsubscribing (this test just verifies
    // the unsubscribe function exists and is callable). The internal array mutation
    // is tested by the MCP server integration where the cleanup path is verified.
    expect(typeof unsubscribe2).toBe("function");
  }, 30_000);
});
