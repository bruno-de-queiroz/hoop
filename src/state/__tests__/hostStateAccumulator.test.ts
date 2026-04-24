import { describe, it, expect, beforeEach } from "vitest";
import { HostStateAccumulator } from "../hostStateAccumulator.js";
import { HOOP_LOCK_TTL_MS } from "../hoopLock.js";
import type {
  CursorUpdate,
  BufferUpdate,
  MetadataUpdate,
  FileChangeUpdate,
  LockAcquireUpdate,
  LockReleaseUpdate,
} from "../stateUpdate.js";

function makeCursor(peerId: string, filePath: string, timestamp = 1000): CursorUpdate {
  return { type: "cursor-update", peerId, filePath, line: 1, column: 0, timestamp };
}

function makeBuffer(peerId: string, filePath: string, version = 1, timestamp = 1000): BufferUpdate {
  return { type: "buffer-update", peerId, filePath, contentHash: "abc123", version, dirty: false, timestamp };
}

function makeMetadata(peerId: string, key: string, value: unknown, timestamp = 1000): MetadataUpdate {
  return { type: "metadata-update", peerId, key, value, timestamp };
}

function makeFileChange(peerId: string, filePath: string, resultHash: string, timestamp = 1000): FileChangeUpdate {
  return {
    type: "file-change",
    peerId,
    filePath,
    patch: "@@ -1 +1 @@\n-old\n+new\n",
    baseHash: "base",
    resultHash,
    timestamp,
  };
}

function makeLockAcquire(peerId: string, timestamp = 1000): LockAcquireUpdate {
  return { type: "lock-acquire", peerId, timestamp };
}

function makeLockRelease(peerId: string, timestamp = 1000): LockReleaseUpdate {
  return { type: "lock-release", peerId, timestamp };
}

