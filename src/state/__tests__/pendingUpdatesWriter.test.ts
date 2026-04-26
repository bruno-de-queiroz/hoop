import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PendingUpdatesWriter } from "../pendingUpdatesWriter.js";
import type { StateUpdate } from "../stateUpdate.js";

const TEST_REGISTRY = join(tmpdir(), "hoop-pending-updates-test.json");
const SELF_PEER = "self-peer";

function makeWriter() {
  return new PendingUpdatesWriter(SELF_PEER, TEST_REGISTRY);
}

function fileChange(peerId: string, filePath: string, patch: string): StateUpdate {
  return {
    type: "file-change",
    peerId,
    filePath,
    patch,
    baseHash: "aaa",
    resultHash: "bbb",
    timestamp: Date.now(),
  };
}

describe("PendingUpdatesWriter", () => {
  beforeEach(() => {
    try { unlinkSync(TEST_REGISTRY); } catch { /* ignore */ }
  });

  afterEach(() => {
    try { unlinkSync(TEST_REGISTRY); } catch { /* ignore */ }
  });

  it("ignores self updates", () => {
    const writer = makeWriter();
    writer.handleUpdate(fileChange(SELF_PEER, "src/main.ts", "+new line"));

    const registry = PendingUpdatesWriter.readRegistry(TEST_REGISTRY);
    expect(registry).toBeNull();
  });

  it("ignores non-file-change updates", () => {
    const writer = makeWriter();
    writer.handleUpdate({
      type: "cursor-update",
      peerId: "peer-alice",
      filePath: "src/main.ts",
      line: 10,
      column: 5,
      timestamp: Date.now(),
    });
    writer.handleUpdate({
      type: "buffer-update",
      peerId: "peer-alice",
      filePath: "src/main.ts",
      contentHash: "abc",
      version: 1,
      dirty: true,
      timestamp: Date.now(),
    });
    writer.handleUpdate({
      type: "metadata-update",
      peerId: "peer-alice",
      key: "status",
      value: "editing",
      timestamp: Date.now(),
    });

    const registry = PendingUpdatesWriter.readRegistry(TEST_REGISTRY);
    expect(registry).toBeNull();
  });

  it("accumulates file-change updates from other peers", async () => {
    const writer = makeWriter();
    writer.handleUpdate(fileChange("peer-alice", "src/main.ts", "+line 1"));
    writer.handleUpdate(fileChange("peer-bob", "src/utils.ts", "+line 2"));

    await writer.flushWrites();

    const registry = PendingUpdatesWriter.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.updates).toHaveLength(2);
    expect(registry!.updates[0].peerId).toBe("peer-alice");
    expect(registry!.updates[0].filePath).toBe("src/main.ts");
    expect(registry!.updates[0].patch).toBe("+line 1");
    expect(registry!.updates[1].peerId).toBe("peer-bob");
    expect(registry!.updates[1].filePath).toBe("src/utils.ts");
  });

  it("accumulates multiple updates to the same file", async () => {
    const writer = makeWriter();
    writer.handleUpdate(fileChange("peer-alice", "src/main.ts", "+v1"));
    writer.handleUpdate(fileChange("peer-alice", "src/main.ts", "+v2"));

    await writer.flushWrites();

    const registry = PendingUpdatesWriter.readRegistry(TEST_REGISTRY);
    expect(registry!.updates).toHaveLength(2);
  });

  it("readAndDrain returns updates and clears the file", async () => {
    const writer = makeWriter();
    writer.handleUpdate(fileChange("peer-alice", "src/main.ts", "+change"));

    await writer.flushWrites();

    const drained = PendingUpdatesWriter.readAndDrain(TEST_REGISTRY);
    expect(drained).not.toBeNull();
    expect(drained!.updates).toHaveLength(1);
    expect(drained!.updates[0].filePath).toBe("src/main.ts");

    // File should now be empty
    const afterDrain = PendingUpdatesWriter.readRegistry(TEST_REGISTRY);
    expect(afterDrain!.updates).toHaveLength(0);
  });

  it("readAndDrain returns null when file does not exist", () => {
    const result = PendingUpdatesWriter.readAndDrain(TEST_REGISTRY);
    expect(result).toBeNull();
  });

  it("readAndDrain is a no-op on empty updates", async () => {
    const writer = makeWriter();
    writer.clear(); // writes empty state

    await writer.flushWrites();

    const result = PendingUpdatesWriter.readAndDrain(TEST_REGISTRY);
    expect(result).not.toBeNull();
    expect(result!.updates).toHaveLength(0);

    // File should still exist with empty updates
    const after = PendingUpdatesWriter.readRegistry(TEST_REGISTRY);
    expect(after!.updates).toHaveLength(0);
  });

  it("clear() empties the registry", async () => {
    const writer = makeWriter();
    writer.handleUpdate(fileChange("peer-alice", "src/main.ts", "+change"));

    writer.clear();

    await writer.flushWrites();

    const registry = PendingUpdatesWriter.readRegistry(TEST_REGISTRY);
    expect(registry!.updates).toHaveLength(0);
  });

  it("readRegistry returns null for missing file", () => {
    const result = PendingUpdatesWriter.readRegistry(TEST_REGISTRY);
    expect(result).toBeNull();
  });
});
