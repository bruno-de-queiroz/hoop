import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
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
  // Suffix with process.pid to avoid collisions across concurrent hoop sessions on the same machine
  const filename = `${REGISTRY_FILENAME.replace(".json", "")}-${process.pid}.json`;
  return join(process.env.HOOP_REGISTRY_DIR || tmpdir(), filename);
}

// ── Writer ──────────────────────────────────────────────────────────

/**
 * Accumulates incoming file-change updates from peers into a JSON file
 * on disk so bash hooks can read and drain them.
 *
 * Only tracks `file-change` updates from other peers — cursor, buffer,
 * and metadata updates are ignored (those are handled by ActiveEditsTracker
 * or are not relevant for context injection).
 *
 * All writes are serialized via an in-process async mutex (promise chain) to
 * prevent lost updates when multiple concurrent calls to handleUpdate() occur.
 */
export class PendingUpdatesWriter {
  private readonly registryPath: string;
  private readonly selfPeerId: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(selfPeerId: string, registryPath?: string) {
    this.selfPeerId = selfPeerId;
    this.registryPath = registryPath ?? defaultPendingUpdatesPath();
  }

  /** Append a file-change update from another peer to the registry. */
  handleUpdate(update: StateUpdate): void {
    if (update.peerId === this.selfPeerId) return;
    if (update.type !== "file-change") return;

    // Serialize writes by enqueuing on the promise chain
    this.writeQueue = this.writeQueue.then(() => {
      const current = PendingUpdatesWriter.readRegistry(this.registryPath);
      const updates = current?.updates ?? [];
      updates.push({
        peerId: update.peerId,
        filePath: update.filePath,
        patch: update.patch,
        timestamp: update.timestamp,
      });
      this.writeAtomicSync({ updates, updatedAt: Date.now() });
    });
  }

  /** Clear all pending updates. */
  clear(): void {
    this.writeQueue = this.writeQueue.then(() => {
      this.writeAtomicSync({ updates: [], updatedAt: Date.now() });
    });
  }

  /** Wait for all pending writes to complete. Useful for testing. */
  async flushWrites(): Promise<void> {
    await this.writeQueue;
  }

  private writeAtomicSync(registry: PendingUpdatesRegistry): void {
    try {
      const dir = dirname(this.registryPath);
      mkdirSync(dir, { recursive: true });
      const tmpPath = this.registryPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(registry), "utf-8");
      renameSync(tmpPath, this.registryPath);
    } catch {
      // Best-effort: if we can't write, hooks will see stale data or no file
    }
  }

  /** Read the registry from disk. */
  static readRegistry(registryPath?: string): PendingUpdatesRegistry | null {
    const path = registryPath ?? defaultPendingUpdatesPath();
    if (!existsSync(path)) return null;
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
        const tmpPath = path + ".tmp";
        writeFileSync(tmpPath, JSON.stringify({ updates: [], updatedAt: Date.now() }), "utf-8");
        renameSync(tmpPath, path);
      } catch {
        // Best-effort
      }
    }
    return registry;
  }
}
