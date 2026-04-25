import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { StateUpdate } from "./stateUpdate.js";

// ── Types ───────────────────────────────────────────────────────────

export interface ActiveEdit {
  peerId: string;
  filePath: string;
  type: "dirty-buffer" | "file-change";
  timestamp: number;
}

export interface ConflictCheck {
  hasConflict: boolean;
  conflict: ActiveEdit | null;
}

export interface ConflictRegistry {
  activeEdits: Record<string, ActiveEdit>; // filePath -> ActiveEdit
  updatedAt: number;
}

// ── Default path ────────────────────────────────────────────────────

const REGISTRY_FILENAME = "hoop-active-edits.json";

export function defaultRegistryPath(): string {
  return join(process.env.HOOP_REGISTRY_DIR || tmpdir(), REGISTRY_FILENAME);
}

// ── Tracker ─────────────────────────────────────────────────────────

/** Time after which a file-change lock expires (ms). */
const FILE_CHANGE_TTL_MS = 60_000;

export class ActiveEditsTracker {
  private edits = new Map<string, ActiveEdit>();
  private readonly registryPath: string;
  private readonly selfPeerId: string;

  constructor(selfPeerId: string, registryPath?: string) {
    this.selfPeerId = selfPeerId;
    this.registryPath = registryPath ?? defaultRegistryPath();
  }

  /**
   * Process an incoming state update from any peer.
   * Only records edits from OTHER peers (self-edits are ignored).
   */
  handleUpdate(update: StateUpdate): void {
    if (update.peerId === this.selfPeerId) return;

    switch (update.type) {
      case "buffer-update": {
        if (update.dirty) {
          this.edits.set(update.filePath, {
            peerId: update.peerId,
            filePath: update.filePath,
            type: "dirty-buffer",
            timestamp: update.timestamp,
          });
        } else {
          // Buffer is clean — peer saved or closed the file
          this.edits.delete(update.filePath);
        }
        break;
      }
      case "file-change": {
        this.edits.set(update.filePath, {
          peerId: update.peerId,
          filePath: update.filePath,
          type: "file-change",
          timestamp: update.timestamp,
        });
        break;
      }
      default:
        // cursor-update and metadata-update don't affect file conflicts
        return;
    }

    this.flush();
  }

  /**
   * Check if a file has an active conflict (edit by another peer).
   * Expired file-change entries are pruned during the check.
   */
  checkConflict(filePath: string): ConflictCheck {
    const edit = this.edits.get(filePath);
    if (!edit) return { hasConflict: false, conflict: null };

    // Expire stale file-change locks
    if (edit.type === "file-change" && Date.now() - edit.timestamp > FILE_CHANGE_TTL_MS) {
      this.edits.delete(filePath);
      this.flush();
      return { hasConflict: false, conflict: null };
    }

    return { hasConflict: true, conflict: edit };
  }

  /**
   * Remove all edits for a peer (e.g., when they disconnect).
   */
  removePeer(peerId: string): void {
    for (const [filePath, edit] of this.edits) {
      if (edit.peerId === peerId) {
        this.edits.delete(filePath);
      }
    }
    this.flush();
  }

  /** Clear all tracked edits. */
  clear(): void {
    this.edits.clear();
    this.flush();
  }

  /** Return current registry as a plain object. */
  getRegistry(): ConflictRegistry {
    return {
      activeEdits: Object.fromEntries(this.edits),
      updatedAt: Date.now(),
    };
  }

  /** Write registry to disk so hook scripts can read it. */
  private flush(): void {
    const data = JSON.stringify(this.getRegistry());
    try {
      mkdirSync(dirname(this.registryPath), { recursive: true });
      writeFileSync(this.registryPath, data, "utf-8");
    } catch {
      // Best-effort: if we can't write, hooks will see stale data or no file
    }
  }

  /** Read the registry from disk (static, for use by hook scripts or tests). */
  static readRegistry(registryPath?: string): ConflictRegistry | null {
    const path = registryPath ?? defaultRegistryPath();
    try {
      const data = readFileSync(path, "utf-8");
      return JSON.parse(data) as ConflictRegistry;
    } catch {
      return null;
    }
  }
}
