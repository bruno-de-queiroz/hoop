import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { PromptRequestStatus } from "./promptRequest.js";

export interface PendingPromptRequestEntry {
  id: string;
  prompt: string;
  model?: string;
  requestedBy: string;
  status: PromptRequestStatus;
  requestedAt: number;
}

export interface PendingPromptRequestsRegistry {
  requests: PendingPromptRequestEntry[];
  updatedAt: number;
}

const REGISTRY_FILENAME = "hoop-pending-prompt-requests.json";

export function defaultPendingPromptRequestsPath(): string {
  // Suffix with process.pid to avoid collisions across concurrent hoop sessions on the same machine
  const filename = `${REGISTRY_FILENAME.replace(".json", "")}-${process.pid}.json`;
  return join(process.env.HOOP_REGISTRY_DIR || tmpdir(), filename);
}

export class PendingPromptRequestsWriter {
  private readonly registryPath: string;

  constructor(registryPath?: string) {
    this.registryPath = registryPath ?? defaultPendingPromptRequestsPath();
  }

  sync(requests: PendingPromptRequestEntry[]): void {
    this.write({ requests, updatedAt: Date.now() });
  }

  clear(): void {
    this.sync([]);
  }

  private write(registry: PendingPromptRequestsRegistry): void {
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

  static readRegistry(registryPath?: string): PendingPromptRequestsRegistry | null {
    const path = registryPath ?? defaultPendingPromptRequestsPath();
    if (!existsSync(path)) return null;
    try {
      const data = readFileSync(path, "utf-8");
      const parsed: unknown = JSON.parse(data);
      if (
        typeof parsed !== "object" || parsed === null ||
        !Array.isArray((parsed as Record<string, unknown>)["requests"]) ||
        typeof (parsed as Record<string, unknown>)["updatedAt"] !== "number"
      ) {
        return null;
      }
      return parsed as PendingPromptRequestsRegistry;
    } catch {
      return null;
    }
  }
}
