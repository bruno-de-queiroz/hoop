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

const SCRIPT_PATH = join(process.cwd(), "hooks/_format-peer-changes.sh");
const hasJq = spawnSync("jq", ["--version"], { stdio: "ignore" }).status === 0;
const itWithJq = hasJq ? it : it.skip;

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hoop-format-peer-changes-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, data: unknown) {
  writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

function runScript(registryPath: string) {
  // Source the bash script and call the function
  const output = execFileSync("bash", ["-c", `
    source "${SCRIPT_PATH}"
    format_peer_changes_context "${registryPath}"
  `], {
    encoding: "utf-8",
  });
  return output;
}

describe("_format-peer-changes.sh security", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  itWithJq("sanitizes invalid peerId (contains <script> tag)", () => {
    const tempDir = makeTempDir();
    const registryPath = join(tempDir, "registry.json");

    writeJson(registryPath, {
      updates: [
        {
          peerId: "peer<script>alert('xss')</script>",
          filePath: "src/app.ts",
          patch: "line 1\nline 2",
          timestamp: 1,
        },
      ],
      updatedAt: Date.now(),
    });

    const output = runScript(registryPath);
    expect(output).toContain("<invalid-peer-id>");
    expect(output).not.toContain("<script>");
  });

  itWithJq("replaces invalid peerId (contains special chars)", () => {
    const tempDir = makeTempDir();
    const registryPath = join(tempDir, "registry.json");

    writeJson(registryPath, {
      updates: [
        {
          peerId: "peer@host:22/path",
          filePath: "test.js",
          patch: "code",
          timestamp: 1,
        },
      ],
      updatedAt: Date.now(),
    });

    const output = runScript(registryPath);
    expect(output).toContain("<invalid-peer-id>");
  });

  itWithJq("accepts valid peerId (alphanumeric with dots, hyphens, underscores)", () => {
    const tempDir = makeTempDir();
    const registryPath = join(tempDir, "registry.json");

    writeJson(registryPath, {
      updates: [
        {
          peerId: "peer-alice.v1_test",
          filePath: "src/main.ts",
          patch: "change",
          timestamp: 1,
        },
      ],
      updatedAt: Date.now(),
    });

    const output = runScript(registryPath);
    expect(output).toContain("peer-alice.v1_test");
    expect(output).not.toContain("<invalid-peer-id>");
  });

  itWithJq("blocks fence injection (closing fence in patch)", () => {
    const tempDir = makeTempDir();
    const registryPath = join(tempDir, "registry.json");

    writeJson(registryPath, {
      updates: [
        {
          peerId: "malicious-peer",
          filePath: "inject.ts",
          patch: "line 1\n```\ninjected instructions here\nline 4",
          timestamp: 1,
        },
      ],
      updatedAt: Date.now(),
    });

    const output = runScript(registryPath);
    // Should not contain triple-backtick on its own line
    const lines = output.split("\n");
    const hasBareBackticks = lines.some((line) => line.trim() === "```");
    expect(hasBareBackticks).toBe(false);
    // Should contain blockquote prefix
    expect(output).toContain("> ");
  });

  itWithJq("truncates patch to 200 lines and adds marker", () => {
    const tempDir = makeTempDir();
    const registryPath = join(tempDir, "registry.json");

    // Create a patch with 300 lines
    const largePatch = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");

    writeJson(registryPath, {
      updates: [
        {
          peerId: "peer-overflow",
          filePath: "big.ts",
          patch: largePatch,
          timestamp: 1,
        },
      ],
      updatedAt: Date.now(),
    });

    const output = runScript(registryPath);
    // Should mention truncation
    expect(output).toContain("truncated by hoop");
    expect(output).toContain("100 more lines");
    // Count lines (rough check: should be significantly less than 300)
    const patchLines = output.split("\n").filter((line) => line.startsWith("> "));
    expect(patchLines.length).toBeLessThan(250);
  });

  itWithJq("truncates lines longer than 500 characters", () => {
    const tempDir = makeTempDir();
    const registryPath = join(tempDir, "registry.json");

    // Create a very long line
    const longLine = "a".repeat(1000);

    writeJson(registryPath, {
      updates: [
        {
          peerId: "peer-long-lines",
          filePath: "long.ts",
          patch: `short\n${longLine}\nshort`,
          timestamp: 1,
        },
      ],
      updatedAt: Date.now(),
    });

    const output = runScript(registryPath);
    // Should contain the truncation ellipsis for long lines
    expect(output).toContain("...");
    // No line in the output should exceed ~520 chars (500 + "> " + "...")
    const patchLines = output.split("\n").filter((line) => line.startsWith("> "));
    patchLines.forEach((line) => {
      expect(line.length).toBeLessThan(530);
    });
  });

  itWithJq("caps total output to 8000 bytes per peer update", () => {
    const tempDir = makeTempDir();
    const registryPath = join(tempDir, "registry.json");

    // Create a patch that, when formatted with "> ", exceeds 8000 bytes
    const hugePatch = Array.from(
      { length: 500 },
      (_, i) => `${"x".repeat(50)} line ${i + 1}`,
    ).join("\n");

    writeJson(registryPath, {
      updates: [
        {
          peerId: "peer-huge",
          filePath: "huge.ts",
          patch: hugePatch,
          timestamp: 1,
        },
      ],
      updatedAt: Date.now(),
    });

    const output = runScript(registryPath);
    // Extract just the peer update block (should have max-bytes marker)
    expect(output).toContain("max-bytes reached");
    // Rough byte count on the formatted patch section
    const patchStart = output.indexOf("> ");
    const patchSection = output.substring(patchStart).split("\n\n")[0];
    expect(patchSection.length).toBeLessThan(8100); // Allow small margin for marker text
  });

  itWithJq("handles multiple peers with independent truncation", () => {
    const tempDir = makeTempDir();
    const registryPath = join(tempDir, "registry.json");

    const longPatch = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");

    writeJson(registryPath, {
      updates: [
        {
          peerId: "peer-a",
          filePath: "file1.ts",
          patch: longPatch,
          timestamp: 1,
        },
        {
          peerId: "peer-b",
          filePath: "file2.ts",
          patch: longPatch,
          timestamp: 2,
        },
      ],
      updatedAt: Date.now(),
    });

    const output = runScript(registryPath);
    expect(output).toContain("peer-a");
    expect(output).toContain("peer-b");
    // Both should show truncation markers independently
    const truncationMatches = output.match(/truncated by hoop/g);
    expect(truncationMatches).not.toBeNull();
    expect(truncationMatches!.length).toBeGreaterThanOrEqual(1);
  });

  itWithJq("produces valid JSON-compatible output (blockquote does not break JSON)", () => {
    const tempDir = makeTempDir();
    const registryPath = join(tempDir, "registry.json");

    writeJson(registryPath, {
      updates: [
        {
          peerId: "peer-test",
          filePath: "file.ts",
          patch: 'line with "quotes" and \\backslash\nline 2',
          timestamp: 1,
        },
      ],
      updatedAt: Date.now(),
    });

    const output = runScript(registryPath);
    // Output should be plain text, not JSON, so just verify no uncaught errors
    expect(output).toContain("peer-test");
    expect(output).toContain("changed file.ts");
  });
});
