import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export interface PendingAdmissionRequest {
  email: string;
  peerId: string;
  requestedAt: number;
}

export interface PendingAdmissionsRegistry {
  requests: PendingAdmissionRequest[];
  updatedAt: number;
}

const REGISTRY_FILENAME = "hoop-pending-admissions.json";

export function defaultPendingAdmissionsPath(): string {
  return join(tmpdir(), REGISTRY_FILENAME);
}

export class PendingAdmissionsWriter {
  private readonly registryPath: string;

  constructor(registryPath?: string) {
    this.registryPath = registryPath ?? defaultPendingAdmissionsPath();
  }

  sync(requests: PendingAdmissionRequest[]): void {
    this.write({ requests, updatedAt: Date.now() });
  }

  clear(): void {
    this.sync([]);
  }

  private write(registry: PendingAdmissionsRegistry): void {
    try {
      mkdirSync(dirname(this.registryPath), { recursive: true });
      writeFileSync(this.registryPath, JSON.stringify(registry), "utf-8");
    } catch {
      // Best-effort: if we can't write, hooks will see stale data or no file
    }
  }

  static readRegistry(registryPath?: string): PendingAdmissionsRegistry | null {
    const path = registryPath ?? defaultPendingAdmissionsPath();
    try {
      const data = readFileSync(path, "utf-8");
      return JSON.parse(data) as PendingAdmissionsRegistry;
    } catch {
      return null;
    }
  }
}
