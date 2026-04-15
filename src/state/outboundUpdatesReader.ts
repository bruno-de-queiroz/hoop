import { watchFile, unwatchFile, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  return join(tmpdir(), REGISTRY_FILENAME);
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
  private watching = false;

  constructor(onUpdate: (update: OutboundUpdate) => void, registryPath?: string) {
    this.onUpdate = onUpdate;
    this.registryPath = registryPath ?? defaultOutboundUpdatesPath();
  }

  /** Start watching the outbound file for changes. */
  start(): void {
    if (this.watching) return;
    this.watching = true;
    this.clearFile();
    watchFile(this.registryPath, { interval: 500 }, () => {
      this.drain();
    });
  }

  /** Stop watching and clean up. */
  stop(): void {
    if (!this.watching) return;
    this.watching = false;
    unwatchFile(this.registryPath);
  }

  /** Read and process all pending outbound updates, then clear the file. */
  private drain(): void {
    try {
      const data = readFileSync(this.registryPath, "utf-8");
      const registry = JSON.parse(data) as OutboundUpdatesRegistry;
      if (registry.updates.length === 0) return;

      // Clear immediately to avoid reprocessing
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
