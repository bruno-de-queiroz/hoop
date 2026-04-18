import { describe, it, expect, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LockStatusWriter } from "../lockStatusWriter.js";
import { createFreeHoopLock, createBusyHoopLock } from "../hoopLock.js";

const TEST_REGISTRY = join(tmpdir(), "hoop-lock-status-test.json");
const SELF_PEER = "self-peer";

function makeWriter() {
  return new LockStatusWriter(SELF_PEER, TEST_REGISTRY);
}

describe("LockStatusWriter", () => {
  afterEach(() => {
    try { unlinkSync(TEST_REGISTRY); } catch { /* ignore */ }
  });

  it("writes free lock state to disk", () => {
    const writer = makeWriter();
    writer.update(createFreeHoopLock());

    const registry = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.status).toBe("free");
    expect(registry!.holderPeerId).toBeNull();
    expect(registry!.selfPeerId).toBe(SELF_PEER);
    expect(registry!.updatedAt).toBeGreaterThan(0);
  });

  it("writes busy lock state to disk", () => {
    const writer = makeWriter();
    writer.update(createBusyHoopLock("peer-alice", Date.now()));

    const registry = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.status).toBe("busy");
    expect(registry!.holderPeerId).toBe("peer-alice");
    expect(registry!.selfPeerId).toBe(SELF_PEER);
  });

  it("overwrites previous state on update", () => {
    const writer = makeWriter();
    writer.update(createBusyHoopLock("peer-alice", Date.now()));
    writer.update(createFreeHoopLock());

    const registry = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(registry!.status).toBe("free");
    expect(registry!.holderPeerId).toBeNull();
  });

  it("clear() removes the registry file", () => {
    const writer = makeWriter();
    writer.update(createFreeHoopLock());
    writer.clear();

    const registry = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(registry).toBeNull();
  });

  it("clear() is a no-op when file does not exist", () => {
    const writer = makeWriter();
    expect(() => writer.clear()).not.toThrow();
  });

  it("readRegistry returns null for missing file", () => {
    const result = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(result).toBeNull();
  });

  it("tracks self vs holder for self-held lock", () => {
    const writer = makeWriter();
    writer.update(createBusyHoopLock(SELF_PEER, Date.now()));

    const registry = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(registry!.status).toBe("busy");
    expect(registry!.holderPeerId).toBe(SELF_PEER);
    expect(registry!.selfPeerId).toBe(SELF_PEER);
  });
});
