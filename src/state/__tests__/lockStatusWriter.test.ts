import { describe, it, expect, afterEach } from "vitest";
import { unlinkSync, writeFileSync, existsSync } from "node:fs";
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
    try { unlinkSync(TEST_REGISTRY + ".tmp"); } catch { /* ignore */ }
  });

  it("writes free lock state to disk", () => {
    const writer = makeWriter();
    writer.update(createFreeHoopLock());

    const registry = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.status).toBe("free");
    expect(registry!.holderPeerId).toBeNull();
    expect(registry!.acquiredAt).toBeNull();
    expect(registry!.selfPeerId).toBe(SELF_PEER);
    expect(registry!.sessionPid).toBe(process.pid);
    expect(registry!.updatedAt).toBeGreaterThan(0);
  });

  it("writes busy lock state with acquiredAt to disk", () => {
    const acquiredAt = Date.now() - 1000;
    const writer = makeWriter();
    writer.update(createBusyHoopLock("peer-alice", acquiredAt));

    const registry = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.status).toBe("busy");
    expect(registry!.holderPeerId).toBe("peer-alice");
    expect(registry!.acquiredAt).toBe(acquiredAt);
    expect(registry!.selfPeerId).toBe(SELF_PEER);
    expect(registry!.sessionPid).toBe(process.pid);
  });

  it("overwrites previous state on update", () => {
    const writer = makeWriter();
    writer.update(createBusyHoopLock("peer-alice", Date.now()));
    writer.update(createFreeHoopLock());

    const registry = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(registry!.status).toBe("free");
    expect(registry!.holderPeerId).toBeNull();
    expect(registry!.acquiredAt).toBeNull();
  });

  it("clear() removes the registry file", () => {
    const writer = makeWriter();
    writer.update(createFreeHoopLock());
    writer.clear();

    expect(existsSync(TEST_REGISTRY)).toBe(false);
    const registry = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(registry).toBeNull();
  });

  it("clear() also removes leftover .tmp file", () => {
    const tmpPath = TEST_REGISTRY + ".tmp";
    writeFileSync(tmpPath, "leftover", "utf-8");
    expect(existsSync(tmpPath)).toBe(true);

    const writer = makeWriter();
    writer.clear();

    expect(existsSync(tmpPath)).toBe(false);
  });

  it("clear() is a no-op when file does not exist", () => {
    const writer = makeWriter();
    expect(() => writer.clear()).not.toThrow();
  });

  it("readRegistry returns null for missing file", () => {
    const result = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(result).toBeNull();
  });

  it("readRegistry returns null for malformed JSON", () => {
    writeFileSync(TEST_REGISTRY, "not valid json{{{", "utf-8");
    const result = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(result).toBeNull();
  });

  it("readRegistry returns null for truncated/empty file", () => {
    writeFileSync(TEST_REGISTRY, "", "utf-8");
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

  it("atomic write does not leave partial file on disk", () => {
    const writer = makeWriter();
    // Write valid state
    writer.update(createFreeHoopLock());
    const first = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(first).not.toBeNull();

    // Overwrite — should be atomic (no partial read possible)
    writer.update(createBusyHoopLock("peer-bob", Date.now()));
    const second = LockStatusWriter.readRegistry(TEST_REGISTRY);
    expect(second).not.toBeNull();
    expect(second!.status).toBe("busy");
    expect(second!.holderPeerId).toBe("peer-bob");

    // No leftover .tmp file
    expect(existsSync(TEST_REGISTRY + ".tmp")).toBe(false);
  });
});
