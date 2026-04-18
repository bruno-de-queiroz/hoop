import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LockStatusRegistry } from "../state/lockStatusWriter.js";

const SCRIPT_PATH = join(process.cwd(), "hooks/pre-tool-use-lock.sh");
const hasJq = spawnSync("jq", ["--version"], { stdio: "ignore" }).status === 0;
const itWithJq = hasJq ? it : it.skip;

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hoop-lock-hook-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, data: unknown) {
  writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

function writeLockRegistry(tempDir: string, registry: LockStatusRegistry) {
  writeJson(join(tempDir, "hoop-lock-status.json"), registry);
}

function runHook(tempDir: string, toolName: string) {
  const input = JSON.stringify({ tool_name: toolName, tool_input: { file_path: "/tmp/test.ts" } });
  const result = spawnSync(SCRIPT_PATH, {
    env: { ...process.env, TMPDIR: tempDir },
    input,
    encoding: "utf-8",
    timeout: 5000,
  });

  if (result.status !== 0) {
    throw new Error(`Hook exited with status ${result.status}: ${result.stderr}`);
  }

  return result.stdout.trim().length > 0 ? JSON.parse(result.stdout) : null;
}

describe("pre-tool-use-lock hook", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  itWithJq("allows Write when no lock file exists", () => {
    const tempDir = makeTempDir();
    const result = runHook(tempDir, "Write");
    expect(result).toBeNull();
  });

  itWithJq("allows Edit when lock is free", () => {
    const tempDir = makeTempDir();
    writeLockRegistry(tempDir, {
      status: "free",
      holderPeerId: null,
      acquiredAt: null,
      selfPeerId: "self-peer",
      sessionPid: process.pid,
      updatedAt: Date.now(),
    });
    const result = runHook(tempDir, "Edit");
    expect(result).toBeNull();
  });

  itWithJq("allows Write when lock is held by self", () => {
    const tempDir = makeTempDir();
    writeLockRegistry(tempDir, {
      status: "busy",
      holderPeerId: "self-peer",
      acquiredAt: Date.now(),
      selfPeerId: "self-peer",
      sessionPid: process.pid,
      updatedAt: Date.now(),
    });
    const result = runHook(tempDir, "Write");
    expect(result).toBeNull();
  });

  itWithJq("denies Write when lock is held by another peer", () => {
    const tempDir = makeTempDir();
    writeLockRegistry(tempDir, {
      status: "busy",
      holderPeerId: "peer-alice",
      acquiredAt: Date.now(),
      selfPeerId: "self-peer",
      sessionPid: process.pid,
      updatedAt: Date.now(),
    });
    const result = runHook(tempDir, "Write");
    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain("peer-alice");
  });

  itWithJq("denies Edit when lock is held by another peer", () => {
    const tempDir = makeTempDir();
    writeLockRegistry(tempDir, {
      status: "busy",
      holderPeerId: "peer-bob",
      acquiredAt: Date.now(),
      selfPeerId: "self-peer",
      sessionPid: process.pid,
      updatedAt: Date.now(),
    });
    const result = runHook(tempDir, "Edit");
    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain("peer-bob");
  });

  itWithJq("allows non-write tools regardless of lock state", () => {
    const tempDir = makeTempDir();
    writeLockRegistry(tempDir, {
      status: "busy",
      holderPeerId: "peer-alice",
      acquiredAt: Date.now(),
      selfPeerId: "self-peer",
      sessionPid: process.pid,
      updatedAt: Date.now(),
    });
    const result = runHook(tempDir, "Read");
    expect(result).toBeNull();
  });

  itWithJq("allows write when lock is expired (TTL exceeded)", () => {
    const tempDir = makeTempDir();
    const fiveMinutesAgoMs = Date.now() - (6 * 60 * 1000); // 6 minutes ago
    writeLockRegistry(tempDir, {
      status: "busy",
      holderPeerId: "peer-alice",
      acquiredAt: fiveMinutesAgoMs,
      selfPeerId: "self-peer",
      sessionPid: process.pid,
      updatedAt: Date.now() - (6 * 60 * 1000),
    });
    const result = runHook(tempDir, "Write");
    expect(result).toBeNull();
  });

  itWithJq("allows write when session PID is dead (stale file)", () => {
    const tempDir = makeTempDir();
    writeLockRegistry(tempDir, {
      status: "busy",
      holderPeerId: "peer-alice",
      acquiredAt: Date.now(),
      selfPeerId: "self-peer",
      sessionPid: 999999, // unlikely to be running
      updatedAt: Date.now(),
    });
    const result = runHook(tempDir, "Write");
    expect(result).toBeNull();
  });

  itWithJq("denies write on malformed lock file (fail-closed)", () => {
    const tempDir = makeTempDir();
    writeFileSync(join(tempDir, "hoop-lock-status.json"), "not valid json{{{", "utf-8");
    const result = runHook(tempDir, "Write");
    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  itWithJq("denies write when lock is busy but holder is missing (fail-closed)", () => {
    const tempDir = makeTempDir();
    writeLockRegistry(tempDir, {
      status: "busy",
      holderPeerId: null,
      acquiredAt: Date.now(),
      selfPeerId: "self-peer",
      sessionPid: process.pid,
      updatedAt: Date.now(),
    });
    const result = runHook(tempDir, "Write");
    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain("holder identity is missing");
  });

  itWithJq("denies NotebookEdit when lock is held by another peer", () => {
    const tempDir = makeTempDir();
    writeLockRegistry(tempDir, {
      status: "busy",
      holderPeerId: "peer-alice",
      acquiredAt: Date.now(),
      selfPeerId: "self-peer",
      sessionPid: process.pid,
      updatedAt: Date.now(),
    });
    const result = runHook(tempDir, "NotebookEdit");
    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
