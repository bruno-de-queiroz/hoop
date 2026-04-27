import { watch, type FSWatcher, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

export interface OutboundUpdate {
  filePath: string;
  patch: string;
  baseHash: string;
  resultHash: string;
  timestamp: number;
}

export interface OutboundUpdatesRegistry {
  updates: OutboundUpdate[];
  updatedAt: number;
}

// ── Default path ────────────────────────────────────────────────────

const REGISTRY_FILENAME = "hoop-outbound-updates.json";

export function defaultOutboundUpdatesPath(): string {
  return join(process.env.HOOP_REGISTRY_DIR || tmpdir(), REGISTRY_FILENAME);
}

// ── Reader ──────────────────────────────────────────────────────────

/**
 * Watches `hoop-outbound-updates.json` for file-change updates written
 * by the PostToolUse hook and forwards them to a callback for broadcast.
 *
 * This is the reverse of PendingUpdatesWriter:
 * - PendingUpdatesWriter: MCP server writes, hooks read
 * - OutboundUpdatesReader: hooks write, MCP server reads and broadcasts
 */
export class OutboundUpdatesReader {
  private readonly registryPath: string;
  private readonly onUpdate: (update: OutboundUpdate) => void;
  private watcher: FSWatcher | null = null;
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(onUpdate: (update: OutboundUpdate) => void, registryPath?: string) {
    this.onUpdate = onUpdate;
    this.registryPath = registryPath ?? defaultOutboundUpdatesPath();
  }

  /**
   * Start watching the outbound file for changes.
   *
   * Uses fs.watch (event-based) on the file itself. The previous
   * watchFile (interval=500ms polling) could miss writes that landed
   * within a single poll window — e.g., a hook-write and the reader's
   * own clearFile in the same 500ms tick would coalesce into a single
   * stat change and the hook's update was lost. Event-based fires for
   * every kernel-reported change.
   *
   * The drain itself is idempotent: an event from our own clearFile
   * triggers a drain that reads zero entries and returns. A small
   * debounce coalesces the multiple events some platforms emit for a
   * single write so we don't run drain twice in a row.
   */
  start(): void {
    if (this.watcher) return;
    try {
      mkdirSync(dirname(this.registryPath), { recursive: true });
    } catch {
      // best-effort
    }
    this.clearFile();
    this.watcher = watch(this.registryPath, () => {
      this.scheduleDrain();
    });
  }

  /** Stop watching and clean up. */
  stop(): void {
    if (!this.watcher) return;
    this.watcher.close();
    this.watcher = null;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, 25);
  }

  /** Read and process all pending outbound updates, then clear the file. */
  private drain(): void {
    try {
      const data = readFileSync(this.registryPath, "utf-8");
      const registry = JSON.parse(data) as OutboundUpdatesRegistry;
      if (registry.updates.length === 0) return;

      // Clear immediately to avoid reprocessing.
      // Note: this race-window remains: a hook write that started its
      // read-modify-write before our clear and finishes after will
      // restore the entries we just drained. The hook script flocks its
      // read+write, but the reader does not (no built-in flock in Node
      // without shelling out). Worst case under heavy contention: at
      // most one duplicate delivery to the broadcast layer. The
      // broadcast layer is idempotent on file-change updates because
      // peers re-validate base hashes before applying.
      this.clearFile();

      for (const update of registry.updates) {
        try {
          this.onUpdate(update);
        } catch {
          // Best-effort: don't let one failed update block others
        }
      }
    } catch {
      // File doesn't exist or invalid JSON — nothing to do
    }
  }

  private clearFile(): void {
    try {
      mkdirSync(dirname(this.registryPath), { recursive: true });
      writeFileSync(
        this.registryPath,
        JSON.stringify({ updates: [], updatedAt: Date.now() }),
        "utf-8",
      );
    } catch {
      // Best-effort
    }
  }

  /** Read the registry from disk (static, for use by tests). */
  static readRegistry(registryPath?: string): OutboundUpdatesRegistry | null {
    const path = registryPath ?? defaultOutboundUpdatesPath();
    try {
      const data = readFileSync(path, "utf-8");
      return JSON.parse(data) as OutboundUpdatesRegistry;
    } catch {
      return null;
    }
  }
}
