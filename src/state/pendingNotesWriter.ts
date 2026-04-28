import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { StateUpdate } from "./stateUpdate.js";

export interface PendingNote {
  peerId: string;
  author?: string;
  text: string;
  timestamp: number;
}

export interface PendingNotesRegistry {
  notes: PendingNote[];
  updatedAt: number;
}

const REGISTRY_FILENAME = "hoop-pending-notes.json";

export function defaultPendingNotesPath(): string {
  const filename = `${REGISTRY_FILENAME.replace(".json", "")}-${process.pid}.json`;
  return join(process.env.HOOP_REGISTRY_DIR || tmpdir(), filename);
}

/**
 * Accumulates incoming session-note updates from peers into a JSON file
 * on disk so bash hooks can drain them into additionalContext on the
 * next user prompt.
 *
 * Only tracks `session-note` updates from other peers — own notes are
 * skipped (the author already has them in their conversation context).
 *
 * Writes serialized via an in-process async mutex (promise chain).
 */
export class PendingNotesWriter {
  private readonly registryPath: string;
  private readonly selfPeerId: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(selfPeerId: string, registryPath?: string) {
    this.selfPeerId = selfPeerId;
    this.registryPath = registryPath ?? defaultPendingNotesPath();
  }

  handleUpdate(update: StateUpdate): void {
    if (update.peerId === this.selfPeerId) return;
    if (update.type !== "session-note") return;

    this.enqueue(() => {
      const current = PendingNotesWriter.readRegistry(this.registryPath);
      const notes = current?.notes ?? [];
      notes.push({
        peerId: update.peerId,
        author: update.author,
        text: update.text,
        timestamp: update.timestamp,
      });
      this.writeAtomicSync({ notes, updatedAt: Date.now() });
    });
  }

  clear(): void {
    this.enqueue(() => {
      this.writeAtomicSync({ notes: [], updatedAt: Date.now() });
    });
  }

  private enqueue(task: () => void): void {
    this.writeQueue = this.writeQueue.then(task).catch(() => {
      // A single I/O failure must not break subsequent writes.
    });
  }

  async flushWrites(): Promise<void> {
    await this.writeQueue;
  }

  private writeAtomicSync(registry: PendingNotesRegistry): void {
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

  static readRegistry(registryPath?: string): PendingNotesRegistry | null {
    const path = registryPath ?? defaultPendingNotesPath();
    if (!existsSync(path)) return null;
    try {
      const data = readFileSync(path, "utf-8");
      return JSON.parse(data) as PendingNotesRegistry;
    } catch {
      return null;
    }
  }

  static readAndDrain(registryPath?: string): PendingNotesRegistry | null {
    const path = registryPath ?? defaultPendingNotesPath();
    const registry = PendingNotesWriter.readRegistry(path);
    if (registry && registry.notes.length > 0) {
      try {
        const tmpPath = path + ".tmp";
        writeFileSync(tmpPath, JSON.stringify({ notes: [], updatedAt: Date.now() }), "utf-8");
        renameSync(tmpPath, path);
      } catch {
        // Best-effort
      }
    }
    return registry;
  }
}
