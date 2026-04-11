import { describe, it, expect } from "vitest";
import {
  createEmptyStateTree,
  type StateTree,
  type QueueItem,
  type SidelineItem,
} from "../stateTree.js";

describe("StateTree", () => {
  describe("createEmptyStateTree", () => {
    it("returns a state tree with empty queue", () => {
      const tree = createEmptyStateTree();
      expect(tree.queue).toEqual([]);
    });

    it("returns a state tree with empty sideline pool", () => {
      const tree = createEmptyStateTree();
      expect(tree.sidelinePool).toEqual([]);
    });

    it("returns a state tree with empty metadata", () => {
      const tree = createEmptyStateTree();
      expect(tree.metadata).toEqual({});
    });

    it("returns independent instances on each call", () => {
      const a = createEmptyStateTree();
      const b = createEmptyStateTree();
      a.queue.push({ id: "1", type: "test", payload: null, createdAt: "2026-01-01" });
      expect(b.queue).toEqual([]);
    });
  });

  describe("StateTree structure", () => {
    it("holds queue items with expected shape", () => {
      const item: QueueItem = {
        id: "q1",
        type: "task",
        payload: { command: "build" },
        createdAt: "2026-04-11T00:00:00Z",
      };
      const tree = createEmptyStateTree();
      tree.queue.push(item);
      expect(tree.queue).toHaveLength(1);
      expect(tree.queue[0]).toEqual(item);
    });

    it("holds sideline items with reason field", () => {
      const item: SidelineItem = {
        id: "s1",
        type: "deferred",
        payload: { file: "index.ts" },
        createdAt: "2026-04-11T00:00:00Z",
        reason: "blocked by review",
      };
      const tree = createEmptyStateTree();
      tree.sidelinePool.push(item);
      expect(tree.sidelinePool).toHaveLength(1);
      expect(tree.sidelinePool[0].reason).toBe("blocked by review");
    });

    it("supports arbitrary metadata keys", () => {
      const tree = createEmptyStateTree();
      tree.metadata["cursor"] = { line: 42, col: 10 };
      tree.metadata["version"] = 3;
      expect(tree.metadata["cursor"]).toEqual({ line: 42, col: 10 });
      expect(tree.metadata["version"]).toBe(3);
    });
  });
});
