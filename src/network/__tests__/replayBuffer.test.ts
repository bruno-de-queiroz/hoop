import { describe, it, expect } from "vitest";
import { ReplayBuffer } from "../replayBuffer.js";
import type { BroadcastEnvelope } from "../../state/stateUpdate.js";

function makeEnvelope(seqNo: number): BroadcastEnvelope {
  return {
    seqNo,
    update: {
      type: "metadata-update",
      peerId: "peer-1",
      key: "test",
      value: seqNo,
      timestamp: seqNo * 1000,
    },
  };
}

describe("ReplayBuffer", () => {
  describe("push()", () => {
    it("stores envelopes", () => {
      const buf = new ReplayBuffer();
      buf.push(makeEnvelope(1));
      buf.push(makeEnvelope(2));
      expect(buf.getSize()).toBe(2);
    });

    it("evicts oldest when capacity exceeded", () => {
      const buf = new ReplayBuffer(3);
      buf.push(makeEnvelope(1));
      buf.push(makeEnvelope(2));
      buf.push(makeEnvelope(3));
      buf.push(makeEnvelope(4));
      expect(buf.getSize()).toBe(3);
      expect(buf.getOldestSeqNo()).toBe(2);
      expect(buf.getCurrentSeqNo()).toBe(4);
    });

    it("evicts immediately with capacity 1", () => {
      const buf = new ReplayBuffer(1);
      buf.push(makeEnvelope(1));
      buf.push(makeEnvelope(2));
      expect(buf.getSize()).toBe(1);
      expect(buf.getOldestSeqNo()).toBe(2);
      expect(buf.getCurrentSeqNo()).toBe(2);
    });
  });

  describe("replaySince()", () => {
    it("returns envelopes with seqNo > requested", () => {
      const buf = new ReplayBuffer();
      buf.push(makeEnvelope(1));
      buf.push(makeEnvelope(2));
      buf.push(makeEnvelope(3));
      const result = buf.replaySince(1);
      expect(result.map(e => e.seqNo)).toEqual([2, 3]);
    });

    it("returns empty array when seqNo is beyond buffer", () => {
      const buf = new ReplayBuffer();
      buf.push(makeEnvelope(1));
      buf.push(makeEnvelope(2));
      const result = buf.replaySince(10);
      expect(result).toEqual([]);
    });

    it("returns all entries when seqNo is 0", () => {
      const buf = new ReplayBuffer();
      buf.push(makeEnvelope(1));
      buf.push(makeEnvelope(2));
      buf.push(makeEnvelope(3));
      const result = buf.replaySince(0);
      expect(result.map(e => e.seqNo)).toEqual([1, 2, 3]);
    });

    it("returns empty array on empty buffer", () => {
      const buf = new ReplayBuffer();
      expect(buf.replaySince(0)).toEqual([]);
    });
  });

  describe("getOldestSeqNo()", () => {
    it("returns first seqNo in buffer", () => {
      const buf = new ReplayBuffer();
      buf.push(makeEnvelope(5));
      buf.push(makeEnvelope(6));
      expect(buf.getOldestSeqNo()).toBe(5);
    });

    it("returns undefined for empty buffer", () => {
      const buf = new ReplayBuffer();
      expect(buf.getOldestSeqNo()).toBeUndefined();
    });
  });

  describe("getCurrentSeqNo()", () => {
    it("returns last seqNo in buffer", () => {
      const buf = new ReplayBuffer();
      buf.push(makeEnvelope(1));
      buf.push(makeEnvelope(7));
      expect(buf.getCurrentSeqNo()).toBe(7);
    });

    it("returns undefined for empty buffer", () => {
      const buf = new ReplayBuffer();
      expect(buf.getCurrentSeqNo()).toBeUndefined();
    });
  });

  describe("getSize()", () => {
    it("returns current count", () => {
      const buf = new ReplayBuffer();
      expect(buf.getSize()).toBe(0);
      buf.push(makeEnvelope(1));
      expect(buf.getSize()).toBe(1);
      buf.push(makeEnvelope(2));
      expect(buf.getSize()).toBe(2);
    });
  });

  describe("clear()", () => {
    it("empties the buffer", () => {
      const buf = new ReplayBuffer();
      buf.push(makeEnvelope(1));
      buf.push(makeEnvelope(2));
      buf.clear();
      expect(buf.getSize()).toBe(0);
      expect(buf.getOldestSeqNo()).toBeUndefined();
      expect(buf.getCurrentSeqNo()).toBeUndefined();
    });
  });
});
