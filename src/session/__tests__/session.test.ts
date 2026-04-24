import { describe, it, expect, beforeEach } from "vitest";
import { Session, SessionStore, isGovernanceConfig, isZeroTrustThreshold } from "../session.js";

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

  it("update sets branchName and worktreePath on an existing session", () => {
    const session: Session = {
      sessionCode: "WRK-001",
      hostId: "host-wrk",
      executionTarget: "host-only",
      createdAt: new Date(),
    };

    store.create(session);
    store.update("WRK-001", {
      branchName: "hoop/session-WRK-001",
      worktreePath: "/tmp/repo/.hoop/sessions/WRK-001",
    });

    const retrieved = store.get("WRK-001");
    expect(retrieved?.branchName).toBe("hoop/session-WRK-001");
    expect(retrieved?.worktreePath).toBe("/tmp/repo/.hoop/sessions/WRK-001");
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

describe("isZeroTrustThreshold", () => {
  it("accepts named thresholds", () => {
    expect(isZeroTrustThreshold("majority")).toBe(true);
    expect(isZeroTrustThreshold("consensus")).toBe(true);
  });

  it("accepts positive safe integers", () => {
    expect(isZeroTrustThreshold(1)).toBe(true);
    expect(isZeroTrustThreshold(100)).toBe(true);
  });

  it("rejects zero, negative, and non-integer numbers", () => {
    expect(isZeroTrustThreshold(0)).toBe(false);
    expect(isZeroTrustThreshold(-1)).toBe(false);
    expect(isZeroTrustThreshold(2.5)).toBe(false);
    expect(isZeroTrustThreshold(Infinity)).toBe(false);
    expect(isZeroTrustThreshold(NaN)).toBe(false);
  });

  it("rejects unsafe integers", () => {
    expect(isZeroTrustThreshold(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it("rejects non-threshold strings and other types", () => {
    expect(isZeroTrustThreshold("all")).toBe(false);
    expect(isZeroTrustThreshold("")).toBe(false);
    expect(isZeroTrustThreshold(null)).toBe(false);
    expect(isZeroTrustThreshold(undefined)).toBe(false);
    expect(isZeroTrustThreshold({})).toBe(false);
  });
});

describe("isGovernanceConfig", () => {
  it("accepts valid configs", () => {
    expect(isGovernanceConfig({ mode: "host-only" })).toBe(true);
    expect(isGovernanceConfig({ mode: "yolo" })).toBe(true);
    expect(isGovernanceConfig({ mode: "zero-trust", threshold: "majority" })).toBe(true);
    expect(isGovernanceConfig({ mode: "zero-trust", threshold: "consensus" })).toBe(true);
    expect(isGovernanceConfig({ mode: "zero-trust", threshold: 3 })).toBe(true);
  });

  it("rejects zero-trust without threshold", () => {
    expect(isGovernanceConfig({ mode: "zero-trust" })).toBe(false);
  });

  it("rejects non-zero-trust with threshold", () => {
    expect(isGovernanceConfig({ mode: "host-only", threshold: "majority" })).toBe(false);
    expect(isGovernanceConfig({ mode: "yolo", threshold: 5 })).toBe(false);
  });

  it("rejects invalid modes", () => {
    expect(isGovernanceConfig({ mode: "custom" })).toBe(false);
    expect(isGovernanceConfig({ mode: "" })).toBe(false);
    expect(isGovernanceConfig({ mode: 42 })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isGovernanceConfig(null)).toBe(false);
    expect(isGovernanceConfig(undefined)).toBe(false);
    expect(isGovernanceConfig("host-only")).toBe(false);
    expect(isGovernanceConfig(42)).toBe(false);
  });

  it("rejects zero-trust with invalid threshold", () => {
    expect(isGovernanceConfig({ mode: "zero-trust", threshold: 0 })).toBe(false);
    expect(isGovernanceConfig({ mode: "zero-trust", threshold: -1 })).toBe(false);
    expect(isGovernanceConfig({ mode: "zero-trust", threshold: "all" })).toBe(false);
  });
});
