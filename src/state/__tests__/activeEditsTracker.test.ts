import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActiveEditsTracker } from "../activeEditsTracker.js";
import type { StateUpdate } from "../stateUpdate.js";

const TEST_REGISTRY = join(tmpdir(), "hoop-active-edits-test.json");

function bufferUpdate(peerId: string, filePath: string, dirty: boolean, timestamp = Date.now()): StateUpdate {
  return {
    type: "buffer-update",
    peerId,
    filePath,
    contentHash: "abc123",
    version: 1,
    dirty,
    timestamp,
  };
}

function fileChangeUpdate(peerId: string, filePath: string, timestamp = Date.now()): StateUpdate {
  return {
    type: "file-change",
    peerId,
    filePath,
    patch: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
    baseHash: "aaa",
    resultHash: "bbb",
    timestamp,
  };
}

function cursorUpdate(peerId: string, filePath: string): StateUpdate {
  return {
    type: "cursor-update",
    peerId,
    filePath,
    line: 10,
    column: 5,
    timestamp: Date.now(),
  };
}

describe("ActiveEditsTracker", () => {
  let tracker: ActiveEditsTracker;

  beforeEach(() => {
    tracker = new ActiveEditsTracker("self-peer", TEST_REGISTRY);
  });

  afterEach(() => {
    try { unlinkSync(TEST_REGISTRY); } catch { /* ignore */ }
  });

  it("ignores updates from self", () => {
    tracker.handleUpdate(bufferUpdate("self-peer", "src/index.ts", true));

    const result = tracker.checkConflict("src/index.ts");
    expect(result.hasConflict).toBe(false);
    expect(result.conflict).toBeNull();
  });

  it("tracks dirty buffer from other peer", () => {
    tracker.handleUpdate(bufferUpdate("peer-alice", "src/main.ts", true));

    const result = tracker.checkConflict("src/main.ts");
    expect(result.hasConflict).toBe(true);
    expect(result.conflict).toMatchObject({
      peerId: "peer-alice",
      filePath: "src/main.ts",
      type: "dirty-buffer",
    });
  });

  it("removes edit when buffer becomes clean", () => {
    tracker.handleUpdate(bufferUpdate("peer-alice", "src/main.ts", true));
    tracker.handleUpdate(bufferUpdate("peer-alice", "src/main.ts", false));

    const result = tracker.checkConflict("src/main.ts");
    expect(result.hasConflict).toBe(false);
  });

  it("tracks file-change from other peer", () => {
    tracker.handleUpdate(fileChangeUpdate("peer-bob", "src/utils.ts"));

    const result = tracker.checkConflict("src/utils.ts");
    expect(result.hasConflict).toBe(true);
    expect(result.conflict).toMatchObject({
      peerId: "peer-bob",
      type: "file-change",
    });
  });

  it("expires file-change after TTL", () => {
    const oldTimestamp = Date.now() - 120_000; // 2 minutes ago
    tracker.handleUpdate(fileChangeUpdate("peer-bob", "src/utils.ts", oldTimestamp));

    const result = tracker.checkConflict("src/utils.ts");
    expect(result.hasConflict).toBe(false);
  });

  it("does not expire dirty-buffer edits", () => {
    const oldTimestamp = Date.now() - 120_000;
    tracker.handleUpdate(bufferUpdate("peer-alice", "src/main.ts", true, oldTimestamp));

    const result = tracker.checkConflict("src/main.ts");
    expect(result.hasConflict).toBe(true);
  });

  it("ignores cursor-update events", () => {
    tracker.handleUpdate(cursorUpdate("peer-alice", "src/main.ts"));

    const result = tracker.checkConflict("src/main.ts");
    expect(result.hasConflict).toBe(false);
  });

  it("file-change overwrites dirty-buffer for same file", () => {
    tracker.handleUpdate(bufferUpdate("peer-alice", "src/main.ts", true));
    tracker.handleUpdate(fileChangeUpdate("peer-bob", "src/main.ts"));

    const result = tracker.checkConflict("src/main.ts");
    expect(result.hasConflict).toBe(true);
    expect(result.conflict!.type).toBe("file-change");
    expect(result.conflict!.peerId).toBe("peer-bob");
  });

  it("tracks multiple files independently", () => {
    tracker.handleUpdate(bufferUpdate("peer-alice", "src/a.ts", true));
    tracker.handleUpdate(fileChangeUpdate("peer-bob", "src/b.ts"));

    expect(tracker.checkConflict("src/a.ts").hasConflict).toBe(true);
    expect(tracker.checkConflict("src/b.ts").hasConflict).toBe(true);
    expect(tracker.checkConflict("src/c.ts").hasConflict).toBe(false);
  });

  it("removePeer clears all edits for that peer", () => {
    tracker.handleUpdate(bufferUpdate("peer-alice", "src/a.ts", true));
    tracker.handleUpdate(bufferUpdate("peer-alice", "src/b.ts", true));
    tracker.handleUpdate(bufferUpdate("peer-bob", "src/c.ts", true));

    tracker.removePeer("peer-alice");

    expect(tracker.checkConflict("src/a.ts").hasConflict).toBe(false);
    expect(tracker.checkConflict("src/b.ts").hasConflict).toBe(false);
    expect(tracker.checkConflict("src/c.ts").hasConflict).toBe(true);
  });

  it("clear removes all edits", () => {
    tracker.handleUpdate(bufferUpdate("peer-alice", "src/a.ts", true));
    tracker.handleUpdate(fileChangeUpdate("peer-bob", "src/b.ts"));

    tracker.clear();

    expect(tracker.checkConflict("src/a.ts").hasConflict).toBe(false);
    expect(tracker.checkConflict("src/b.ts").hasConflict).toBe(false);
  });

  it("persists registry to disk", () => {
    tracker.handleUpdate(bufferUpdate("peer-alice", "src/main.ts", true));

    const registry = ActiveEditsTracker.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.activeEdits["src/main.ts"]).toMatchObject({
      peerId: "peer-alice",
      type: "dirty-buffer",
    });
  });

  it("readRegistry returns null for missing file", () => {
    const result = ActiveEditsTracker.readRegistry("/tmp/nonexistent-hoop-test.json");
    expect(result).toBeNull();
  });

  it("getRegistry returns current state", () => {
    tracker.handleUpdate(bufferUpdate("peer-alice", "src/a.ts", true));
    tracker.handleUpdate(fileChangeUpdate("peer-bob", "src/b.ts"));

    const registry = tracker.getRegistry();
    expect(Object.keys(registry.activeEdits)).toHaveLength(2);
    expect(registry.updatedAt).toBeGreaterThan(0);
  });
});
