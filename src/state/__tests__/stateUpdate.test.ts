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
});
