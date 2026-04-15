import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { StateUpdate } from "./stateUpdate.js";

// ── Types ───────────────────────────────────────────────────────────

export interface PendingUpdate {
  peerId: string;
  filePath: string;
  patch: string;
  timestamp: number;
}

export interface PendingUpdatesRegistry {
  updates: PendingUpdate[];
  updatedAt: number;
}

// ── Default path ────────────────────────────────────────────────────

const REGISTRY_FILENAME = "hoop-pending-updates.json";

export function defaultPendingUpdatesPath(): string {
  return join(tmpdir(), REGISTRY_FILENAME);
}

// ── Writer ──────────────────────────────────────────────────────────

/**
 * Accumulates incoming file-change updates from peers into a JSON file
 * on disk so bash hooks can read and drain them.
 *
 * Only tracks `file-change` updates from other peers — cursor, buffer,
 * and metadata updates are ignored (those are handled by ActiveEditsTracker
 * or are not relevant for context injection).
 */
export class PendingUpdatesWriter {
  private readonly registryPath: string;
  private readonly selfPeerId: string;

  constructor(selfPeerId: string, registryPath?: string) {
    this.selfPeerId = selfPeerId;
    this.registryPath = registryPath ?? defaultPendingUpdatesPath();
  }

  /** Append a file-change update from another peer to the registry. */
  handleUpdate(update: StateUpdate): void {
    if (update.peerId === this.selfPeerId) return;
    if (update.type !== "file-change") return;

    const current = PendingUpdatesWriter.readRegistry(this.registryPath);
    const updates = current?.updates ?? [];

    updates.push({
      peerId: update.peerId,
      filePath: update.filePath,
      patch: update.patch,
      timestamp: update.timestamp,
    });

    this.write({ updates, updatedAt: Date.now() });
  }

  /** Clear all pending updates. */
  clear(): void {
    this.write({ updates: [], updatedAt: Date.now() });
  }

  private write(registry: PendingUpdatesRegistry): void {
    try {
      mkdirSync(dirname(this.registryPath), { recursive: true });
      writeFileSync(this.registryPath, JSON.stringify(registry), "utf-8");
    } catch {
      // Best-effort: if we can't write, hooks will see stale data or no file
    }
  }

  /** Read the registry from disk. */
  static readRegistry(registryPath?: string): PendingUpdatesRegistry | null {
    const path = registryPath ?? defaultPendingUpdatesPath();
    try {
      const data = readFileSync(path, "utf-8");
      return JSON.parse(data) as PendingUpdatesRegistry;
    } catch {
      return null;
    }
  }

  /** Read all updates and drain (clear) the file. Used by hook scripts. */
  static readAndDrain(registryPath?: string): PendingUpdatesRegistry | null {
    const path = registryPath ?? defaultPendingUpdatesPath();
    const registry = PendingUpdatesWriter.readRegistry(path);
    if (registry && registry.updates.length > 0) {
      try {
        writeFileSync(path, JSON.stringify({ updates: [], updatedAt: Date.now() }), "utf-8");
      } catch {
        // Best-effort
      }
    }
    return registry;
  }
}
