import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function gitSync(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export function initRepo(cwd: string): void {
  gitSync(["init"], cwd);
  gitSync(["config", "user.email", "test@test.com"], cwd);
  gitSync(["config", "user.name", "Test"], cwd);
}

export async function createTempRepo(prefix = "hoop-e2e-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  initRepo(dir);
  return dir;
}

export async function removeTempRepo(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
