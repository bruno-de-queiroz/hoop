import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { PatchReviewStatus } from "./patchReview.js";

export interface PendingPatchReviewFileEntry {
  filePath: string;
  patchPreview: string;
}

export interface PendingPatchReviewEntry {
  reviewId: string;
  peerId: string;
  status: PatchReviewStatus;
  createdAt: number;
  files: PendingPatchReviewFileEntry[];
}

export interface PendingPatchReviewsRegistry {
  reviews: PendingPatchReviewEntry[];
  updatedAt: number;
}

const REGISTRY_FILENAME = "hoop-pending-patch-reviews.json";

export function defaultPendingPatchReviewsPath(): string {
  return join(process.env.HOOP_REGISTRY_DIR || tmpdir(), REGISTRY_FILENAME);
}

export class PendingPatchReviewsWriter {
  private readonly registryPath: string;

  constructor(registryPath?: string) {
    this.registryPath = registryPath ?? defaultPendingPatchReviewsPath();
  }

  sync(reviews: PendingPatchReviewEntry[]): void {
    this.write({ reviews, updatedAt: Date.now() });
  }

  clear(): void {
    this.sync([]);
  }

  private write(registry: PendingPatchReviewsRegistry): void {
    try {
      mkdirSync(dirname(this.registryPath), { recursive: true });
      writeFileSync(this.registryPath, JSON.stringify(registry), "utf-8");
    } catch {
      // Best-effort: if we can't write, hooks will see stale data or no file
    }
  }

  static readRegistry(registryPath?: string): PendingPatchReviewsRegistry | null {
    const path = registryPath ?? defaultPendingPatchReviewsPath();
    try {
      const data = readFileSync(path, "utf-8");
      const parsed: unknown = JSON.parse(data);
      if (
        typeof parsed !== "object" || parsed === null ||
        !Array.isArray((parsed as Record<string, unknown>)["reviews"]) ||
        typeof (parsed as Record<string, unknown>)["updatedAt"] !== "number"
      ) {
        return null;
      }
      return parsed as PendingPatchReviewsRegistry;
    } catch {
      return null;
    }
  }
}
