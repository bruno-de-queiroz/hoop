import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// session-model.ts hard-codes ~/.claude/projects as the lookup root. We
// temporarily relocate HOME (which controls homedir()) for the duration of
// each test so the lookup runs against a sandbox tree we control.
let realHome: string | undefined;
let tmpRoot: string;

beforeEach(() => {
  realHome = process.env.HOME;
  tmpRoot = mkdtempSync(join(tmpdir(), "hoop-session-model-"));
  process.env.HOME = tmpRoot;
  mkdirSync(join(tmpRoot, ".claude", "projects", "-workspace"), { recursive: true });
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  else delete process.env.HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function importFreshModule() {
  // Reset the module cache so each test gets its own modelCache state and
  // honours the freshly-set HOME env var.
  vi.resetModules();
  return import("./session-model");
}

function writeTranscript(sessionId: string, lines: object[]) {
  const file = join(tmpRoot, ".claude", "projects", "-workspace", `${sessionId}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

describe("getSessionModel", () => {
  it("returns the model from a single real assistant frame", async () => {
    const { getSessionModel } = await importFreshModule();
    writeTranscript("s-1", [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { model: "claude-sonnet-4-6", content: [] } },
    ]);
    expect(getSessionModel("s-1").model).toBe("claude-sonnet-4-6");
  });

  it("returns the LAST real model when several real ones are present", async () => {
    // E.g. user typed /model mid-conversation. Most-recent wins.
    const { getSessionModel } = await importFreshModule();
    writeTranscript("s-2", [
      { type: "assistant", message: { model: "claude-haiku-4-5", content: [] } },
      { type: "assistant", message: { model: "claude-sonnet-4-6", content: [] } },
    ]);
    expect(getSessionModel("s-2").model).toBe("claude-sonnet-4-6");
  });

  it("SKIPS <synthetic> and returns the most-recent REAL model behind it", async () => {
    // The bug: claude emits assistant frames with model="<synthetic>" for
    // built-in slash commands (/cost, /clear) and other internal events.
    // claude-mem's observer hook fires one on every wake. The dashboard
    // header was showing "<synthetic>" because we returned the last model
    // field without filtering.
    const { getSessionModel } = await importFreshModule();
    writeTranscript("s-3", [
      { type: "assistant", message: { model: "claude-sonnet-4-6", content: [] } },
      { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "(no content)" }] } },
    ]);
    expect(getSessionModel("s-3").model).toBe("claude-sonnet-4-6");
  });

  it("returns null when the ONLY model in the transcript is <synthetic>", async () => {
    // Defensive: a freshly-wake'd session whose first frame is synthetic
    // (no real assistant frame yet). Returning null lets the UI fall back
    // to lastStats.model (which is captured from the system/init frame and
    // sidesteps the synthetic problem entirely).
    const { getSessionModel } = await importFreshModule();
    writeTranscript("s-4", [
      { type: "assistant", message: { model: "<synthetic>", content: [] } },
    ]);
    expect(getSessionModel("s-4").model).toBeNull();
  });

  it("returns null when the transcript file doesn't exist", async () => {
    const { getSessionModel } = await importFreshModule();
    expect(getSessionModel("ghost-sid").model).toBeNull();
  });

  it("returns null when the transcript has no `model` field at all", async () => {
    const { getSessionModel } = await importFreshModule();
    writeTranscript("s-5", [
      { type: "user", message: { role: "user", content: "hi" } },
    ]);
    expect(getSessionModel("s-5").model).toBeNull();
  });
});
