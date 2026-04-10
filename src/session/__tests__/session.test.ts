import { describe, it, expect, beforeEach } from "vitest";
import { Session, SessionStore } from "../session.js";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  it("creates a session and retrieves it by code with all fields intact", () => {
    const session: Session = {
      sessionCode: "K7X-M2P",
      passwordHash: "$2b$10$hashedvalue",
      hostId: "host-abc-123",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    };

    store.create(session);
    const retrieved = store.get("K7X-M2P");

    expect(retrieved).toBeDefined();
    expect(retrieved?.sessionCode).toBe(session.sessionCode);
    expect(retrieved?.passwordHash).toBe(session.passwordHash);
    expect(retrieved?.hostId).toBe(session.hostId);
    expect(retrieved?.createdAt).toEqual(session.createdAt);
  });

  it("returns false for exists on an unknown code and true after create", () => {
    expect(store.exists("ZZZ-999")).toBe(false);

    const session: Session = {
      sessionCode: "ZZZ-999",
      hostId: "host-xyz",
      createdAt: new Date(),
    };

    store.create(session);
    expect(store.exists("ZZZ-999")).toBe(true);
  });

  it("throws an Error when creating a session with a duplicate code", () => {
    const session: Session = {
      sessionCode: "DUP-123",
      hostId: "host-1",
      createdAt: new Date(),
    };

    store.create(session);

    expect(() =>
      store.create({ ...session, hostId: "host-2" })
    ).toThrow(Error);
  });

  it("returns undefined for get on a non-existent code", () => {
    expect(store.get("NON-EXI")).toBeUndefined();
  });

  it("creates and retrieves a session without a passwordHash", () => {
    const session: Session = {
      sessionCode: "NOP-WRD",
      hostId: "host-nopw",
      createdAt: new Date("2024-06-15T12:00:00Z"),
    };

    store.create(session);
    const retrieved = store.get("NOP-WRD");

    expect(retrieved).toBeDefined();
    expect(retrieved?.passwordHash).toBeUndefined();
    expect(retrieved?.hostId).toBe("host-nopw");
  });
});
