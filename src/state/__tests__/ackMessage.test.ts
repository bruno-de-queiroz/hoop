import { describe, it, expect } from "vitest";
import { isAckMessage } from "../../state/stateUpdate.js";

describe("isAckMessage", () => {
  it("returns true for a valid ack message", () => {
    expect(
      isAckMessage({
        type: "ack",
        peerId: "peer-1",
        lastSeqNo: 42,
      })
    ).toBe(true);
  });

  it("returns true for a valid ack message with lastSeqNo of 0", () => {
    expect(
      isAckMessage({
        type: "ack",
        peerId: "peer-2",
        lastSeqNo: 0,
      })
    ).toBe(true);
  });

  it("returns false when type field is missing", () => {
    expect(
      isAckMessage({
        peerId: "peer-1",
        lastSeqNo: 5,
      })
    ).toBe(false);
  });

  it("returns false when type field is wrong", () => {
    expect(
      isAckMessage({
        type: "cursor-update",
        peerId: "peer-1",
        lastSeqNo: 5,
      })
    ).toBe(false);
  });

  it("returns false when peerId is missing", () => {
    expect(
      isAckMessage({
        type: "ack",
        lastSeqNo: 5,
      })
    ).toBe(false);
  });

  it("returns false when peerId is not a string", () => {
    expect(
      isAckMessage({
        type: "ack",
        peerId: 123,
        lastSeqNo: 5,
      })
    ).toBe(false);
  });

  it("returns false when lastSeqNo is missing", () => {
    expect(
      isAckMessage({
        type: "ack",
        peerId: "peer-1",
      })
    ).toBe(false);
  });

  it("returns false when lastSeqNo is not a number", () => {
    expect(
      isAckMessage({
        type: "ack",
        peerId: "peer-1",
        lastSeqNo: "5",
      })
    ).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAckMessage(null)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isAckMessage("ack")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isAckMessage(42)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAckMessage(undefined)).toBe(false);
  });
});
