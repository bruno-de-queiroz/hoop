import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SessionLogAggregator } from "../sessionLog.js";
import type { StateUpdate } from "../stateUpdate.js";

let TEST_LOG: string;

function makeAgg() {
  return new SessionLogAggregator(TEST_LOG);
}

function fileChange(peerId: string, filePath: string): StateUpdate {
  return {
    type: "file-change",
    peerId,
    filePath,
    patch: "+x",
    baseHash: "a",
    resultHash: "b",
    timestamp: Date.now(),
  };
}

function note(peerId: string, text: string): StateUpdate {
  return { type: "session-note", peerId, text, timestamp: Date.now() };
}

describe("SessionLogAggregator", () => {
  beforeEach(() => {
    TEST_LOG = join(tmpdir(), `hoop-session-log-test-${randomUUID()}.json`);
  });

  afterEach(() => {
    try { unlinkSync(TEST_LOG); } catch { /* ignore */ }
  });

  it("appends entries in order", async () => {
    const agg = makeAgg();
    agg.append(fileChange("alice", "a.ts"));
    agg.append(note("bob", "lgtm"));

    await agg.flushWrites();

    const snap = agg.getSnapshot();
    expect(snap.entries).toHaveLength(2);
    expect(snap.entries[0].type).toBe("file-change");
    expect(snap.entries[0].peerId).toBe("alice");
    expect(snap.entries[1].type).toBe("session-note");
    expect(snap.entries[1].peerId).toBe("bob");
  });

  it("mirrors to disk", async () => {
    const agg = makeAgg();
    agg.append(note("alice", "trying map()"));

    await agg.flushWrites();

    const onDisk = SessionLogAggregator.readLog(TEST_LOG);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.entries).toHaveLength(1);
    expect((onDisk!.entries[0].payload as { text: string }).text).toBe("trying map()");
  });

  it("reset clears entries and removes the file", async () => {
    const agg = makeAgg();
    agg.append(note("alice", "before reset"));
    await agg.flushWrites();

    expect(existsSync(TEST_LOG)).toBe(true);

    agg.reset();
    await agg.flushWrites();

    expect(agg.getSnapshot().entries).toHaveLength(0);
    expect(existsSync(TEST_LOG)).toBe(false);
  });

  it("readLog returns null for missing file", () => {
    expect(SessionLogAggregator.readLog(TEST_LOG)).toBeNull();
  });

  it("trims to maxEntries when exceeded (configurable via constructor or env)", async () => {
    const agg = new SessionLogAggregator(TEST_LOG, 100);
    for (let i = 0; i < 150; i++) agg.append(note("alice", `n${i}`));
    await agg.flushWrites();

    const snap = agg.getSnapshot();
    expect(snap.entries).toHaveLength(100);
    expect((snap.entries[0].payload as { text: string }).text).toBe("n50");
    expect((snap.entries[99].payload as { text: string }).text).toBe("n149");
  });

  it("query() filters by peer and applies last-N limit", async () => {
    const agg = makeAgg();
    for (let i = 0; i < 5; i++) agg.append(note("alice", `a${i}`));
    for (let i = 0; i < 3; i++) agg.append(note("bob", `b${i}`));
    await agg.flushWrites();

    expect(agg.query()).toHaveLength(8);
    expect(agg.query({ peerId: "alice" })).toHaveLength(5);
    expect(agg.query({ peerId: "bob" })).toHaveLength(3);

    const last2Alice = agg.query({ peerId: "alice", limit: 2 });
    expect(last2Alice).toHaveLength(2);
    expect((last2Alice[0].payload as { text: string }).text).toBe("a3");
    expect((last2Alice[1].payload as { text: string }).text).toBe("a4");

    // last 3 across all peers — chronologically the last 3 are bob's.
    const last3All = agg.query({ limit: 3 });
    expect(last3All).toHaveLength(3);
    expect(last3All.map((e) => e.peerId)).toEqual(["bob", "bob", "bob"]);
    expect(last3All.map((e) => (e.payload as { text: string }).text)).toEqual(["b0", "b1", "b2"]);
  });

  it("reset() interleaves cleanly with append (no race window)", async () => {
    const agg = makeAgg();
    agg.append(note("alice", "before"));
    agg.reset();
    // append after reset must not see the old entries; reset's queued
    // unlink runs strictly before any subsequent enqueued writes.
    agg.append(note("alice", "after"));
    await agg.flushWrites();

    expect(agg.getSnapshot().entries).toHaveLength(1);
    expect((agg.getSnapshot().entries[0].payload as { text: string }).text).toBe("after");

    const onDisk = SessionLogAggregator.readLog(TEST_LOG);
    expect(onDisk!.entries).toHaveLength(1);
    expect((onDisk!.entries[0].payload as { text: string }).text).toBe("after");
  });
});
