import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PendingNotesWriter } from "../pendingNotesWriter.js";
import type { StateUpdate } from "../stateUpdate.js";

// Per-test path so parallel vitest workers can never collide on the same
// fixture file (the shared-tmpfile pattern in the older tests is a known
// flake source — see finding #15).
let TEST_REGISTRY: string;
const SELF_PEER = "self-peer";

function makeWriter() {
  return new PendingNotesWriter(SELF_PEER, TEST_REGISTRY);
}

function note(peerId: string, text: string, author?: string): StateUpdate {
  return {
    type: "session-note",
    peerId,
    author,
    text,
    timestamp: Date.now(),
  };
}

describe("PendingNotesWriter", () => {
  beforeEach(() => {
    TEST_REGISTRY = join(tmpdir(), `hoop-pending-notes-test-${randomUUID()}.json`);
  });

  afterEach(() => {
    try { unlinkSync(TEST_REGISTRY); } catch { /* ignore */ }
  });

  it("ignores own notes", () => {
    const writer = makeWriter();
    writer.handleUpdate(note(SELF_PEER, "my own thought"));

    const registry = PendingNotesWriter.readRegistry(TEST_REGISTRY);
    expect(registry).toBeNull();
  });

  it("ignores non-session-note updates", () => {
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
      type: "file-change",
      peerId: "peer-alice",
      filePath: "src/main.ts",
      patch: "+line",
      baseHash: "a",
      resultHash: "b",
      timestamp: Date.now(),
    });

    const registry = PendingNotesWriter.readRegistry(TEST_REGISTRY);
    expect(registry).toBeNull();
  });

  it("accumulates notes from other peers", async () => {
    const writer = makeWriter();
    writer.handleUpdate(note("peer-alice", "trying the map() approach", "alice@x.com"));
    writer.handleUpdate(note("peer-bob", "lgtm"));

    await writer.flushWrites();

    const registry = PendingNotesWriter.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.notes).toHaveLength(2);
    expect(registry!.notes[0].peerId).toBe("peer-alice");
    expect(registry!.notes[0].text).toBe("trying the map() approach");
    expect(registry!.notes[0].author).toBe("alice@x.com");
    expect(registry!.notes[1].peerId).toBe("peer-bob");
    expect(registry!.notes[1].author).toBeUndefined();
  });

  it("readAndDrain returns notes and clears the file", async () => {
    const writer = makeWriter();
    writer.handleUpdate(note("peer-alice", "first note"));

    await writer.flushWrites();

    const drained = PendingNotesWriter.readAndDrain(TEST_REGISTRY);
    expect(drained).not.toBeNull();
    expect(drained!.notes).toHaveLength(1);
    expect(drained!.notes[0].text).toBe("first note");

    const afterDrain = PendingNotesWriter.readRegistry(TEST_REGISTRY);
    expect(afterDrain!.notes).toHaveLength(0);
  });

  it("readAndDrain returns null when file does not exist", () => {
    const result = PendingNotesWriter.readAndDrain(TEST_REGISTRY);
    expect(result).toBeNull();
  });

  it("readAndDrain is a no-op on empty notes", async () => {
    const writer = makeWriter();
    writer.clear();

    await writer.flushWrites();

    const result = PendingNotesWriter.readAndDrain(TEST_REGISTRY);
    expect(result).not.toBeNull();
    expect(result!.notes).toHaveLength(0);

    const after = PendingNotesWriter.readRegistry(TEST_REGISTRY);
    expect(after!.notes).toHaveLength(0);
  });

  it("clear() empties the registry", async () => {
    const writer = makeWriter();
    writer.handleUpdate(note("peer-alice", "before clear"));

    writer.clear();

    await writer.flushWrites();

    const registry = PendingNotesWriter.readRegistry(TEST_REGISTRY);
    expect(registry!.notes).toHaveLength(0);
  });

  it("readRegistry returns null for missing file", () => {
    const result = PendingNotesWriter.readRegistry(TEST_REGISTRY);
    expect(result).toBeNull();
  });

  it("serializes concurrent writes without losing notes", async () => {
    const writer = makeWriter();
    for (let i = 0; i < 20; i++) {
      writer.handleUpdate(note(`peer-${i % 3}`, `note ${i}`));
    }

    await writer.flushWrites();

    const registry = PendingNotesWriter.readRegistry(TEST_REGISTRY);
    expect(registry!.notes).toHaveLength(20);
  });
});
