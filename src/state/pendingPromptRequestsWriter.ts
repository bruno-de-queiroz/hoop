import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
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
  return join(tmpdir(), REGISTRY_FILENAME);
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
      mkdirSync(dirname(this.registryPath), { recursive: true });
      writeFileSync(this.registryPath, JSON.stringify(registry), "utf-8");
    } catch {
      // Best-effort: if we can't write, hooks will see stale data or no file
    }
  }

  static readRegistry(registryPath?: string): PendingPromptRequestsRegistry | null {
    const path = registryPath ?? defaultPendingPromptRequestsPath();
    try {
      const data = readFileSync(path, "utf-8");
      return JSON.parse(data) as PendingPromptRequestsRegistry;
    } catch {
      return null;
    }
  }
}
