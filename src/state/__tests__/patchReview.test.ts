import { describe, it, expect, beforeEach } from "vitest";
import { PatchReviewQueue } from "../patchReview.js";
import type { StateUpdate } from "../stateUpdate.js";

function makeFileChange(filePath: string, peerId: string, patch = "fake-patch"): StateUpdate & { type: "file-change" } {
  return {
    type: "file-change",
    filePath,
    patch,
    baseHash: "abc123",
    resultHash: "def456",
    peerId,
    timestamp: Date.now(),
  };
}

describe("PatchReviewQueue", () => {
  let queue: PatchReviewQueue;

  beforeEach(() => {
    queue = new PatchReviewQueue();
  });

  it("enqueues a file-change and returns a reviewId", () => {
    const update = makeFileChange("src/foo.ts", "peer-A");
    const reviewId = queue.enqueue(update, "peer-A");

    expect(typeof reviewId).toBe("string");
    expect(reviewId.length).toBeGreaterThan(0);

    const review = queue.get(reviewId);
    expect(review).toBeDefined();
    expect(review!.status).toBe("pending-review");
    expect(review!.peerId).toBe("peer-A");
    expect(review!.entries).toHaveLength(1);
    expect(review!.entries[0].filePath).toBe("src/foo.ts");
  });

  it("batches multiple file-changes from the same peer", () => {
    const update1 = makeFileChange("src/foo.ts", "peer-A");
    const update2 = makeFileChange("src/bar.ts", "peer-A");
    const id1 = queue.enqueue(update1, "peer-A");
    const id2 = queue.enqueue(update2, "peer-A");

    expect(id1).toBe(id2);

    const review = queue.get(id1);
    expect(review!.entries).toHaveLength(2);
    expect(review!.entries[0].filePath).toBe("src/foo.ts");
    expect(review!.entries[1].filePath).toBe("src/bar.ts");
  });

  it("keeps separate batches for different peers", () => {
    const idA = queue.enqueue(makeFileChange("src/foo.ts", "peer-A"), "peer-A");
    const idB = queue.enqueue(makeFileChange("src/bar.ts", "peer-B"), "peer-B");

    expect(idA).not.toBe(idB);

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);
  });

  it("listPending returns only pending reviews", () => {
    queue.enqueue(makeFileChange("src/foo.ts", "peer-A"), "peer-A");
    queue.enqueue(makeFileChange("src/bar.ts", "peer-B"), "peer-B");
    queue.approve("peer-A");

    const pending = queue.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].peerId).toBe("peer-B");
  });

  it("getPendingForPeer returns the pending review for a peer", () => {
    queue.enqueue(makeFileChange("src/foo.ts", "peer-A"), "peer-A");

    const review = queue.getPendingForPeer("peer-A");
    expect(review).toBeDefined();
    expect(review!.peerId).toBe("peer-A");

    expect(queue.getPendingForPeer("peer-B")).toBeUndefined();
  });

  it("approve resolves the batch and returns held updates", () => {
    queue.enqueue(makeFileChange("src/foo.ts", "peer-A"), "peer-A");
    queue.enqueue(makeFileChange("src/bar.ts", "peer-A"), "peer-A");

    const approved = queue.approve("peer-A");
    expect(approved).toBeDefined();
    expect(approved!.status).toBe("approved");
    expect(approved!.entries).toHaveLength(2);
    expect(approved!.resolvedAt).toBeDefined();

    expect(queue.listPending()).toHaveLength(0);
    expect(queue.getPendingForPeer("peer-A")).toBeUndefined();
  });

  it("reject resolves the batch with reason", () => {
    queue.enqueue(makeFileChange("src/foo.ts", "peer-A"), "peer-A");

    const rejected = queue.reject("peer-A", "Changes conflict with ongoing work");
    expect(rejected).toBeDefined();
    expect(rejected!.status).toBe("rejected");
    expect(rejected!.reason).toBe("Changes conflict with ongoing work");
    expect(rejected!.resolvedAt).toBeDefined();

    expect(queue.listPending()).toHaveLength(0);
  });

  it("approve returns undefined for unknown peer", () => {
    expect(queue.approve("unknown-peer")).toBeUndefined();
  });

  it("reject returns undefined for unknown peer", () => {
    expect(queue.reject("unknown-peer")).toBeUndefined();
  });

  it("approve returns undefined for already-resolved batch", () => {
    queue.enqueue(makeFileChange("src/foo.ts", "peer-A"), "peer-A");
    queue.approve("peer-A");

    // Second approve should return undefined
    expect(queue.approve("peer-A")).toBeUndefined();
  });

  it("new enqueue after approval creates a fresh batch", () => {
    const id1 = queue.enqueue(makeFileChange("src/foo.ts", "peer-A"), "peer-A");
    queue.approve("peer-A");

    const id2 = queue.enqueue(makeFileChange("src/bar.ts", "peer-A"), "peer-A");
    expect(id2).not.toBe(id1);

    const review = queue.get(id2);
    expect(review!.entries).toHaveLength(1);
    expect(review!.entries[0].filePath).toBe("src/bar.ts");
  });

  it("new enqueue after rejection creates a fresh batch", () => {
    const id1 = queue.enqueue(makeFileChange("src/foo.ts", "peer-A"), "peer-A");
    queue.reject("peer-A", "not now");

    const id2 = queue.enqueue(makeFileChange("src/bar.ts", "peer-A"), "peer-A");
    expect(id2).not.toBe(id1);
  });

  it("poll by reviewId returns status after approval", () => {
    const reviewId = queue.enqueue(makeFileChange("src/foo.ts", "peer-A"), "peer-A");
    queue.approve("peer-A");

    const review = queue.get(reviewId);
    expect(review!.status).toBe("approved");
  });

  it("poll by reviewId returns status after rejection", () => {
    const reviewId = queue.enqueue(makeFileChange("src/foo.ts", "peer-A"), "peer-A");
    queue.reject("peer-A", "bad approach");

    const review = queue.get(reviewId);
    expect(review!.status).toBe("rejected");
    expect(review!.reason).toBe("bad approach");
  });

  it("clear removes all entries", () => {
    queue.enqueue(makeFileChange("src/foo.ts", "peer-A"), "peer-A");
    queue.enqueue(makeFileChange("src/bar.ts", "peer-B"), "peer-B");

    queue.clear();
    expect(queue.size()).toBe(0);
    expect(queue.listPending()).toHaveLength(0);
  });
});