describe("HostStateAccumulator", () => {
  let acc: HostStateAccumulator;

  beforeEach(() => {
    acc = new HostStateAccumulator();
  });

  describe("accumulate() — cursor updates", () => {
    it("stores a cursor update per peer per file", () => {
      const update = makeCursor("peer-1", "src/index.ts");
      acc.accumulate(update);
      const snapshot = acc.getSnapshot();
      expect(snapshot.cursors["peer-1"]["src/index.ts"]).toEqual(update);
    });

    it("overwrites cursor update for same peer and file", () => {
      acc.accumulate(makeCursor("peer-1", "src/index.ts", 1000));
      const newer = makeCursor("peer-1", "src/index.ts", 2000);
      acc.accumulate(newer);
      const snapshot = acc.getSnapshot();
      expect(snapshot.cursors["peer-1"]["src/index.ts"]).toEqual(newer);
    });

    it("tracks cursors for multiple peers independently", () => {
      const c1 = makeCursor("peer-1", "src/a.ts");
      const c2 = makeCursor("peer-2", "src/a.ts");
      acc.accumulate(c1);
      acc.accumulate(c2);
      const snapshot = acc.getSnapshot();
      expect(snapshot.cursors["peer-1"]["src/a.ts"]).toEqual(c1);
      expect(snapshot.cursors["peer-2"]["src/a.ts"]).toEqual(c2);
    });

    it("tracks cursors for multiple files per peer", () => {
      const c1 = makeCursor("peer-1", "src/a.ts");
      const c2 = makeCursor("peer-1", "src/b.ts");
      acc.accumulate(c1);
      acc.accumulate(c2);
      const snapshot = acc.getSnapshot();
      expect(snapshot.cursors["peer-1"]["src/a.ts"]).toEqual(c1);
      expect(snapshot.cursors["peer-1"]["src/b.ts"]).toEqual(c2);
    });
  });

  describe("accumulate() — buffer updates", () => {
    it("stores a buffer update per peer per file", () => {
      const update = makeBuffer("peer-1", "src/index.ts");
      acc.accumulate(update);
      const snapshot = acc.getSnapshot();
      expect(snapshot.buffers["peer-1"]["src/index.ts"]).toEqual(update);
    });

    it("overwrites buffer update for same peer and file", () => {
      acc.accumulate(makeBuffer("peer-1", "src/index.ts", 1));
      const newer = makeBuffer("peer-1", "src/index.ts", 2);
      acc.accumulate(newer);
      const snapshot = acc.getSnapshot();
      expect(snapshot.buffers["peer-1"]["src/index.ts"]).toEqual(newer);
    });

    it("tracks buffers for multiple peers independently", () => {
      const b1 = makeBuffer("peer-1", "src/a.ts");
      const b2 = makeBuffer("peer-2", "src/a.ts");
      acc.accumulate(b1);
      acc.accumulate(b2);
      const snapshot = acc.getSnapshot();
      expect(snapshot.buffers["peer-1"]["src/a.ts"]).toEqual(b1);
      expect(snapshot.buffers["peer-2"]["src/a.ts"]).toEqual(b2);
    });
  });

  describe("accumulate() — metadata updates (LWW)", () => {
    it("stores a metadata update", () => {
      const update = makeMetadata("peer-1", "theme", "dark");
      acc.accumulate(update);
      const snapshot = acc.getSnapshot();
      expect(snapshot.metadata["theme"]).toEqual(update);
    });

    it("newer timestamp wins over older", () => {
      acc.accumulate(makeMetadata("peer-1", "theme", "dark", 1000));
      const newer = makeMetadata("peer-2", "theme", "light", 2000);
      acc.accumulate(newer);
      const snapshot = acc.getSnapshot();
      expect(snapshot.metadata["theme"]).toEqual(newer);
    });

    it("older timestamp does not overwrite newer", () => {
      const existing = makeMetadata("peer-1", "theme", "dark", 2000);
      acc.accumulate(existing);
      acc.accumulate(makeMetadata("peer-2", "theme", "light", 1000));
      const snapshot = acc.getSnapshot();
      expect(snapshot.metadata["theme"]).toEqual(existing);
    });

    it("uses peerId as tiebreaker when timestamps are equal (higher peerId wins)", () => {
      acc.accumulate(makeMetadata("peer-a", "key", "val-a", 1000));
      const higher = makeMetadata("peer-z", "key", "val-z", 1000);
      acc.accumulate(higher);
      const snapshot = acc.getSnapshot();
      expect(snapshot.metadata["key"]).toEqual(higher);
    });

    it("lower peerId does not overwrite when timestamps are equal", () => {
      const existing = makeMetadata("peer-z", "key", "val-z", 1000);
      acc.accumulate(existing);
      acc.accumulate(makeMetadata("peer-a", "key", "val-a", 1000));
      const snapshot = acc.getSnapshot();
      expect(snapshot.metadata["key"]).toEqual(existing);
    });

    it("same peer overwrites own value at the same timestamp", () => {
      acc.accumulate(makeMetadata("peer-1", "key", "first", 1000));
      const second = makeMetadata("peer-1", "key", "second", 1000);
      acc.accumulate(second);
      const snapshot = acc.getSnapshot();
      expect(snapshot.metadata["key"]).toEqual(second);
    });

    it("tracks multiple metadata keys independently", () => {
      const m1 = makeMetadata("peer-1", "theme", "dark");
      const m2 = makeMetadata("peer-1", "language", "typescript");
      acc.accumulate(m1);
      acc.accumulate(m2);
      const snapshot = acc.getSnapshot();
      expect(snapshot.metadata["theme"]).toEqual(m1);
      expect(snapshot.metadata["language"]).toEqual(m2);
    });
  });

  describe("accumulate() — file-change updates", () => {
    it("tracks file hash from file-change update", () => {
      acc.accumulate(makeFileChange("peer-1", "src/index.ts", "hash-abc"));
      const snapshot = acc.getSnapshot();
      expect(snapshot.fileHashes["src/index.ts"]).toBe("hash-abc");
    });

    it("overwrites file hash with later update", () => {
      acc.accumulate(makeFileChange("peer-1", "src/index.ts", "hash-old"));
      acc.accumulate(makeFileChange("peer-1", "src/index.ts", "hash-new"));
      const snapshot = acc.getSnapshot();
      expect(snapshot.fileHashes["src/index.ts"]).toBe("hash-new");
    });

    it("tracks hashes for multiple files", () => {
      acc.accumulate(makeFileChange("peer-1", "src/a.ts", "hash-a"));
      acc.accumulate(makeFileChange("peer-2", "src/b.ts", "hash-b"));
      const snapshot = acc.getSnapshot();
      expect(snapshot.fileHashes["src/a.ts"]).toBe("hash-a");
      expect(snapshot.fileHashes["src/b.ts"]).toBe("hash-b");
    });
  });

  describe("accumulate() — lock updates", () => {
    it("tracks the current lock holder", () => {
      acc.accumulate(makeLockAcquire("peer-1", 1_000));
      expect(acc.getSnapshot(1_000).lock).toEqual({
        holderPeerId: "peer-1",
        acquiredAt: 1_000,
        status: "busy",
      });
    });

    it("releases the lock", () => {
      acc.accumulate(makeLockAcquire("peer-1", 1_000));
      acc.accumulate(makeLockRelease("peer-1", 2_000));
      expect(acc.getSnapshot().lock).toEqual({
        holderPeerId: null,
        acquiredAt: null,
        status: "free",
      });
    });

    it("auto-expires stale locks after the TTL", () => {
      const staleTimestamp = Date.now() - HOOP_LOCK_TTL_MS - 1;
      acc.accumulate(makeLockAcquire("peer-1", staleTimestamp));
      expect(acc.getSnapshot().lock).toEqual({
        holderPeerId: null,
        acquiredAt: null,
        status: "free",
      });
    });

    it("treats a stale lock as free before applying a new acquire", () => {
      const staleTimestamp = Date.now() - HOOP_LOCK_TTL_MS - 1;
      const freshTimestamp = Date.now();
      acc.accumulate(makeLockAcquire("peer-1", staleTimestamp));
      acc.accumulate(makeLockAcquire("peer-2", freshTimestamp));
      expect(acc.getLockSnapshot(freshTimestamp)).toEqual({
        holderPeerId: "peer-2",
        acquiredAt: freshTimestamp,
        status: "busy",
      });
    });
  });

  describe("getSnapshot()", () => {
    it("returns empty collections when nothing accumulated", () => {
      const snapshot = acc.getSnapshot();
      expect(snapshot.cursors).toEqual({});
      expect(snapshot.buffers).toEqual({});
      expect(snapshot.metadata).toEqual({});
      expect(snapshot.fileHashes).toEqual({});
      expect(snapshot.lock).toEqual({
        holderPeerId: null,
        acquiredAt: null,
        status: "free",
      });
    });

    it("returns correct structure with mixed updates", () => {
      acc.accumulate(makeCursor("peer-1", "src/a.ts"));
      acc.accumulate(makeBuffer("peer-2", "src/b.ts"));
      acc.accumulate(makeMetadata("peer-1", "theme", "dark"));
      acc.accumulate(makeFileChange("peer-1", "src/c.ts", "hash-c"));
      acc.accumulate(makeLockAcquire("peer-3", 3_000));

      const snapshot = acc.getSnapshot(3_000);
      expect(Object.keys(snapshot.cursors)).toEqual(["peer-1"]);
      expect(Object.keys(snapshot.buffers)).toEqual(["peer-2"]);
      expect(Object.keys(snapshot.metadata)).toEqual(["theme"]);
      expect(Object.keys(snapshot.fileHashes)).toEqual(["src/c.ts"]);
      expect(snapshot.lock).toEqual({
        holderPeerId: "peer-3",
        acquiredAt: 3_000,
        status: "busy",
      });
    });
  });

  describe("getFileHash()", () => {
    it("returns undefined for unknown file", () => {
      expect(acc.getFileHash("src/unknown.ts")).toBeUndefined();
    });

    it("returns the last known hash for a file", () => {
      acc.accumulate(makeFileChange("peer-1", "src/index.ts", "hash-xyz"));
      expect(acc.getFileHash("src/index.ts")).toBe("hash-xyz");
    });
  });

  describe("getMetadata()", () => {
    it("returns undefined for unknown key", () => {
      expect(acc.getMetadata("missing")).toBeUndefined();
    });

    it("returns the winning metadata update for a key", () => {
      const update = makeMetadata("peer-1", "theme", "dark", 2000);
      acc.accumulate(makeMetadata("peer-2", "theme", "light", 1000));
      acc.accumulate(update);
      expect(acc.getMetadata("theme")).toEqual(update);
    });
  });

  describe("getLockSnapshot()", () => {
    it("returns the current lock state", () => {
      acc.accumulate(makeLockAcquire("peer-1", 5_000));
      expect(acc.getLockSnapshot(5_000)).toEqual({
        holderPeerId: "peer-1",
        acquiredAt: 5_000,
        status: "busy",
      });
    });
  });

  describe("deriveExpiredLockRelease()", () => {
    it("returns a release update when the current lock is stale", () => {
      const staleTimestamp = Date.now() - HOOP_LOCK_TTL_MS - 1;
      const releaseTimestamp = Date.now();
      acc.accumulate(makeLockAcquire("peer-1", staleTimestamp));

      expect(acc.deriveExpiredLockRelease(releaseTimestamp)).toEqual({
        type: "lock-release",
        peerId: "peer-1",
        timestamp: releaseTimestamp,
      });
    });

    it("returns undefined when the lock is still fresh", () => {
      acc.accumulate(makeLockAcquire("peer-1", 1_000));
      expect(acc.deriveExpiredLockRelease(1_001)).toBeUndefined();
    });
  });

  describe("deriveLockReleaseForPeer()", () => {
    it("returns a release update when the holder disconnects", () => {
      acc.accumulate(makeLockAcquire("peer-1", 1_000));
      expect(acc.deriveLockReleaseForPeer("peer-1", 2_000)).toEqual({
        type: "lock-release",
        peerId: "peer-1",
        timestamp: 2_000,
      });
    });

    it("returns the expired release when the holder disconnects after the TTL", () => {
      const staleTimestamp = Date.now() - HOOP_LOCK_TTL_MS - 1;
      const disconnectTimestamp = Date.now();
      acc.accumulate(makeLockAcquire("peer-1", staleTimestamp));

      expect(acc.deriveLockReleaseForPeer("peer-1", disconnectTimestamp)).toEqual({
        type: "lock-release",
        peerId: "peer-1",
        timestamp: disconnectTimestamp,
      });
    });

    it("returns undefined for a non-holder", () => {
      acc.accumulate(makeLockAcquire("peer-1", 1_000));
      expect(acc.deriveLockReleaseForPeer("peer-2", 2_000)).toBeUndefined();
    });
  });

  describe("removePeerPresence()", () => {
    it("removes cursor data for the specified peer", () => {
      acc.accumulate(makeCursor("peer-1", "src/a.ts"));
      acc.accumulate(makeCursor("peer-2", "src/a.ts"));
      acc.removePeerPresence("peer-1");
      const snapshot = acc.getSnapshot();
      expect(snapshot.cursors["peer-1"]).toBeUndefined();
      expect(snapshot.cursors["peer-2"]).toBeDefined();
    });

    it("removes buffer data for the specified peer", () => {
      acc.accumulate(makeBuffer("peer-1", "src/a.ts"));
      acc.accumulate(makeBuffer("peer-2", "src/a.ts"));
      acc.removePeerPresence("peer-1");
      const snapshot = acc.getSnapshot();
      expect(snapshot.buffers["peer-1"]).toBeUndefined();
      expect(snapshot.buffers["peer-2"]).toBeDefined();
    });

    it("does not affect metadata or fileHashes when removing a peer", () => {
      acc.accumulate(makeMetadata("peer-1", "theme", "dark"));
      acc.accumulate(makeFileChange("peer-1", "src/a.ts", "hash-a"));
      acc.removePeerPresence("peer-1");
      const snapshot = acc.getSnapshot();
      expect(snapshot.metadata["theme"]).toBeDefined();
      expect(snapshot.fileHashes["src/a.ts"]).toBeDefined();
    });

    it("matches the production disconnect flow", () => {
      acc.accumulate(makeCursor("peer-1", "src/a.ts"));
      acc.accumulate(makeBuffer("peer-1", "src/a.ts"));
      acc.accumulate(makeLockAcquire("peer-1", 1_000));

      acc.removePeerPresence("peer-1");
      const release = acc.deriveLockReleaseForPeer("peer-1", 2_000);
      expect(release).toEqual({ type: "lock-release", peerId: "peer-1", timestamp: 2_000 });
      acc.accumulate(release!);

      const snapshot = acc.getSnapshot(2_000);
      expect(snapshot.cursors["peer-1"]).toBeUndefined();
      expect(snapshot.buffers["peer-1"]).toBeUndefined();
      expect(snapshot.lock).toEqual({
        holderPeerId: null,
        acquiredAt: null,
        status: "free",
      });
    });

    it("is a no-op for unknown peerId", () => {
      acc.accumulate(makeCursor("peer-1", "src/a.ts"));
      acc.removePeerPresence("peer-999");
      const snapshot = acc.getSnapshot();
      expect(snapshot.cursors["peer-1"]).toBeDefined();
    });
  });

  describe("clear()", () => {
    it("resets all state", () => {
      acc.accumulate(makeCursor("peer-1", "src/a.ts"));
      acc.accumulate(makeBuffer("peer-1", "src/b.ts"));
      acc.accumulate(makeMetadata("peer-1", "theme", "dark"));
      acc.accumulate(makeFileChange("peer-1", "src/c.ts", "hash-c"));
      acc.accumulate(makeLockAcquire("peer-1", 1_000));

      acc.clear();

      const snapshot = acc.getSnapshot();
      expect(snapshot.cursors).toEqual({});
      expect(snapshot.buffers).toEqual({});
      expect(snapshot.metadata).toEqual({});
      expect(snapshot.fileHashes).toEqual({});
      expect(snapshot.lock).toEqual({
        holderPeerId: null,
        acquiredAt: null,
        status: "free",
      });
    });

    it("allows accumulation after clear", () => {
      acc.accumulate(makeCursor("peer-1", "src/a.ts"));
      acc.clear();
      const update = makeCursor("peer-2", "src/b.ts");
      acc.accumulate(update);
      const snapshot = acc.getSnapshot();
      expect(snapshot.cursors["peer-2"]["src/b.ts"]).toEqual(update);
    });
  });
});
