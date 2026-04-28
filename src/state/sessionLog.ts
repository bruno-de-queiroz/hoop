import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { StateUpdate } from "./stateUpdate.js";

export interface SessionLogEntry {
  ts: number;
  type: StateUpdate["type"];
  peerId: string;
  payload: StateUpdate;
}

export interface SessionLog {
  entries: SessionLogEntry[];
  updatedAt: number;
}

export interface SessionLogQuery {
  peerId?: string;
  limit?: number;
}

const REGISTRY_FILENAME = "hoop-session-log.json";

export function defaultSessionLogPath(): string {
  const filename = `${REGISTRY_FILENAME.replace(".json", "")}-${process.pid}.json`;
  return join(process.env.HOOP_REGISTRY_DIR || tmpdir(), filename);
}

const DEFAULT_MAX_ENTRIES = 5000;

function resolveMaxEntries(): number {
  const raw = process.env.HOOP_SESSION_LOG_MAX_ENTRIES;
  if (!raw) return DEFAULT_MAX_ENTRIES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ENTRIES;
  return parsed;
}

/**
 * Append-only log of every observed StateUpdate (own + received) for the
 * lifetime of a hoop session. Source of truth for the export, replay, and
 * retrospective skills.
 *
 * Held in memory + mirrored to disk so external tools can read it. Must be
 * explicitly reset() at session leave so the next session starts clean.
 *
 * Writes serialized via an in-process async mutex (promise chain). The chain
 *'s catch is wired so a single I/O failure does not break subsequent writes.
 */
export class SessionLogAggregator {
  private readonly registryPath: string;
  private readonly maxEntries: number;
  private entries: SessionLogEntry[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(registryPath?: string, maxEntries?: number) {
    this.registryPath = registryPath ?? defaultSessionLogPath();
    this.maxEntries = maxEntries ?? resolveMaxEntries();
  }

  append(update: StateUpdate): void {
    // Queue both the in-memory mutation AND the disk write inside the
    // serialized chain. Mutating `entries` synchronously here would race
    // with reset() — the push would land in the about-to-be-cleared array.
    const entry: SessionLogEntry = {
      ts: Date.now(),
      type: update.type,
      peerId: update.peerId,
      payload: update,
    };
    this.enqueue(() => {
      this.entries.push(entry);
      if (this.entries.length > this.maxEntries) {
        this.entries.splice(0, this.entries.length - this.maxEntries);
      }
      this.writeAtomicSync({
        entries: [...this.entries],
        updatedAt: Date.now(),
      });
    });
  }

  getSnapshot(): SessionLog {
    return {
      entries: [...this.entries],
      updatedAt: Date.now(),
    };
  }

  /** Single query path used by hoop_session_log — peer filter + last-N slice. */
  query(opts: SessionLogQuery = {}): SessionLogEntry[] {
    const { peerId, limit } = opts;
    const matched = peerId !== undefined
      ? this.entries.filter((e) => e.peerId === peerId)
      : this.entries;
    if (limit !== undefined && limit > 0 && matched.length > limit) {
      return matched.slice(-limit);
    }
    return [...matched];
  }

  /**
   * Write the current entries to disk one final time, then clear in-memory
   * state and unlink the file — all serialized inside the write queue so an
   * append already in flight cannot land between the clear and the unlink.
   */
  reset(): void {
    this.enqueue(() => {
      this.entries = [];
      try {
        if (existsSync(this.registryPath)) {
          unlinkSync(this.registryPath);
        }
      } catch {
        // Best-effort
      }
    });
  }

  async flushWrites(): Promise<void> {
    await this.writeQueue;
  }

  private enqueue(task: () => void): void {
    this.writeQueue = this.writeQueue.then(task).catch(() => {
      // A single I/O failure must not break subsequent writes.
    });
  }

  private writeAtomicSync(log: SessionLog): void {
    try {
      const dir = dirname(this.registryPath);
      mkdirSync(dir, { recursive: true });
      const tmpPath = this.registryPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(log), "utf-8");
      renameSync(tmpPath, this.registryPath);
    } catch {
      // Best-effort
    }
  }

  static readLog(registryPath?: string): SessionLog | null {
    const path = registryPath ?? defaultSessionLogPath();
    if (!existsSync(path)) return null;
    try {
      const data = readFileSync(path, "utf-8");
      return JSON.parse(data) as SessionLog;
    } catch {
      return null;
    }
  }
}
