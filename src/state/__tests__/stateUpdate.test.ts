import { describe, it, expect } from "vitest";
import { isStateUpdate } from "../../state/stateUpdate.js";

describe("isStateUpdate", () => {
  // --- valid inputs ---

  it("returns true for a valid cursor-update", () => {
    expect(
      isStateUpdate({
        type: "cursor-update",
        peerId: "peer-1",
        filePath: "/src/index.ts",
        line: 10,
        column: 5,
        timestamp: 1700000000000,
      })
    ).toBe(true);
  });

  it("returns true for a valid buffer-update", () => {
    expect(
      isStateUpdate({
        type: "buffer-update",
        peerId: "peer-2",
        filePath: "/src/app.ts",
        contentHash: "abc123",
        version: 3,
        dirty: false,
        timestamp: 1700000000001,
      })
    ).toBe(true);
  });

  it("returns true for a valid metadata-update", () => {
    expect(
      isStateUpdate({
        type: "metadata-update",
        peerId: "peer-3",
        key: "theme",
        value: "dark",
        timestamp: 1700000000002,
      })
    ).toBe(true);
  });

  it("returns true for metadata-update with value: null", () => {
    expect(
      isStateUpdate({
        type: "metadata-update",
        peerId: "peer-3",
        key: "theme",
        value: null,
        timestamp: 1700000000003,
      })
    ).toBe(true);
  });

  it("returns true for metadata-update with value: false", () => {
    expect(
      isStateUpdate({
        type: "metadata-update",
        peerId: "peer-3",
        key: "enabled",
        value: false,
        timestamp: 1700000000004,
      })
    ).toBe(true);
  });

  // --- non-object inputs ---

  it("returns false for null", () => {
    expect(isStateUpdate(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isStateUpdate(undefined)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isStateUpdate("cursor-update")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isStateUpdate(42)).toBe(false);
  });

  // --- missing top-level required fields ---

  it("returns false for object missing type", () => {
    expect(
      isStateUpdate({
        peerId: "peer-1",
        filePath: "/src/index.ts",
        line: 10,
        column: 5,
        timestamp: 1700000000000,
      })
    ).toBe(false);
  });

  it("returns false for object missing peerId", () => {
    expect(
      isStateUpdate({
        type: "cursor-update",
        filePath: "/src/index.ts",
        line: 10,
        column: 5,
        timestamp: 1700000000000,
      })
    ).toBe(false);
  });

  it("returns false for object missing timestamp", () => {
    expect(
      isStateUpdate({
        type: "cursor-update",
        peerId: "peer-1",
        filePath: "/src/index.ts",
        line: 10,
        column: 5,
      })
    ).toBe(false);
  });

  // --- unknown type ---

  it("returns false for an unknown type string", () => {
    expect(
      isStateUpdate({
        type: "unknown-update",
        peerId: "peer-1",
        timestamp: 1700000000000,
      })
    ).toBe(false);
  });

  it("returns true for a valid file-change", () => {
    expect(
      isStateUpdate({
        type: "file-change",
        peerId: "peer-4",
        filePath: "src/index.ts",
        patch: "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new",
        baseHash: "abc123",
        resultHash: "def456",
        timestamp: 1700000000005,
      })
    ).toBe(true);
  });

  it("returns true for a valid lock-acquire", () => {
    expect(
      isStateUpdate({
        type: "lock-acquire",
        peerId: "peer-5",
        timestamp: 1700000000006,
      })
    ).toBe(true);
  });

  it("returns true for a valid lock-release", () => {
    expect(
      isStateUpdate({
        type: "lock-release",
        peerId: "peer-5",
        timestamp: 1700000000007,
      })
    ).toBe(true);
  });

  // --- type-specific missing fields ---

  it("returns false for cursor-update missing line", () => {
    expect(
      isStateUpdate({
        type: "cursor-update",
        peerId: "peer-1",
        filePath: "/src/index.ts",
        column: 5,
        timestamp: 1700000000000,
      })
    ).toBe(false);
  });

  it("returns false for buffer-update missing dirty", () => {
    expect(
      isStateUpdate({
        type: "buffer-update",
        peerId: "peer-2",
        filePath: "/src/app.ts",
        contentHash: "abc123",
        version: 3,
        timestamp: 1700000000001,
      })
    ).toBe(false);
  });

  it("returns false for metadata-update missing value", () => {
    expect(
      isStateUpdate({
        type: "metadata-update",
        peerId: "peer-3",
        key: "theme",
        timestamp: 1700000000002,
      })
    ).toBe(false);
  });

  it("returns false for file-change missing patch", () => {
    expect(
      isStateUpdate({
        type: "file-change",
        peerId: "peer-4",
        filePath: "src/index.ts",
        baseHash: "abc123",
        resultHash: "def456",
        timestamp: 1700000000005,
      })
    ).toBe(false);
  });

  it("returns false for file-change missing baseHash", () => {
    expect(
      isStateUpdate({
        type: "file-change",
        peerId: "peer-4",
        filePath: "src/index.ts",
        patch: "--- a/f\n+++ b/f\n@@ -1 +1 @@",
        resultHash: "def456",
        timestamp: 1700000000005,
      })
    ).toBe(false);
  });

  it("accepts a valid session-note", () => {
    expect(
      isStateUpdate({
        type: "session-note",
        peerId: "peer-1",
        text: "trying the map() approach",
        timestamp: 1700000000000,
      })
    ).toBe(true);
  });

  it("accepts a session-note with optional author", () => {
    expect(
      isStateUpdate({
        type: "session-note",
        peerId: "peer-1",
        author: "alice@example.com",
        text: "lgtm",
        timestamp: 1700000000000,
      })
    ).toBe(true);
  });

  it("rejects session-note with empty text", () => {
    expect(
      isStateUpdate({
        type: "session-note",
        peerId: "peer-1",
        text: "",
        timestamp: 1700000000000,
      })
    ).toBe(false);
  });

  it("rejects session-note with whitespace-only text", () => {
    expect(
      isStateUpdate({
        type: "session-note",
        peerId: "peer-1",
        text: "   \n\t  ",
        timestamp: 1700000000000,
      })
    ).toBe(false);
  });

  it("rejects session-note with text exceeding 4000 chars", () => {
    expect(
      isStateUpdate({
        type: "session-note",
        peerId: "peer-1",
        text: "a".repeat(4001),
        timestamp: 1700000000000,
      })
    ).toBe(false);
  });

  it("rejects session-note with author exceeding 256 chars", () => {
    expect(
      isStateUpdate({
        type: "session-note",
        peerId: "peer-1",
        author: "a".repeat(257),
        text: "valid text",
        timestamp: 1700000000000,
      })
    ).toBe(false);
  });
});
