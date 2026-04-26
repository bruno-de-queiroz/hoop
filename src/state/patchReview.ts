import { randomUUID } from "node:crypto";
import type { StateUpdate } from "./stateUpdate.js";

export type PatchReviewStatus = "pending-review" | "approved" | "rejected";

export interface PatchReviewEntry {
  filePath: string;
  patch: string;
  update: StateUpdate;
}

export interface QueuedPatchReview {
  reviewId: string;
  peerId: string;
  entries: PatchReviewEntry[];
  status: PatchReviewStatus;
  reason?: string;
  createdAt: number;
  resolvedAt?: number;
}

function isTerminal(status: PatchReviewStatus): boolean {
  return status === "approved" || status === "rejected";
}

const TERMINAL_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Per-peer batch queue for file-change patches awaiting captain review.
 *
 * Each peer accumulates file-change updates into a single pending batch.
 * The host approves or rejects the entire batch for a given peer.
 */
export class PatchReviewQueue {
  private readonly reviews = new Map<string, QueuedPatchReview>();

  /** Peer-ID → reviewId for the currently pending batch. */
  private readonly pendingByPeer = new Map<string, string>();

  private evictStale(): void {
    const cutoff = Date.now() - TERMINAL_TTL_MS;
    for (const [id, review] of this.reviews) {
      if (isTerminal(review.status) && review.resolvedAt !== undefined && review.resolvedAt < cutoff) {
        this.reviews.delete(id);
      }
    }
  }

  /**
   * Enqueue a file-change update for captain review.
   * If the peer already has a pending batch, the update is appended to it.
   * Returns the reviewId (stable per pending batch per peer).
   */
  enqueue(update: StateUpdate & { type: "file-change" }, peerId: string): string {
    this.evictStale();

    const existingId = this.pendingByPeer.get(peerId);
    if (existingId) {
      const existing = this.reviews.get(existingId);
      if (existing && existing.status === "pending-review") {
        existing.entries.push({
          filePath: update.filePath,
          patch: update.patch,
          update,
        });
        return existingId;
      }
      // Stale mapping — the review was evicted or resolved; clean up
      this.pendingByPeer.delete(peerId);
    }

    const reviewId = randomUUID();
    const review: QueuedPatchReview = {
      reviewId,
      peerId,
      entries: [{
        filePath: update.filePath,
        patch: update.patch,
        update,
      }],
      status: "pending-review",
      createdAt: Date.now(),
    };
    this.reviews.set(reviewId, review);
    this.pendingByPeer.set(peerId, reviewId);
    return reviewId;
  }

  get(reviewId: string): QueuedPatchReview | undefined {
    this.evictStale();
    return this.reviews.get(reviewId);
  }

  /** Returns all reviews that are still pending. */
  listPending(): QueuedPatchReview[] {
    this.evictStale();
    return Array.from(this.reviews.values()).filter(
      (r) => r.status === "pending-review",
    );
  }

  /** Returns the pending review for a specific peer, if any. */
  getPendingForPeer(peerId: string): QueuedPatchReview | undefined {
    this.evictStale();
    const reviewId = this.pendingByPeer.get(peerId);
    if (!reviewId) return undefined;
    const review = this.reviews.get(reviewId);
    if (!review || review.status !== "pending-review") return undefined;
    return review;
  }

  /**
   * Approve all pending patches for a peer.
   * Returns the approved review (with held updates) or undefined if no pending review.
   */
  approve(peerId: string): QueuedPatchReview | undefined {
    this.evictStale();
    const reviewId = this.pendingByPeer.get(peerId);
    if (!reviewId) return undefined;
    const review = this.reviews.get(reviewId);
    if (!review || review.status !== "pending-review") return undefined;

    review.status = "approved";
    review.resolvedAt = Date.now();
    this.pendingByPeer.delete(peerId);
    return review;
  }

  /**
   * Reject all pending patches for a peer.
   * Returns the rejected review or undefined if no pending review.
   */
  reject(peerId: string, reason?: string): QueuedPatchReview | undefined {
    this.evictStale();
    const reviewId = this.pendingByPeer.get(peerId);
    if (!reviewId) return undefined;
    const review = this.reviews.get(reviewId);
    if (!review || review.status !== "pending-review") return undefined;

    review.status = "rejected";
    review.reason = reason;
    review.resolvedAt = Date.now();
    this.pendingByPeer.delete(peerId);
    return review;
  }

  size(): number {
    return this.reviews.size;
  }

  clear(): void {
    this.reviews.clear();
    this.pendingByPeer.clear();
  }
}
