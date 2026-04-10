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
      executionTarget: "host-only",
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
      executionTarget: "host-only",
      createdAt: new Date(),
    };

    store.create(session);
    expect(store.exists("ZZZ-999")).toBe(true);
  });

  it("throws an Error when creating a session with a duplicate code", () => {
    const session: Session = {
      sessionCode: "DUP-123",
      hostId: "host-1",
      executionTarget: "host-only",
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
      executionTarget: "host-only",
      createdAt: new Date("2024-06-15T12:00:00Z"),
    };

    store.create(session);
    const retrieved = store.get("NOP-WRD");

    expect(retrieved).toBeDefined();
    expect(retrieved?.passwordHash).toBeUndefined();
    expect(retrieved?.hostId).toBe("host-nopw");
  });

  it("stores and retrieves a session with host-only execution target", () => {
    const session: Session = {
      sessionCode: "HST-ONL",
      hostId: "host-1",
      executionTarget: "host-only",
      createdAt: new Date(),
    };

    store.create(session);
    const retrieved = store.get("HST-ONL");

    expect(retrieved).toBeDefined();
    expect(retrieved?.executionTarget).toBe("host-only");
  });

  it("stores and retrieves a session with proponent-side execution target", () => {
    const session: Session = {
      sessionCode: "PRO-SDE",
      hostId: "host-2",
      executionTarget: "proponent-side",
      createdAt: new Date(),
    };

    store.create(session);
    const retrieved = store.get("PRO-SDE");

    expect(retrieved).toBeDefined();
    expect(retrieved?.executionTarget).toBe("proponent-side");
  });

  it("update sets peerId and listenAddresses on an existing session", () => {
    const session: Session = {
      sessionCode: "UPD-001",
      hostId: "host-upd",
      executionTarget: "host-only",
      createdAt: new Date(),
    };

    store.create(session);
    store.update("UPD-001", {
      peerId: "12D3KooWExamplePeerId",
      listenAddresses: ["/ip4/127.0.0.1/tcp/4001", "/ip4/192.168.1.10/tcp/4001"],
    });

    const retrieved = store.get("UPD-001");
    expect(retrieved?.peerId).toBe("12D3KooWExamplePeerId");
    expect(retrieved?.listenAddresses).toEqual([
      "/ip4/127.0.0.1/tcp/4001",
      "/ip4/192.168.1.10/tcp/4001",
    ]);
  });

  it("update throws an Error when the session code does not exist", () => {
    expect(() =>
      store.update("NON-EXI", { peerId: "12D3KooWSomePeer" })
    ).toThrow(Error);
  });

  it("creates a session with network fields and retrieves them intact", () => {
    const session: Session = {
      sessionCode: "NET-001",
      hostId: "host-net",
      executionTarget: "host-only",
      createdAt: new Date("2024-03-01T10:00:00Z"),
      peerId: "12D3KooWRoundTripPeer",
      listenAddresses: ["/ip4/10.0.0.1/tcp/9000"],
    };

    store.create(session);
    const retrieved = store.get("NET-001");

    expect(retrieved?.peerId).toBe("12D3KooWRoundTripPeer");
    expect(retrieved?.listenAddresses).toEqual(["/ip4/10.0.0.1/tcp/9000"]);
  });
});
