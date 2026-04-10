import { describe, it, expect, afterEach } from "vitest";
import { joinSession, type JoinSessionResult } from "../joinSession.js";
import { createSession, type CreateSessionResult } from "../createSession.js";
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
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      networkConfig: { transportMode: "test" },
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
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      password: "secret",
      networkConfig: { transportMode: "test" },
    });

    expect(joinResult.authenticated).toBe(true);
  }, 30_000);

  it("throws on invalid session code", async () => {
    await expect(
      joinSession({
        sessionCode: "invalid",
        hostAddress: "/ip4/127.0.0.1/tcp/0",
        networkConfig: { transportMode: "test" },
      }),
    ).rejects.toThrow("Invalid session code format");
  });

  it("throws and stops node on connection failure", async () => {
    await expect(
      joinSession({
        sessionCode: "ABC-XYZ",
        hostAddress: "/ip4/127.0.0.1/tcp/1",
        networkConfig: { transportMode: "test" },
      }),
    ).rejects.toThrow("Failed to connect to host");
  }, 30_000);
});
