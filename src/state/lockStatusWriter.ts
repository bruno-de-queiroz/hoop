import { writeFileSync, readFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { HoopLock } from "./hoopLock.js";

// ── Types ───────────────────────────────────────────────────────────

export interface LockStatusRegistry {
  status: "free" | "busy";
  holderPeerId: string | null;
  acquiredAt: number | null;
  selfPeerId: string;
  sessionPid: number;
  updatedAt: number;
}

// ── Default path ────────────────────────────────────────────────────

const REGISTRY_FILENAME = "hoop-lock-status.json";

export function defaultLockStatusPath(): string {
  return join(tmpdir(), REGISTRY_FILENAME);
}

// ── Writer ──────────────────────────────────────────────────────────

/**
 * Persists the current HoopLock state to a JSON file on disk so
 * bash PreToolUse hooks can read it and gate file writes.
 *
 * Uses atomic write-then-rename to prevent readers from seeing
 * partial/truncated JSON. Includes acquiredAt and sessionPid so
 * the hook can check TTL expiry and session liveness.
 */
export class LockStatusWriter {
  private readonly registryPath: string;
  private readonly selfPeerId: string;

  constructor(selfPeerId: string, registryPath?: string) {
    this.selfPeerId = selfPeerId;
    this.registryPath = registryPath ?? defaultLockStatusPath();
  }

  /** Write current lock state to disk atomically. */
  update(lock: HoopLock): void {
    const registry: LockStatusRegistry = {
      status: lock.status,
      holderPeerId: lock.holderPeerId,
      acquiredAt: lock.acquiredAt,
      selfPeerId: this.selfPeerId,
      sessionPid: process.pid,
      updatedAt: Date.now(),
    };
    this.writeAtomic(registry);
  }

  /** Remove the registry file. */
  clear(): void {
    try {
      unlinkSync(this.registryPath);
    } catch {
      // File might not exist
    }
    // Also clean up any leftover temp file
    try {
      unlinkSync(this.registryPath + ".tmp");
    } catch {
      // ignore
    }
  }

  private writeAtomic(registry: LockStatusRegistry): void {
    try {
      const dir = dirname(this.registryPath);
      mkdirSync(dir, { recursive: true });
      const tmpPath = this.registryPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(registry), "utf-8");
      renameSync(tmpPath, this.registryPath);
    } catch {
      // Write failed — remove stale file so the hook sees "no file"
      // instead of outdated state. Fail-closed: missing file → deny.
      try { unlinkSync(this.registryPath); } catch { /* already gone */ }
      try { unlinkSync(this.registryPath + ".tmp"); } catch { /* already gone */ }
    }
  }

  /** Read the registry from disk. Returns null only if the file does not exist. */
  static readRegistry(registryPath?: string): LockStatusRegistry | null {
    const path = registryPath ?? defaultLockStatusPath();
    if (!existsSync(path)) return null;
    try {
      const data = readFileSync(path, "utf-8");
      return JSON.parse(data) as LockStatusRegistry;
    } catch {
      return null;
    }
  }
}
