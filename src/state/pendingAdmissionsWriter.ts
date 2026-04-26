import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
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
  // Suffix with process.pid to avoid collisions across concurrent hoop sessions on the same machine
  const filename = `${REGISTRY_FILENAME.replace(".json", "")}-${process.pid}.json`;
  return join(process.env.HOOP_REGISTRY_DIR || tmpdir(), filename);
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
      const dir = dirname(this.registryPath);
      mkdirSync(dir, { recursive: true });
      const tmpPath = this.registryPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(registry), "utf-8");
      renameSync(tmpPath, this.registryPath);
    } catch {
      // Best-effort: if we can't write, hooks will see stale data or no file
    }
  }

  static readRegistry(registryPath?: string): PendingAdmissionsRegistry | null {
    const path = registryPath ?? defaultPendingAdmissionsPath();
    if (!existsSync(path)) return null;
    try {
      const data = readFileSync(path, "utf-8");
      return JSON.parse(data) as PendingAdmissionsRegistry;
    } catch {
      return null;
    }
  }
}
