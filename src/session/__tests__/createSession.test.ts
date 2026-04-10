import { describe, it, expect, afterEach } from "vitest";
import { createSession, type CreateSessionResult } from "../createSession.js";
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
      },
      store,
    );

    expect(result.passwordProtected).toBe(false);

    const session = store.get(result.sessionCode);
    expect(session!.passwordHash).toBeUndefined();
  }, 30_000);
});
