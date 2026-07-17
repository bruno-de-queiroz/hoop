import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("./plugin-paths", () => ({
  discoverInstalledPluginDirs: () => [],
}));

vi.mock("./skills", () => ({
  listSkills: () => [
    { name: "triage-issue", description: null, path: "/p", source: "user" },
    { name: "hoop:something", description: null, path: "/p", source: "plugin" },
  ],
}));

vi.mock("./commands", () => ({
  listSlashCommands: () => [
    { name: "cost", description: null, plugin: "built-in", kind: "builtin" },
    { name: "hoop:setup", description: null, plugin: "hoop", kind: "command" },
  ],
}));

const shared = vi.hoisted(() => ({
  spawnCalls: [] as Array<{ cmd: string; args: string[] }>,
  reset() { this.spawnCalls = []; },
  makeChild(): any {
    const { EventEmitter } = require("node:events");
    const { Readable } = require("node:stream");
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const ee = new EventEmitter();
    return Object.assign(ee, {
      stdout, stderr,
      pid: 99999,
      killed: false,
      kill: vi.fn(),
    });
  },
}));

vi.mock("node:child_process", () => {
  const spawn = (cmd: string, args: string[]) => {
    shared.spawnCalls.push({ cmd, args });
    return shared.makeChild();
  };
  return { spawn, default: { spawn } };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    default: actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false } as any)),
  };
});

let spawnMod: typeof import("./spawn");

beforeEach(async () => {
  vi.resetModules();
  shared.reset();
  spawnMod = await import("./spawn");
});

function lastPrompt(): string {
  const call = shared.spawnCalls[shared.spawnCalls.length - 1];
  if (!call) throw new Error("no spawn call recorded");
  const pIdx = call.args.indexOf("-p");
  if (pIdx < 0) throw new Error("no -p in args");
  return call.args[pIdx + 1];
}

describe("startSkillRun: prompt construction", () => {
  it("passes a bare slash command through unchanged (built-in: /cost)", () => {
    spawnMod.startSkillRun("cost", "/cost");
    expect(lastPrompt()).toBe("/cost");
  });

  it("passes a namespaced plugin slash command through unchanged (/hoop:setup)", () => {
    spawnMod.startSkillRun("hoop:setup", "/hoop:setup");
    expect(lastPrompt()).toBe("/hoop:setup");
  });

  it("preserves args after a slash command (/cost --foo bar)", () => {
    spawnMod.startSkillRun("cost", "/cost --foo bar");
    expect(lastPrompt()).toBe("/cost --foo bar");
  });

  it("DOES NOT rewrite a slash command as 'Use the X skill'", () => {
    spawnMod.startSkillRun("cost", "/cost");
    expect(lastPrompt()).not.toMatch(/Use the .* skill/);
    expect(lastPrompt().startsWith("/")).toBe(true);
  });

  it("falls back to natural-language skill invocation only when neither name nor args carry a slash", () => {
    spawnMod.startSkillRun("triage-issue", "");
    expect(lastPrompt()).toBe("Use the triage-issue skill.");
  });

  it("strips namespace prefix from the natural-language rewrite (hoop:something → something)", () => {
    spawnMod.startSkillRun("hoop:something", "");
    expect(lastPrompt()).toBe("Use the something skill.");
  });

  it("rejects invalid skill names instead of silently spawning", () => {
    expect(() => spawnMod.startSkillRun("not valid", "")).toThrow(/invalid skill name/);
    expect(shared.spawnCalls).toHaveLength(0);
  });

  it("rejects unknown skills/commands (no spawn, no prompt rewrite)", () => {
    expect(() => spawnMod.startSkillRun("unknown-skill", "")).toThrow(/unknown skill or command/);
    expect(shared.spawnCalls).toHaveLength(0);
  });
});

describe("startSkillRun: resource caps", () => {
  it("throws TooManyConcurrentRunsError once activeRuns hits the cap", async () => {
    process.env.HOOP_MAX_CONCURRENT_RUNS = "3";
    vi.resetModules();
    shared.reset();
    const mod = await import("./spawn");

    mod.startSkillRun("cost", "/cost");
    mod.startSkillRun("cost", "/cost");
    mod.startSkillRun("cost", "/cost");
    expect(shared.spawnCalls).toHaveLength(3);

    let caught: unknown = null;
    try { mod.startSkillRun("cost", "/cost"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(mod.TooManyConcurrentRunsError);
    expect(shared.spawnCalls).toHaveLength(3);

    delete process.env.HOOP_MAX_CONCURRENT_RUNS;
  });

  it("evicts oldest runMetas entry when RUN_META_HISTORY is exceeded", async () => {
    process.env.HOOP_RUN_META_HISTORY = "2";
    vi.resetModules();
    shared.reset();
    const mod = await import("./spawn");

    const { runId: r1 } = mod.startSkillRun("cost", "/cost");
    const { runId: r2 } = mod.startSkillRun("cost", "/cost");
    const { runId: r3 } = mod.startSkillRun("cost", "/cost");

    expect(mod.getRun(r1)).toBeUndefined();   // oldest evicted
    expect(mod.getRun(r2)).toBeDefined();
    expect(mod.getRun(r3)).toBeDefined();
    expect(mod.listRuns()).toHaveLength(2);

    delete process.env.HOOP_RUN_META_HISTORY;
  });
});
