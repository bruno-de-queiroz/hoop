import { writeFileSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { HoopLock } from "./hoopLock.js";

// ── Types ───────────────────────────────────────────────────────────

export interface LockStatusRegistry {
  status: "free" | "busy";
  holderPeerId: string | null;
  selfPeerId: string;
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
 */
export class LockStatusWriter {
  private readonly registryPath: string;
  private readonly selfPeerId: string;

  constructor(selfPeerId: string, registryPath?: string) {
    this.selfPeerId = selfPeerId;
    this.registryPath = registryPath ?? defaultLockStatusPath();
  }

  /** Write current lock state to disk. */
  update(lock: HoopLock): void {
    const registry: LockStatusRegistry = {
      status: lock.status,
      holderPeerId: lock.holderPeerId,
      selfPeerId: this.selfPeerId,
      updatedAt: Date.now(),
    };
    this.write(registry);
  }

  /** Remove the registry file. */
  clear(): void {
    try {
      unlinkSync(this.registryPath);
    } catch {
      // File might not exist
    }
  }

  private write(registry: LockStatusRegistry): void {
    try {
      mkdirSync(dirname(this.registryPath), { recursive: true });
      writeFileSync(this.registryPath, JSON.stringify(registry), "utf-8");
    } catch {
      // Best-effort: if we can't write, hooks will see stale data or no file
    }
  }

  /** Read the registry from disk. */
  static readRegistry(registryPath?: string): LockStatusRegistry | null {
    const path = registryPath ?? defaultLockStatusPath();
    try {
      const data = readFileSync(path, "utf-8");
      return JSON.parse(data) as LockStatusRegistry;
    } catch {
      return null;
    }
  }
}
