import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = join(process.cwd(), "hooks/user-prompt-submit.sh");
const hasJq = spawnSync("jq", ["--version"], { stdio: "ignore" }).status === 0;
const itWithJq = hasJq ? it : it.skip;

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hoop-user-prompt-hook-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, data: unknown) {
  writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

function runHook(tempDir: string, env: Record<string, string> = {}) {
  const output = execFileSync(SCRIPT_PATH, {
    env: {
      ...process.env,
      TMPDIR: tempDir,
      // Existing tests assert the tool-based admission injection; that path
      // only fires when HOOP_ADMISSION_MODE=tool.  Default elicit mode skips
      // it (Claude Code surfaces the Ask UI directly).
      HOOP_ADMISSION_MODE: "tool",
      ...env,
    },
    encoding: "utf-8",
  });

  return output.trim().length > 0 ? JSON.parse(output) : null;
}

describe("user-prompt-submit hook", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  itWithJq("surfaces pending admissions and drains pending peer changes", () => {
    const tempDir = makeTempDir();

    writeJson(join(tempDir, "hoop-session-status.json"), {
      active: true,
      role: "host",
      sessionCode: "ABC-123",
      branchName: "hoop/session-abc",
      pid: process.pid,
      startedAt: Date.now(),
    });
    writeJson(join(tempDir, "hoop-pending-admissions.json"), {
      requests: [
        {
          email: "alice@example.com",
          peerId: "peer-alice",
          requestedAt: 1,
        },
      ],
      updatedAt: Date.now(),
    });
    writeJson(join(tempDir, "hoop-pending-updates.json"), {
      updates: [
        {
          peerId: "peer-bob",
          filePath: "src/main.ts",
          patch: "@@ -1 +1 @@\n-old\n+new",
          timestamp: 2,
        },
      ],
      updatedAt: Date.now(),
    });

    const result = runHook(tempDir);
    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(result.hookSpecificOutput.additionalContext).toContain(
      "Peer alice@example.com wants to join (peerId: peer-alice). Ask whether to admit or deny, then use hoop_admit_peer or hoop_deny_peer.",
    );
    expect(result.hookSpecificOutput.additionalContext).toContain(
      "Peer peer-bob changed src/main.ts:",
    );

    const updatesAfter = JSON.parse(
      readFileSync(join(tempDir, "hoop-pending-updates.json"), "utf-8"),
    ) as { updates: unknown[] };
    expect(updatesAfter.updates).toEqual([]);

    const admissionsAfter = JSON.parse(
      readFileSync(join(tempDir, "hoop-pending-admissions.json"), "utf-8"),
    ) as { requests: unknown[] };
    expect(admissionsAfter.requests).toHaveLength(1);
  });

  itWithJq("ignores pending admissions for peers but still surfaces peer changes", () => {
    const tempDir = makeTempDir();

    writeJson(join(tempDir, "hoop-session-status.json"), {
      active: true,
      role: "peer",
      sessionCode: "XYZ-789",
      branchName: "hoop/session-xyz",
      pid: process.pid,
      startedAt: Date.now(),
    });
    writeJson(join(tempDir, "hoop-pending-admissions.json"), {
      requests: [
        {
          email: "alice@example.com",
          peerId: "peer-alice",
          requestedAt: 1,
        },
      ],
      updatedAt: Date.now(),
    });
    writeJson(join(tempDir, "hoop-pending-updates.json"), {
      updates: [
        {
          peerId: "peer-bob",
          filePath: "src/utils.ts",
          patch: "@@ -1 +1 @@\n-old\n+new",
          timestamp: 2,
        },
      ],
      updatedAt: Date.now(),
    });

    const result = runHook(tempDir);
    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.additionalContext).not.toContain(
      "Pending admission request",
    );
    expect(result.hookSpecificOutput.additionalContext).toContain(
      "Peer peer-bob changed src/utils.ts:",
    );
  });

  it("prints nothing when there is no active session", () => {
    const tempDir = makeTempDir();
    const result = runHook(tempDir);
    expect(result).toBeNull();
  });
});
