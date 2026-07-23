import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Readable as ReadableT, Writable as WritableT } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./plugin-paths", () => ({
  discoverInstalledPluginDirs: () => [],
  readInstalledPluginEntries: () => [],
}));

const ingestEventLineMock = vi.fn();
vi.mock("./ingestor", () => ({
  ingestEventLine: (line: string) => ingestEventLineMock(line),
}));

// Shared mutable handles so tests can override fs mock behaviour per-test.
// Also exposes real fs functions that the test file needs for setup (mkdtempSync,
// mkdirSync, rmSync) — these must bypass the mocked node:fs.
const fsMock = vi.hoisted(() => ({
  existsReturnValue: false as boolean | ((p: string) => boolean),
  readFileReturnValue: "{}" as string | ((p: string) => string),
  statImpl: null as null | ((p: string) => { mtimeMs: number }),
  // Populated by the mock factory with the real fs functions so test helpers
  // can create and remove directories without going through the vi.fn() stubs.
  realFs: null as null | {
    mkdtempSync: (prefix: string) => string;
    mkdirSync: (path: string, opts?: { recursive?: boolean }) => void;
    rmSync: (path: string, opts?: { recursive?: boolean; force?: boolean }) => void;
  },
  reset() {
    this.existsReturnValue = false;
    this.readFileReturnValue = "{}";
    this.statImpl = null;
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual: any = await importOriginal();
  // Expose real helpers to test code (captured once; survives resetModules).
  if (!fsMock.realFs) {
    fsMock.realFs = {
      mkdtempSync: actual.mkdtempSync,
      mkdirSync: actual.mkdirSync,
      rmSync: actual.rmSync,
    };
  }
  return {
    ...actual,
    default: actual,
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readFileSync: vi.fn((p: string) => {
      const v = fsMock.readFileReturnValue;
      return typeof v === "function" ? v(p) : v;
    }),
    existsSync: vi.fn((p: string) => {
      const v = fsMock.existsReturnValue;
      return typeof v === "function" ? v(p) : v;
    }),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => [] as string[]),
    statSync: vi.fn((p: string) => {
      const v = fsMock.statImpl;
      if (v) return v(p);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
  };
});

const shared = vi.hoisted(() => {
  // Defer requires until factory runtime so the hoist doesn't fail.
  return {
    children: [] as any[],
    reset() { this.children = []; },
    make(args: string[] = [], env: NodeJS.ProcessEnv = {}): any {
      const { EventEmitter } = require("node:events");
      const { Readable, Writable } = require("node:stream");
      const stdin = new Writable({ write(_c: any, _e: any, cb: any) { cb(); } });
      const stdout = new Readable({ read() {} });
      (stdout as any).pushLine = (obj: object) => stdout.push(JSON.stringify(obj) + "\n", "utf-8");
      const stderr = new Readable({ read() {} });
      const ee = new EventEmitter();
      const child: any = Object.assign(ee, {
        stdin, stdout, stderr,
        pid: 12345 + this.children.length,
        killed: false,
        kill: vi.fn(),
        spawnArgs: args,
        spawnEnv: env,
      });
      this.children.push(child);
      return child;
    },
  };
});

vi.mock("node:child_process", () => {
  const spawn = (_cmd: string, args: string[] = [], opts: any = {}) => shared.make(args, opts?.env ?? {});
  // execFile is imported (promisified) for git-clone-on-start; no test exercises
  // that path, so a stub is enough to satisfy the module-level promisify().
  const execFile = () => {};
  return { spawn, execFile, default: { spawn, execFile } };
});

async function flush() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

let mod: typeof import("./active-sessions");
const originalEnv = process.env.HOOP_CWD_ROOTS;

beforeEach(async () => {
  vi.resetModules();
  shared.reset();
  fsMock.reset();
  ingestEventLineMock.mockReset();
  delete process.env.HOOP_CWD_ROOTS;
  delete process.env.HOOP_AUTO_COMPACT;
  delete process.env.HOOP_AUTO_COMPACT_PCT;
  mod = await import("./active-sessions");
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.HOOP_CWD_ROOTS;
  else process.env.HOOP_CWD_ROOTS = originalEnv;
  delete process.env.HOOP_AUTO_COMPACT;
  delete process.env.HOOP_AUTO_COMPACT_PCT;
});

describe("repoDirNameFromUrl", () => {
  it.each([
    ["https://github.com/owner/repo.git", "repo"],
    ["https://github.com/owner/repo", "repo"],
    ["git@github.com:owner/repo.git", "repo"],
    ["https://github.com/owner/repo/", "repo"],
    ["ssh://git@host:22/team/My.Repo.git", "My.Repo"],
    ["https://host/foo?ref=main#frag", "foo"],
    ["https://host/weird name!.git", "weird-name-"],
    // "." / ".." / all-dots must not resolve to WORKSPACE_DIR or its parent.
    ["https://x/..", "repo"],
    ["https://x/.", "repo"],
  ])("%s -> %s", (url, want) => {
    expect(mod.repoDirNameFromUrl(url)).toBe(want);
  });
});

describe("startNewConversation", () => {
  it("spawns with an OWNED (real, non-pending) id passed to claude via --session-id", async () => {
    const { sessionId, meta } = await mod.startNewConversation({ cwd: "/workspace" });
    // The id is ours from creation — a real UUID, never a `pending-` placeholder.
    expect(sessionId).not.toMatch(/^pending-/);
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(meta.cwd).toBe("/workspace");
    expect(meta.status).toBe("alive");
    expect(meta.via).toBe("new-conversation");
    expect(mod.isControllable(sessionId)).toBe(true);
    // We force claude to adopt it, so its frames carry our id from frame one.
    const args = shared.children[shared.children.length - 1].spawnArgs as string[];
    const i = args.indexOf("--session-id");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(sessionId);
    // A fresh spawn is NOT a resume.
    expect(args).not.toContain("--resume");
    // Plan-mode steering rides on the session's appended system prompt (invisible
    // to the transcript), not on per-turn text injection.
    const sp = args.indexOf("--append-system-prompt");
    expect(sp).toBeGreaterThanOrEqual(0);
    expect(args[sp + 1]).toMatch(/submit_plan/);
    expect(args[sp + 1]).toMatch(/plan mode/i);
  });
});

describe("stdout parser: session id is owned (no swap for new sessions)", () => {
  it("keeps its owned id when claude's first frame reports the same id — no swap, no alias", async () => {
    const events: any[] = [];
    mod.activeSessionsBus.on("change", (p) => events.push(p));

    const { sessionId } = await mod.startNewConversation({ cwd: "/workspace" });

    // claude adopts our id (--session-id), so its first frame carries it back.
    (shared.children[0].stdout as any).pushLine({ type: "system", subtype: "init", session_id: sessionId });
    await flush();

    // Id is stable; still resolves to itself with no alias remap.
    expect(mod.getActiveSession(sessionId)?.sessionId).toBe(sessionId);
    expect(mod.aliasesFor(sessionId)).toEqual([]);
    // No aliasFrom swap event was emitted.
    expect(events.find((e) => e.aliasFrom)).toBeUndefined();
  });

  it("DEFENSIVE: still swaps + aliases if claude ever reports a DIFFERENT id", async () => {
    const events: any[] = [];
    mod.activeSessionsBus.on("change", (p) => events.push(p));

    const { sessionId } = await mod.startNewConversation({ cwd: "/workspace" });
    (shared.children[0].stdout as any).pushLine({ type: "system", subtype: "init", session_id: "surprise-id" });
    await flush();

    expect(mod.getActiveSession(sessionId)?.sessionId).toBe("surprise-id");
    expect(mod.getActiveSession("surprise-id")?.sessionId).toBe("surprise-id");
    const swap = events.find((e) => e.aliasFrom === sessionId);
    expect(swap).toBeDefined();
    expect(swap.sessionId).toBe("surprise-id");
  });

  it("swaps again if --resume yields a new id (resume case)", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "first" });
    await flush();
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "second" });
    await flush();

    expect(mod.getActiveSession("first")?.sessionId).toBe("second");
    expect(mod.getActiveSession("second")?.sessionId).toBe("second");
    expect(mod.getActiveSession(sessionId)?.sessionId).toBe("second");
  });
});

describe("stdout parser: synthetic frame ingestion", () => {
  it("ingests a synthetic /cost-style assistant frame as kind=info", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "subscription active" }] },
      session_id: "synth-1",
    });
    await flush();

    expect(ingestEventLineMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(ingestEventLineMock.mock.calls[0][0]);
    expect(payload.hook).toBe("Stop");
    expect(payload.ctx.kind).toBe("info");
    expect(payload.ctx.last_assistant_message).toBe("subscription active");
    expect(payload.ctx.synthetic).toBe(true);
  });

  it("tags a synthetic '(no content)' frame as kind=cleared with friendly text", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "(no content)" }] },
      session_id: "synth-2",
    });
    await flush();

    expect(ingestEventLineMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(ingestEventLineMock.mock.calls[0][0]);
    expect(payload.ctx.kind).toBe("cleared");
    expect(payload.ctx.last_assistant_message).toBe("Conversation cleared.");
  });

  it("ingests a synthetic user frame (/compact) as kind=compaction with the summary text", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({
      type: "user",
      isSynthetic: true,
      isReplay: false,
      message: { content: "This session is being continued..." },
      session_id: "compact-1",
    });
    await flush();

    expect(ingestEventLineMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(ingestEventLineMock.mock.calls[0][0]);
    expect(payload.ctx.kind).toBe("compaction");
    expect(payload.ctx.last_assistant_message).toContain("This session is being continued");
  });

  it("ignores user frames with isReplay=true (the 'Compacted' stdout marker)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({
      type: "user",
      isReplay: true,
      message: { content: "<local-command-stdout>Compacted </local-command-stdout>" },
      session_id: "replay-1",
    });
    await flush();

    expect(ingestEventLineMock).not.toHaveBeenCalled();
  });

  it("ignores non-synthetic assistant frames (real model replies route through hooks)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({
      type: "assistant",
      message: { model: "claude-opus-4-7", content: [{ type: "text", text: "hi" }] },
      session_id: "real-1",
    });
    await flush();

    expect(ingestEventLineMock).not.toHaveBeenCalled();
  });
});

describe("windowForModel / autoCompactPct", () => {
  it("maps the 1M-context tier to 1,000,000", () => {
    for (const m of [
      "claude-opus-4-8", "claude-opus-4-8-20260528", "claude-opus-4-7",
      "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5",
    ]) {
      expect(mod.windowForModel(m)).toBe(1_000_000);
    }
  });

  it("maps the 200k-context tier to 200,000", () => {
    for (const m of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-haiku-4-4"]) {
      expect(mod.windowForModel(m)).toBe(200_000);
    }
  });

  it("defaults to 1M when the model is unknown or unset", () => {
    expect(mod.windowForModel(null)).toBe(1_000_000);
    expect(mod.windowForModel("claude-something-new-9")).toBe(1_000_000);
  });

  it("reads HOOP_AUTO_COMPACT_PCT (clamped) with an 85 default", () => {
    expect(mod.autoCompactPct()).toBe(85);
    process.env.HOOP_AUTO_COMPACT_PCT = "70";
    expect(mod.autoCompactPct()).toBe(70);
    process.env.HOOP_AUTO_COMPACT_PCT = "999";
    expect(mod.autoCompactPct()).toBe(85); // out of range -> default
  });
});

describe("spawn: auto-compaction env", () => {
  it("hands claude a per-model window + trigger pct by default", async () => {
    await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    const env = shared.children[0].spawnEnv as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("85");
  });

  it("sizes the window to the model (200k for haiku)", async () => {
    await mod.startNewConversation({ cwd: "/x", model: "claude-haiku-4-5" });
    const env = shared.children[0].spawnEnv as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");
  });

  it("omits the env when HOOP_AUTO_COMPACT=0 (kill-switch)", async () => {
    process.env.HOOP_AUTO_COMPACT = "0";
    await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    const env = shared.children[0].spawnEnv as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();
  });

  it("records the configured window + pct on lastStats", async () => {
    const { meta } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    expect(meta.lastStats?.contextWindow).toBe(1_000_000);
    expect(meta.lastStats?.autoCompactPct).toBe(85);
  });
});

describe("stdout parser: compact_boundary", () => {
  it("auto compaction ingests a kind=compaction row and zeroes usage", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    // Prime a non-zero usage via a result frame so we can see it reset.
    (shared.children[0].stdout as any).pushLine({
      type: "result",
      usage: { input_tokens: 10, cache_read_input_tokens: 500_000, output_tokens: 20 },
      session_id: sessionId,
    });
    await flush();
    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "compact_boundary",
      session_id: sessionId,
      compact_metadata: { trigger: "auto", pre_tokens: 850_000 },
    });
    await flush();

    const payloads = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0]));
    const compaction = payloads.find((p) => p.ctx.kind === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction.ctx.last_assistant_message).toContain("auto-compacted");
    // The meter's numerator is derived from lastStats.usage; the boundary must
    // have zeroed it so the bar drops immediately.
    const usage = mod.getActiveSession(sessionId)?.lastStats?.usage;
    expect(usage).toEqual({
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    });
  });

  it("manual compaction zeroes usage without a duplicate transcript row", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    (shared.children[0].stdout as any).pushLine({
      type: "result",
      usage: { input_tokens: 10, cache_read_input_tokens: 500_000, output_tokens: 20 },
      session_id: sessionId,
    });
    await flush();
    ingestEventLineMock.mockClear();
    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "compact_boundary",
      session_id: sessionId,
      compact_metadata: { trigger: "manual", pre_tokens: 1200 },
    });
    await flush();

    // Manual /compact already renders via its synthetic USER summary frame, so
    // the boundary itself must NOT synthesize a second compaction row.
    const compactionRows = ingestEventLineMock.mock.calls
      .map((c) => JSON.parse(c[0]))
      .filter((p) => p.ctx.kind === "compaction");
    expect(compactionRows).toHaveLength(0);
  });
});

describe("stdout parser: control_request (permission ask)", () => {
  it("records a pending permission request and ingests a PermissionRequest event", async () => {
    const { sessionId: pendingId } = await mod.startNewConversation({ cwd: "/workspace" });
    // First swap to a real session_id so canonical lookups work cleanly.
    (shared.children[0].stdout as any).pushLine({ type: "system", subtype: "init", session_id: "real-A" });
    await flush();
    (shared.children[0].stdout as any).pushLine({
      type: "control_request",
      request_id: "req-1",
      tool_use_id: "tu-1",
      session_id: "real-A",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /tmp/foo" },
        decision_reason: "writes to /tmp",
      },
    });
    await flush();

    // Pending state holds the request.
    const pending = mod.getPendingRequests("real-A");
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe("req-1");
    expect(pending[0].toolName).toBe("Bash");
    expect(pending[0].toolUseId).toBe("tu-1");
    expect(pending[0].decisionReason).toBe("writes to /tmp");
    expect(pending[0].input).toEqual({ command: "rm -rf /tmp/foo" });

    // An event was ingested with hook=PermissionRequest.
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    const permEvent = ingestCalls.find((e) => e.hook === "PermissionRequest");
    expect(permEvent).toBeDefined();
    expect(permEvent.ctx.tool_name).toBe("Bash");
    expect(permEvent.ctx.request_id).toBe("req-1");

    void pendingId;
  });

  it("ignores control_request frames without a can_use_tool subtype", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-B" });
    await flush();
    (shared.children[0].stdout as any).pushLine({
      type: "control_request",
      request_id: "req-X",
      session_id: "sid-B",
      request: { subtype: "something_else", tool_name: "ignored" },
    });
    await flush();

    expect(mod.getPendingRequests("sid-B")).toHaveLength(0);
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionRequest")).toBeUndefined();
  });
});

describe("respondToPermission", () => {
  it("drops the pending entry and ingests a PermissionResponse event (no stdin write)", async () => {
    // Earlier versions also wrote a control_response frame to claude's stdin
    // for forward-compat with a hypothetical stream-json permission protocol.
    // Empirically that frame caused claude in -p mode to exit mid-turn, so
    // we removed the write — the hook's stdout JSON is the sole signal that
    // unblocks the model now.
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[0];
    (child.stdout as any).pushLine({ type: "system", session_id: "sid-C" });
    await flush();
    (child.stdout as any).pushLine({
      type: "control_request",
      request_id: "req-7",
      tool_use_id: "tu-7",
      session_id: "sid-C",
      request: { subtype: "can_use_tool", tool_name: "Edit", input: { path: "a" } },
    });
    await flush();

    const writes: string[] = [];
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: any, ...rest: any[]) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return origWrite(chunk, ...rest);
    };

    const result = await mod.respondToPermission("sid-C", "req-7", "allow");
    expect(result.ok).toBe(true);

    expect(mod.getPendingRequests("sid-C")).toHaveLength(0);
    expect(writes.find((w) => w.includes("control_response"))).toBeUndefined();

    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionResponse" && e.ctx.decision === "allow"))
      .toBeDefined();
  });

  it("returns ok:false for unknown session", async () => {
    const r = await mod.respondToPermission("no-such-session", "req-9", "deny");
    expect(r.ok).toBe(false);
  });

  it("returns ok:false for unknown request id on a real session", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-D" });
    await flush();
    const r = await mod.respondToPermission("sid-D", "missing-req", "allow");
    expect(r.ok).toBe(false);
  });
});

describe("hook-driven permission flow (createPermissionRequest + awaitPermissionDecision)", () => {
  it("createPermissionRequest registers a pending entry and ingests a PermissionRequest event", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-E" });
    await flush();
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-E",
      toolName: "Write",
      input: { path: "/workspace/foo.txt" },
      toolUseId: "tu-E1",
    });
    expect(requestId).toBe("tu-E1");
    expect(mod.getPendingRequests("sid-E")).toHaveLength(1);
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionRequest" && e.ctx.request_id === "tu-E1")).toBeDefined();
  });

  it("awaitPermissionDecision resolves with the decision when respondToPermission lands", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-F" });
    await flush();
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-F", toolName: "Write", input: { path: "/workspace/foo.txt" }, toolUseId: "tu-F",
    });
    const waiter = mod.awaitPermissionDecision(requestId, 5000);
    // Simulate the dashboard responding before timeout.
    setImmediate(() => { void mod.respondToPermission("sid-F", requestId, "deny", "user said no"); });
    const result = await waiter;
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("user said no");
  });

  it("awaitPermissionDecision returns timeout when no decision arrives", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-G" });
    await flush();
    mod.createPermissionRequest({ sessionId: "sid-G", toolName: "Read", input: { path: "x" }, toolUseId: "tu-G" });
    const result = await mod.awaitPermissionDecision("tu-G", 1000);
    expect(result.decision).toBe("timeout");
  });

  it("awaitPermissionDecision consumes an early decision (race: dashboard responded before hook polled)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-H" });
    await flush();
    mod.createPermissionRequest({ sessionId: "sid-H", toolName: "Write", input: { p: "x" }, toolUseId: "tu-H" });
    // Dashboard responds BEFORE the hook ever starts long-polling.
    await mod.respondToPermission("sid-H", "tu-H", "allow", "approved early");
    // Now the hook's long-poll starts — should resolve immediately, not wait.
    const start = Date.now();
    const result = await mod.awaitPermissionDecision("tu-H", 5000);
    const elapsed = Date.now() - start;
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("approved early");
    expect(elapsed).toBeLessThan(100);
  });
});

describe("/plan turn (plan-mode trigger)", () => {
  async function primeSession(sid: string) {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    const writes: string[] = [];
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: any, ...rest: any[]) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return origWrite(chunk, ...rest);
    };
    return { writes };
  }
  const frames = (writes: string[]) =>
    writes.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("flips permission mode to plan and strips the /plan prefix, control frame first", async () => {
    const { writes } = await primeSession("sid-plan");
    await mod.writeUserTurn("sid-plan", "/plan implement the widget");
    const fs = frames(writes);
    const control = fs.find((f) => f.type === "control_request");
    expect(control?.request?.subtype).toBe("set_permission_mode");
    expect(control?.request?.mode).toBe("plan");
    const user = fs.find((f) => f.type === "user");
    // The task is forwarded VERBATIM with the /plan prefix stripped — no
    // per-turn planning brief lands in the conversation. Plan mode is engaged
    // via the set_permission_mode flip; the model is steered to submit_plan by
    // the session's appended system prompt (asserted in the spawn test), not by
    // text injected into this turn.
    expect(user?.message?.content?.[0]?.text).toContain("implement the widget");
    expect(user?.message?.content?.[0]?.text).not.toContain("/plan");
    expect(user?.message?.content?.[0]?.text).not.toMatch(/ExitPlanMode/);
    // The steering must never leak into the visible turn text.
    expect(user?.message?.content?.[0]?.text).not.toMatch(/submit_plan/);
    const joined = writes.join("");
    expect(joined.indexOf("set_permission_mode")).toBeLessThan(joined.indexOf("implement the widget"));
  });

  it("falls back to a minimal neutral nudge when /plan has no task", async () => {
    const { writes } = await primeSession("sid-plan2");
    await mod.writeUserTurn("sid-plan2", "/plan");
    const fs = frames(writes);
    expect(fs.find((f) => f.type === "control_request")?.request?.mode).toBe("plan");
    const text = fs.find((f) => f.type === "user")?.message?.content?.[0]?.text;
    // Bare `/plan` can't forward an empty turn, so it gets a minimal neutral
    // nudge — still no planning brief / ExitPlanMode instructions in the turn.
    expect(text).toMatch(/task we've been discussing/i);
    expect(text).not.toMatch(/ExitPlanMode/);
    expect(text).not.toMatch(/submit_plan/);
  });

  it("leaves a normal turn untouched (no mode change, verbatim text)", async () => {
    const { writes } = await primeSession("sid-normal");
    await mod.writeUserTurn("sid-normal", "just do the thing");
    expect(writes.join("")).not.toContain("set_permission_mode");
    expect(frames(writes).find((f) => f.type === "user")?.message?.content?.[0]?.text).toContain("just do the thing");
  });

  it("tags a /plan turn kind=command and preserves the original typed text for the transcript", async () => {
    await primeSession("sid-plan-attr");
    await mod.writeUserTurn("sid-plan-attr", "/plan implement the widget");
    // The model got the stripped task (asserted above), but the transcript must
    // reconcile with the optimistic "/plan …" row and show what was typed.
    const meta = mod.popPendingAuthor("sid-plan-attr");
    expect(meta.kind).toBe("command");
    expect(meta.promptOverride).toBe("/plan implement the widget");
  });

  it("does not tag a plain-text turn as a command, but overrides the prompt so the attribution prefix stays out of the transcript", async () => {
    await primeSession("sid-plain-attr");
    await mod.writeUserTurn("sid-plain-attr", "just do the thing");
    const meta = mod.popPendingAuthor("sid-plain-attr");
    expect(meta.kind).toBeNull();
    // The model-facing text carries the "[Session context: …]" prefix, so the
    // transcript-facing promptOverride restores exactly what the user typed.
    expect(meta.promptOverride).toBe("just do the thing");
  });

  it("does not tag a message that merely starts with a slash but isn't a command", async () => {
    await primeSession("sid-slashy");
    await mod.writeUserTurn("sid-slashy", "/etc/hosts got clobbered, please check");
    const meta = mod.popPendingAuthor("sid-slashy");
    expect(meta.kind).toBeNull();
    expect(meta.promptOverride).toBe("/etc/hosts got clobbered, please check");
  });

  it("attaches image blocks (image first, then text) to a turn", async () => {
    const { writes } = await primeSession("sid-img");
    await mod.writeUserTurn("sid-img", "what is this?", "host", null, {
      images: [{ media_type: "image/png", data: "QUJD" }],
    });
    const content = frames(writes).find((f) => f.type === "user")?.message?.content;
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
    // Every turn carries an authoritative-author attribution prefix in the
    // model-facing text (the transcript still shows the raw typed text).
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("what is this?");
    expect(content[1].text).toContain("from the host");
  });

  it("attributes an image-only turn with an author text block", async () => {
    const { writes } = await primeSession("sid-img2");
    await mod.writeUserTurn("sid-img2", "", "host", null, {
      images: [{ media_type: "image/jpeg", data: "Zm9v" }],
    });
    const content = frames(writes).find((f) => f.type === "user")?.message?.content;
    expect(content[0].type).toBe("image");
    // Even with no typed text, the attribution line is sent so the model knows
    // who shared the image.
    expect(content[1]).toMatchObject({ type: "text" });
    expect(content[1].text).toContain("from the host");
  });
});

describe("control commands (/model, /stop) echo once as kind=command", () => {
  async function prime(sid: string) {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    return child;
  }
  const ingested = () => ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
  const commandEvents = () =>
    ingested().filter((e) => e.hook === "UserPromptSubmit" && e.ctx?.kind === "command");
  const stopEvents = () => ingested().filter((e) => e.hook === "Stop");

  it("setSessionModel echoes `/model <alias>` once, then a Stop confirmation", async () => {
    await prime("sid-model");
    mod.setSessionModel("sid-model", "opus", "host");
    const cmds = commandEvents();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].ctx.prompt).toBe("/model opus");
    expect(cmds[0].ctx.author).toBe("host");
    // The switch confirmation follows as the result — never a message to the model.
    expect(stopEvents().some((e) => /Model set to opus/.test(e.ctx.last_assistant_message))).toBe(true);
  });

  it("interruptSession echoes `/stop` once, then a Stop confirmation", async () => {
    await prime("sid-stop");
    await mod.interruptSession("sid-stop", "host");
    const cmds = commandEvents();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].ctx.prompt).toBe("/stop");
    expect(cmds[0].ctx.author).toBe("host");
    expect(stopEvents().some((e) => /Turn stopped/.test(e.ctx.last_assistant_message))).toBe(true);
  });

  it("interruptSession is a silent no-op when nothing is running (no echo)", async () => {
    await prime("sid-idle");
    // Kill the child so there's nothing to interrupt.
    const slotChild = shared.children[shared.children.length - 1];
    slotChild.killed = true;
    await mod.interruptSession("sid-idle", "host");
    expect(commandEvents()).toHaveLength(0);
  });
});

describe("plan-mode enforcement (permission policy)", () => {
  async function prime(sid: string) {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
  }

  it("hard-denies mutating tools while a /plan turn is active (no dashboard card)", async () => {
    await prime("sid-pm1");
    await mod.writeUserTurn("sid-pm1", "/plan build the widget");
    for (const tool of ["Write", "Edit", "MultiEdit", "Bash", "Task"]) {
      const { requestId } = mod.createPermissionRequest({
        sessionId: "sid-pm1", toolName: tool, input: { command: "touch x" }, toolUseId: `t-${tool}`,
      });
      expect(mod.getPendingRequests("sid-pm1")).toHaveLength(0); // no card — answered immediately
      const r = await mod.awaitPermissionDecision(requestId, 500);
      expect(r.decision).toBe("deny");
      expect(r.reason).toMatch(/read-only|plan/i);
    }
  });

  it("allows read-only tools while planning", async () => {
    await prime("sid-pm2");
    await mod.writeUserTurn("sid-pm2", "/plan build X");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pm2", toolName: "Read", input: { path: "/x" }, toolUseId: "r1",
    });
    expect((await mod.awaitPermissionDecision(requestId, 500)).decision).toBe("allow");
  });

  it("captures the plan for review and denies ExitPlanMode (turn holds for approval)", async () => {
    await prime("sid-pm3");
    await mod.writeUserTurn("sid-pm3", "/plan build X");
    ingestEventLineMock.mockClear();
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pm3", toolName: "ExitPlanMode", input: { plan: "1. do X\n2. do Y" }, toolUseId: "e1",
    });
    const r = await mod.awaitPermissionDecision(requestId, 500);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/review/i);
    // The plan review (the annotatable card the dashboard renders) was created.
    const calls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    const review = calls.find((e) => e.hook === "PermissionRequest" && e.ctx.tool_name === "ExitPlanMode");
    expect(review).toBeDefined();
    expect(String(review.ctx.tool_input)).toContain("do X");
    expect(mod.getPendingRequests("sid-pm3").some((p) => p.toolName === "ExitPlanMode")).toBe(true);
  });

  it("non-plan Bash auto-allows without a card; git push escalates to a dashboard decision", async () => {
    await prime("sid-pm4"); // no /plan → not plan mode
    const ok = mod.createPermissionRequest({
      sessionId: "sid-pm4", toolName: "Bash", input: { command: "ls -la" }, toolUseId: "b1",
    });
    expect(mod.getPendingRequests("sid-pm4")).toHaveLength(0);
    expect((await mod.awaitPermissionDecision(ok.requestId, 500)).decision).toBe("allow");
    // git push must NOT auto-allow — it creates a dashboard-pending ask.
    mod.createPermissionRequest({
      sessionId: "sid-pm4", toolName: "Bash", input: { command: "git push origin main" }, toolUseId: "b2",
    });
    expect(mod.getPendingRequests("sid-pm4").some((p) => p.toolUseId === "b2")).toBe(true);
    expect((await mod.awaitPermissionDecision("b2", 300)).decision).toBe("timeout");
  });

  it("auto-allows an approved plan's tool calls (git push included), then re-gates after the next turn", async () => {
    await prime("sid-pm-ap");
    // The approval "proceed" turn (what respondToPermission injects on approve).
    await mod.writeUserTurn("sid-pm-ap", "The plan is approved — proceed with implementing it.", "host", null, {
      mode: "bypassPermissions",
      autoAllowRun: true,
    });
    // A mutating Write auto-allows with NO card.
    const w = mod.createPermissionRequest({
      sessionId: "sid-pm-ap", toolName: "Write", input: { file_path: "/x", content: "y" }, toolUseId: "w1",
    });
    expect(mod.getPendingRequests("sid-pm-ap")).toHaveLength(0);
    expect((await mod.awaitPermissionDecision(w.requestId, 500)).decision).toBe("allow");
    // Even git push auto-allows during an approved run (no carve-out).
    const p = mod.createPermissionRequest({
      sessionId: "sid-pm-ap", toolName: "Bash", input: { command: "git push origin main" }, toolUseId: "p1",
    });
    expect(mod.getPendingRequests("sid-pm-ap")).toHaveLength(0);
    expect((await mod.awaitPermissionDecision(p.requestId, 500)).decision).toBe("allow");
    // The window is one turn: an ordinary next turn clears auto-allow, so a Write
    // escalates to a dashboard card again.
    await mod.writeUserTurn("sid-pm-ap", "now do something else", "host");
    mod.createPermissionRequest({
      sessionId: "sid-pm-ap", toolName: "Write", input: { file_path: "/z", content: "q" }, toolUseId: "w2",
    });
    expect(mod.getPendingRequests("sid-pm-ap").some((p) => p.toolUseId === "w2")).toBe(true);
    expect((await mod.awaitPermissionDecision("w2", 300)).decision).toBe("timeout");
  });

  const MCP_SUBMIT = "mcp__plugin_hoop_tools__submit_plan";
  const MCP_ENTER = "mcp__plugin_hoop_tools__enter_plan_mode";
  const MCP_ASK = "mcp__plugin_hoop_tools__ask_user_question";

  it("bundled MCP submit_plan captures the plan for review and denies the call", async () => {
    await prime("sid-pm5");
    await mod.writeUserTurn("sid-pm5", "/plan build X");
    ingestEventLineMock.mockClear();
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pm5", toolName: MCP_SUBMIT, input: { plan: "1. do A\n2. do B" }, toolUseId: "s1",
    });
    const r = await mod.awaitPermissionDecision(requestId, 500);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/review/i);
    const calls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    const review = calls.find((e) => e.hook === "PermissionRequest" && e.ctx.tool_name === "ExitPlanMode");
    expect(review).toBeDefined();
    expect(String(review.ctx.tool_input)).toContain("do A");
    expect(mod.getPendingRequests("sid-pm5").some((p) => p.toolName === "ExitPlanMode")).toBe(true);
  });

  it("submit_plan captures even OUTSIDE a plan turn (no stray dashboard card)", async () => {
    await prime("sid-pm6"); // no /plan
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pm6", toolName: MCP_SUBMIT, input: { plan: "the plan" }, toolUseId: "s2",
    });
    expect((await mod.awaitPermissionDecision(requestId, 500)).decision).toBe("deny");
    // The only pending is the plan review, not a permission card for the tool.
    const pending = mod.getPendingRequests("sid-pm6");
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("ExitPlanMode");
    expect((pending[0].input as any).plan).toBe("the plan");
  });

  it("enter_plan_mode engages read-only mode (subsequent mutations denied)", async () => {
    await prime("sid-pm7"); // no /plan yet
    const enter = mod.createPermissionRequest({
      sessionId: "sid-pm7", toolName: MCP_ENTER, input: {}, toolUseId: "e1",
    });
    const er = await mod.awaitPermissionDecision(enter.requestId, 500);
    expect(er.decision).toBe("deny");
    expect(er.reason).toMatch(/plan mode|read-only/i);
    // Now a mutating tool is hard-denied (plan mode is engaged for the turn).
    const w = mod.createPermissionRequest({
      sessionId: "sid-pm7", toolName: "Write", input: { file_path: "/x" }, toolUseId: "w1",
    });
    expect((await mod.awaitPermissionDecision(w.requestId, 500)).decision).toBe("deny");
    // ...but reads still pass.
    const rd = mod.createPermissionRequest({
      sessionId: "sid-pm7", toolName: "Read", input: { file_path: "/x" }, toolUseId: "rd1",
    });
    expect((await mod.awaitPermissionDecision(rd.requestId, 500)).decision).toBe("allow");
  });

  it("bundled MCP ask_user_question normalizes to AskUserQuestion + surfaces a pending question (not auto-decided)", async () => {
    await prime("sid-ask1");
    const input = { questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }] };
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-ask1", toolName: MCP_ASK, input, toolUseId: "q1",
    });
    // It surfaces as a native-shaped AskUserQuestion pending request (routed to
    // the AskQuestion UI), carrying the questions — NOT auto-allowed/denied.
    const pending = mod.getPendingRequests("sid-ask1");
    const q = pending.find((p) => p.requestId === requestId);
    expect(q).toBeDefined();
    expect(q!.toolName).toBe("AskUserQuestion");
    expect((q!.input as any).questions[0].options).toHaveLength(2);
    // No early decision — it waits for the operator to answer.
    expect((await mod.awaitPermissionDecision(requestId, 200)).decision).toBe("timeout");
  });

  it("answering an MCP ask_user_question relays the answer as a follow-up turn", async () => {
    await prime("sid-ask2");
    const child = shared.children[shared.children.length - 1];
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-ask2", toolName: MCP_ASK,
      input: { questions: [{ question: "Which?", options: [{ label: "X" }, { label: "Y" }] }] }, toolUseId: "q2",
    });
    // Capture stdin writes to prove the answer is delivered as a follow-up turn.
    const writes: string[] = [];
    const orig = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: any, ...rest: any[]) => { writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8")); return orig(chunk, ...rest); };
    // The operator answers via a deny carrying the answer text (the native path).
    const res = await mod.respondToPermission("sid-ask2", requestId, "deny", "Go with X");
    expect(res.ok).toBe(true);
    await flush();
    const joined = writes.join("");
    expect(joined).toContain("Go with X");
    expect(joined.toLowerCase()).toContain("answer to the question");
  });

  it("surfaces an AskUserQuestion DURING a /plan turn instead of hard-denying it", async () => {
    await prime("sid-ask-plan");
    await mod.writeUserTurn("sid-ask-plan", "/plan build the widget");
    const input = { questions: [{ question: "Which source?", options: [{ label: "A" }, { label: "B" }] }] };
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-ask-plan", toolName: MCP_ASK, input, toolUseId: "qp1",
    });
    // A clarifying question is read-only, so it surfaces as a pending card
    // rather than getting the plan-mode hard-deny that mutating tools receive.
    const q = mod.getPendingRequests("sid-ask-plan").find((p) => p.requestId === requestId);
    expect(q).toBeDefined();
    expect(q!.toolName).toBe("AskUserQuestion");
    expect(q!.planMode).toBe(true);
    expect((await mod.awaitPermissionDecision(requestId, 200)).decision).toBe("timeout");
    // A mutating tool in the same plan turn is still hard-denied — the carve-out
    // is scoped to AskUserQuestion only.
    const w = mod.createPermissionRequest({
      sessionId: "sid-ask-plan", toolName: "Write", input: { file_path: "/x" }, toolUseId: "wp1",
    });
    const wr = await mod.awaitPermissionDecision(w.requestId, 500);
    expect(wr.decision).toBe("deny");
    expect(wr.reason).toMatch(/read-only|plan/i);
  });

  it("stays in plan mode after answering a question asked during planning", async () => {
    await prime("sid-ask-plan2");
    await mod.writeUserTurn("sid-ask-plan2", "/plan build X");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-ask-plan2", toolName: MCP_ASK,
      input: { questions: [{ question: "Which?", options: [{ label: "X" }, { label: "Y" }] }] }, toolUseId: "qp2",
    });
    // Operator answers (deny + answer text = the native ask relay path).
    await mod.respondToPermission("sid-ask-plan2", requestId, "deny", "Go with X");
    await flush();
    // Regression guard: the answer turn must NOT silently drop plan enforcement.
    // A mutation is still hard-denied (no dashboard card), so the model keeps
    // planning until it submits a plan for approval.
    const w = mod.createPermissionRequest({
      sessionId: "sid-ask-plan2", toolName: "Write", input: { file_path: "/x" }, toolUseId: "wp2",
    });
    const wr = await mod.awaitPermissionDecision(w.requestId, 500);
    expect(wr.decision).toBe("deny");
    expect(wr.reason).toMatch(/read-only|plan/i);
    expect(mod.getPendingRequests("sid-ask-plan2").some((p) => p.toolUseId === "wp2")).toBe(false);
  });
});

describe("shared plan-review comments", () => {
  it("adds comments, lists them, and threads replies", () => {
    const c = mod.addPlanReviewComment({ requestId: "pr-1", author: "alice", quote: "step 1", offset: 5, length: 6, body: "too vague" });
    const list = mod.listPlanReviewComments("pr-1");
    expect(list).toHaveLength(1);
    expect(list[0].author).toBe("alice");
    expect(list[0].body).toBe("too vague");
    expect(mod.addPlanReviewReply({ requestId: "pr-1", commentId: c.id, author: "bob", body: "agree" })).toBe(true);
    expect(mod.listPlanReviewComments("pr-1")[0].replies[0]).toMatchObject({ author: "bob", body: "agree" });
  });

  it("only the author can edit or remove their comment", () => {
    const c = mod.addPlanReviewComment({ requestId: "pr-2", author: "alice", quote: "x", offset: 0, length: 1, body: "a" });
    expect(mod.editPlanReviewComment("pr-2", c.id, "bob", "hacked")).toBe("forbidden");
    expect(mod.editPlanReviewComment("pr-2", c.id, "alice", "edited")).toBe("ok");
    expect(mod.listPlanReviewComments("pr-2")[0].body).toBe("edited");
    expect(mod.removePlanReviewComment("pr-2", c.id, "bob")).toBe("forbidden");
    expect(mod.removePlanReviewComment("pr-2", c.id, "alice")).toBe("ok");
    expect(mod.listPlanReviewComments("pr-2")).toHaveLength(0);
  });

  it("clears a plan's comments once it is decided", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[shared.children.length - 1].stdout as any).pushLine({ type: "system", session_id: "sid-cc" });
    await flush();
    // A /plan turn makes ExitPlanMode capture into a review; the review carries
    // its own requestId (what the dashboard renders + attaches comments to).
    await mod.writeUserTurn("sid-cc", "/plan build");
    mod.createPermissionRequest({ sessionId: "sid-cc", toolName: "ExitPlanMode", input: { plan: "p" }, toolUseId: "tu-cc" });
    const requestId = mod.getPendingRequests("sid-cc").find((p) => p.toolName === "ExitPlanMode")!.requestId;
    mod.addPlanReviewComment({ requestId, author: "host", quote: "q", offset: 0, length: 1, body: "note" });
    expect(mod.listPlanReviewComments(requestId)).toHaveLength(1);
    await mod.respondToPermission("sid-cc", requestId, "allow");
    expect(mod.listPlanReviewComments(requestId)).toHaveLength(0);
  });
});

describe("robust plan capture (synthetic plan review)", () => {
  async function primePlanSession(sid: string) {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    return child;
  }
  const captureWrites = (child: any) => {
    const writes: string[] = [];
    const orig = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: any, ...rest: any[]) => { writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8")); return orig(chunk, ...rest); };
    return writes;
  };

  const SUBMIT_PLAN = "mcp__plugin_hoop_tools__submit_plan";

  it("surfaces a review when the model calls submit_plan (deterministic capture)", async () => {
    await primePlanSession("sid-pr1");
    await mod.writeUserTurn("sid-pr1", "/plan build a widget");
    mod.createPermissionRequest({ sessionId: "sid-pr1", toolName: SUBMIT_PLAN, input: { plan: "## Plan\n1. do a\n2. do b" }, toolUseId: "tu-pr1" });
    const pending = mod.getPendingRequests("sid-pr1");
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("ExitPlanMode"); // surfaced under the native name the PlanPanel renders
    expect(pending[0].synthetic).toBe(true);
    expect((pending[0].input as any).plan).toContain("do a");
  });

  // The core regression (session d992864e): a plan-mode turn that ends with
  // PROSE and never calls submit_plan must NOT surface a review. Previously the
  // result frame synthesized a plan from the final message, turning declines,
  // clarifying questions, and acknowledgments into spurious Plan cards.
  it("does NOT surface a review when a /plan turn ends with prose but no submit_plan call", async () => {
    const child = await primePlanSession("sid-noprose");
    await mod.writeUserTurn("sid-noprose", "/plan build a widget");
    (child.stdout as any).pushLine({ type: "assistant", session_id: "sid-noprose", message: { role: "assistant", content: [{ type: "text", text: "## Plan\n1. do a\n2. do b" }] } });
    (child.stdout as any).pushLine({ type: "result", session_id: "sid-noprose", result: "## Plan\n1. do a\n2. do b", usage: { input_tokens: 5, output_tokens: 5 } });
    await flush();
    expect(mod.getPendingRequests("sid-noprose")).toHaveLength(0);
  });

  // The exact reported case: reject a plan (re-enters plan mode), the model
  // replies conversationally instead of re-planning. That acknowledgment must
  // NOT become a new Plan card.
  it("does NOT surface a review for a conversational reply on a rejection-revise turn", async () => {
    const child = await primePlanSession("sid-revise");
    // Original plan submitted + rejected → the internal revise turn re-enters plan mode.
    await mod.writeUserTurn("sid-revise", "The plan was rejected. Revise it based on this feedback:\n\nnevermind, no script needed", "host", null, { mode: "plan", kind: "plan-rejection" });
    (child.stdout as any).pushLine({ type: "assistant", session_id: "sid-revise", message: { role: "assistant", content: [{ type: "text", text: "Understood — no script needed. Let me know if you'd like anything else." }] } });
    (child.stdout as any).pushLine({ type: "result", session_id: "sid-revise", result: "Understood — no script needed. Let me know if you'd like anything else.", usage: { input_tokens: 5, output_tokens: 5 } });
    await flush();
    expect(mod.getPendingRequests("sid-revise")).toHaveLength(0);
  });

  it("falls back to the turn's assistant prose when submit_plan carries an empty plan arg", async () => {
    const child = await primePlanSession("sid-pr3");
    await mod.writeUserTurn("sid-pr3", "/plan build");
    (child.stdout as any).pushLine({ type: "assistant", session_id: "sid-pr3", message: { role: "assistant", content: [{ type: "text", text: "Here is the plan prose." }] } });
    await flush();
    mod.createPermissionRequest({ sessionId: "sid-pr3", toolName: SUBMIT_PLAN, input: {}, toolUseId: "tu-pr3" });
    const review = mod.getPendingRequests("sid-pr3").find((p) => p.toolName === "ExitPlanMode");
    expect((review!.input as any).plan).toBe("Here is the plan prose.");
  });

  // A `<synthetic>` notice (usage limit, "(no content)") is not the model
  // talking, so it must never pollute the empty-arg prose fallback.
  it("a synthetic notice does not become the empty-arg fallback plan", async () => {
    const child = await primePlanSession("sid-syn");
    await mod.writeUserTurn("sid-syn", "/plan build");
    (child.stdout as any).pushLine({ type: "assistant", session_id: "sid-syn", message: { role: "assistant", content: [{ type: "text", text: "the real plan prose" }] } });
    (child.stdout as any).pushLine({ type: "assistant", session_id: "sid-syn", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit" }] } });
    await flush();
    mod.createPermissionRequest({ sessionId: "sid-syn", toolName: SUBMIT_PLAN, input: {}, toolUseId: "tu-syn" });
    const review = mod.getPendingRequests("sid-syn").find((p) => p.toolName === "ExitPlanMode");
    expect((review!.input as any).plan).toBe("the real plan prose");
  });

  it("submit_plan capture creates exactly one review (the result frame adds none)", async () => {
    const child = await primePlanSession("sid-pr2");
    await mod.writeUserTurn("sid-pr2", "/plan build");
    mod.createPermissionRequest({ sessionId: "sid-pr2", toolName: SUBMIT_PLAN, input: { plan: "explicit plan" }, toolUseId: "tu-pr2" });
    // The result frame must NOT create a second review — synthesis is gone.
    (child.stdout as any).pushLine({ type: "result", session_id: "sid-pr2", result: "done", usage: { input_tokens: 5, output_tokens: 5 } });
    await flush();
    const pending = mod.getPendingRequests("sid-pr2");
    expect(pending.filter((p) => p.toolName === "ExitPlanMode")).toHaveLength(1);
    expect((pending[0].input as any).plan).toBe("explicit plan");
  });

  it("approving a submitted plan review exits plan mode and sends a proceed turn", async () => {
    const child = await primePlanSession("sid-pr4");
    await mod.writeUserTurn("sid-pr4", "/plan build");
    mod.createPermissionRequest({ sessionId: "sid-pr4", toolName: SUBMIT_PLAN, input: { plan: "the plan" }, toolUseId: "tu-pr4" });
    const reqId = mod.getPendingRequests("sid-pr4")[0].requestId;
    const writes = captureWrites(child);
    const res = await mod.respondToPermission("sid-pr4", reqId, "allow");
    expect(res.ok).toBe(true);
    await flush();
    const joined = writes.join("");
    expect(joined).toContain("set_permission_mode");
    expect(joined).toContain("bypassPermissions");
    expect(joined.toLowerCase()).toContain("proceed");
    expect(mod.getPendingRequests("sid-pr4")).toHaveLength(0);
  });

  it("rejecting a submitted plan review sends the feedback and stays in plan mode", async () => {
    const child = await primePlanSession("sid-pr5");
    await mod.writeUserTurn("sid-pr5", "/plan build");
    mod.createPermissionRequest({ sessionId: "sid-pr5", toolName: SUBMIT_PLAN, input: { plan: "the plan" }, toolUseId: "tu-pr5" });
    const reqId = mod.getPendingRequests("sid-pr5")[0].requestId;
    const writes = captureWrites(child);
    const res = await mod.respondToPermission("sid-pr5", reqId, "deny", "make it shorter");
    expect(res.ok).toBe(true);
    await flush();
    const joined = writes.join("");
    expect(joined).toContain("set_permission_mode");
    expect(joined).toContain("plan");
    expect(joined).toContain("make it shorter");
    expect(mod.getPendingRequests("sid-pr5")).toHaveLength(0);
  });
});

describe("slot-less permission asks (standalone skill runs)", () => {
  // A skill run (spawn.ts) executes `claude -p` WITHOUT registering a
  // controllable slot. Its PreToolUse gate still creates a request via
  // createPermissionRequest — it must stay visible + answerable even though
  // getSlot() finds nothing, or the dashboard shows an event with no card and
  // the run times out to a deny.
  it("tracks a pending ask for a session with no slot and ingests the event", () => {
    const { requestId } = mod.createPermissionRequest({
      sessionId: "skill-sid-1",
      toolName: "Write",
      input: { path: "/workspace/report.md" },
      toolUseId: "tu-skill-1",
    });
    expect(requestId).toBe("tu-skill-1");
    const pending = mod.getPendingRequests("skill-sid-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("Write");
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionRequest" && e.ctx.request_id === "tu-skill-1")).toBeDefined();
  });

  it("respondToPermission resolves a slot-less ask, clears it, and unblocks the waiter", async () => {
    const { requestId } = mod.createPermissionRequest({
      sessionId: "skill-sid-2",
      toolName: "Write",
      input: { path: "/workspace/x" },
      toolUseId: "tu-skill-2",
    });
    // The gate long-polls awaitPermissionDecision; confirm the decision reaches it.
    const decisionP = mod.awaitPermissionDecision(requestId, 5000);
    const result = await mod.respondToPermission("skill-sid-2", requestId, "allow");
    expect(result.ok).toBe(true);
    expect(mod.getPendingRequests("skill-sid-2")).toHaveLength(0);
    await expect(decisionP).resolves.toMatchObject({ decision: "allow" });
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionResponse" && e.ctx.request_id === "tu-skill-2" && e.ctx.decision === "allow")).toBeDefined();
  });

  it("returns ok:false for an unknown request on a slot-less session", async () => {
    mod.createPermissionRequest({ sessionId: "skill-sid-3", toolName: "Write", input: {}, toolUseId: "tu-skill-3" });
    const r = await mod.respondToPermission("skill-sid-3", "nope", "deny");
    expect(r.ok).toBe(false);
  });
});

describe("allow-all-from-peer (session-scoped auto-approve)", () => {
  // Drive a turn as a peer so the slot's currentTurn carries their shareId,
  // which is what createPermissionRequest attributes the ask to.
  async function primePeerTurn(sid: string, shareId: string) {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    await mod.writeUserTurn(sid, "do the thing", "Alice", shareId);
    // Simulate the server attributing the UserPromptSubmit → sets currentTurn.
    mod.popPendingAuthor(sid);
  }

  it("auto-approves a trusted peer's ask: no pending card, immediate allow, auto flag", async () => {
    await primePeerTurn("sid-T1", "share-1");
    mod.trustPeerForSession("sid-T1", "share-1");

    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-T1", toolName: "Write", input: { path: "/workspace/x" }, toolUseId: "tu-T1",
    });
    // No card surfaces for an auto-approved ask.
    expect(mod.getPendingRequests("sid-T1")).toHaveLength(0);
    // The hook's long-poll resolves allow immediately (early decision stashed).
    const result = await mod.awaitPermissionDecision(requestId, 5000);
    expect(result.decision).toBe("allow");
    // Transcript records it as an auto-approval.
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionResponse" && e.ctx.request_id === "tu-T1" && e.ctx.auto === true)).toBeDefined();
  });

  it("still escalates git push from a trusted peer (the one guardrail)", async () => {
    await primePeerTurn("sid-T2", "share-2");
    mod.trustPeerForSession("sid-T2", "share-2");

    mod.createPermissionRequest({
      sessionId: "sid-T2", toolName: "Bash", input: { command: "git push origin main" }, toolUseId: "tu-T2",
    });
    // Push is NOT auto-approved — a card surfaces for the host.
    expect(mod.getPendingRequests("sid-T2")).toHaveLength(1);
  });

  it("does not auto-approve an untrusted peer's ask", async () => {
    await primePeerTurn("sid-T3", "share-3");
    // No trustPeerForSession call.
    mod.createPermissionRequest({
      sessionId: "sid-T3", toolName: "Write", input: { path: "/workspace/y" }, toolUseId: "tu-T3",
    });
    expect(mod.getPendingRequests("sid-T3")).toHaveLength(1);
    const pending = mod.getPendingRequests("sid-T3")[0];
    expect(pending.author).toBe("Alice");
  });
});

describe("isControllable", () => {
  it("returns true for a freshly-spawned (alive) session", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    expect(mod.isControllable(sessionId)).toBe(true);
  });

  it("returns false for an unknown sessionId", () => {
    expect(mod.isControllable("does-not-exist")).toBe(false);
  });
});

describe("listActiveSessions", () => {
  it("surfaces both freshly-spawned sessions, with the newer one first", async () => {
    const a = await mod.startNewConversation({ cwd: "/a" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await mod.startNewConversation({ cwd: "/b" });

    const list = mod.listActiveSessions();
    const aEntry = list.find((s) => s.sessionId === a.sessionId);
    const bEntry = list.find((s) => s.sessionId === b.sessionId);
    expect(aEntry).toBeDefined();
    expect(bEntry).toBeDefined();
    const aIdx = list.findIndex((s) => s.sessionId === a.sessionId);
    const bIdx = list.findIndex((s) => s.sessionId === b.sessionId);
    expect(bIdx).toBeLessThan(aIdx);
  });
});

describe("API-failure frames (rate limit)", () => {
  // Shapes verified against a live rate-limited stream: the synthetic assistant
  // frame carries the error CLASS at the frame's top level (`error:"rate_limit"`)
  // — NOT isApiErrorMessage/apiErrorStatus, which exist only in the session
  // .jsonl. The result frame reports subtype:"success" with is_error:true.
  it("tags a synthetic API-error frame as kind=error (not the info catch-all)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.stdout.pushLine({ type: "system", session_id: "real-rl" });
    await flush();
    ingestEventLineMock.mockClear();
    child.stdout.pushLine({
      type: "assistant",
      session_id: "real-rl",
      error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 11:10pm (UTC)" }] },
    });
    await flush();
    const ev = ingestEventLineMock.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => e.hook === "Stop");
    expect(ev).toBeDefined();
    expect(ev.ctx.kind).toBe("error");
    expect(ev.ctx.error).toBe("rate_limit");
    expect(ev.ctx.last_assistant_message).toMatch(/session limit/);
  });

  it("clears the thinking indicator at the result frame (no Stop hook fires on a failed turn)", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.stdout.pushLine({ type: "system", session_id: "real-rl2" });
    await flush();
    await mod.writeUserTurn("real-rl2", "do a thing");
    expect(mod.getActiveSession("real-rl2")?.turnActive).toBe(true);
    // A rate-limited turn: synthetic notice, then a result frame. No Stop HOOK
    // ever arrives (the model never ran), so the result frame must clear it or
    // every viewer's indicator spins forever.
    child.stdout.pushLine({
      type: "assistant",
      session_id: "real-rl2",
      error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit" }] },
    });
    child.stdout.pushLine({
      type: "result",
      subtype: "success",
      is_error: true,
      session_id: "real-rl2",
      result: "You've hit your session limit",
      usage: {},
    });
    await flush();
    expect(mod.getActiveSession("real-rl2")?.turnActive).toBe(false);
    void sessionId;
  });
});

describe("markSessionActive (side-channel activity: !bash / chat)", () => {
  it("bumps lastSeenAt and broadcasts a change, without flipping turnActive", async () => {
    const events: any[] = [];
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[shared.children.length - 1].stdout.pushLine({ type: "system", session_id: "real-act" });
    await flush();
    const before = mod.getActiveSession("real-act")?.lastSeenAt ?? 0;
    await new Promise((r) => setTimeout(r, 5));
    mod.activeSessionsBus.on("change", (p) => events.push(p));
    mod.markSessionActive("real-act");
    const after = mod.getActiveSession("real-act");
    expect(after?.lastSeenAt ?? 0).toBeGreaterThan(before);
    expect(after?.turnActive ?? false).toBe(false); // active, NOT "thinking"
    expect(events.some((e) => e.sessionId === "real-act")).toBe(true);
  });

  it("is a no-op for an unknown session (never throws)", () => {
    expect(() => mod.markSessionActive("no-such-session")).not.toThrow();
  });
});

describe("sweepIdleSessions (idle-TTL dormancy)", () => {
  const TTL = 30 * 60 * 1000; // default HOOP_SESSION_IDLE_TTL_MS

  it("reaps an idle alive session → dormant (revivable), killing its child", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    // Just under the TTL: not reaped yet.
    expect(mod.sweepIdleSessions(lastSeen + TTL - 1000)).not.toContain(sessionId);
    expect(child.kill).not.toHaveBeenCalled();

    // Past the TTL: reaped.
    expect(mod.sweepIdleSessions(lastSeen + TTL + 1000)).toContain(sessionId);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    // The kill's close (claude exits non-zero on SIGTERM) still lands "dormant"
    // because the reap flag forces it — and the slot stays registered (revivable).
    child.emit("close", 1);
    await flush();
    expect(mod.getActiveSession(sessionId)?.status).toBe("dormant");
    expect(mod.isControllable(sessionId)).toBe(true);
  });

  it("does NOT reap a session with a turn in flight, even if idle past the TTL", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.stdout.pushLine({ type: "system", session_id: sessionId });
    await flush();
    await mod.writeUserTurn(sessionId, "do a long thing"); // sets turnActive
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;
    expect(mod.sweepIdleSessions(lastSeen + TTL * 10)).not.toContain(sessionId);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not reap a dormant session (nothing to kill)", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.emit("close", 0); // → dormant
    await flush();
    expect(mod.getActiveSession(sessionId)?.status).toBe("dormant");
    (child.kill as any).mockClear();
    expect(mod.sweepIdleSessions(Date.now() + TTL * 10)).not.toContain(sessionId);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("stdout parser: result frames", () => {
  it("emits a 'turn' event and bumps lastSeenAt when a result frame arrives", async () => {
    const turns: any[] = [];
    mod.activeSessionsBus.on("turn", (p) => turns.push(p));

    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const before = mod.getActiveSession(sessionId)?.lastSeenAt ?? 0;
    await new Promise((r) => setTimeout(r, 5));

    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-r" });
    await flush();
    shared.children[0].stdout.pushLine({ type: "result", subtype: "success", result: "ok", session_id: "real-r" });
    await flush();

    expect(turns).toHaveLength(1);
    expect(turns[0].result).toBe("ok");
    const after = mod.getActiveSession("real-r")?.lastSeenAt ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it("captures per-turn usage + accumulates totals from a real result frame", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-u" });
    await flush();
    shared.children[0].stdout.pushLine({
      type: "result",
      subtype: "success",
      result: "ok",
      session_id: "real-u",
      usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 20 },
    });
    await flush();
    const ls = mod.getActiveSession("real-u")?.lastStats;
    expect(ls?.usage).toEqual({
      input_tokens: 5,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 900,
      output_tokens: 20,
    });
    expect(ls?.totals?.turns).toBe(1);
  });

  it("does NOT let a zero-usage (synthetic) result frame clobber real per-turn usage", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-z" });
    await flush();
    // Real turn.
    shared.children[0].stdout.pushLine({
      type: "result", subtype: "success", result: "ok", session_id: "real-z",
      usage: { input_tokens: 3, cache_creation_input_tokens: 50, cache_read_input_tokens: 70_000, output_tokens: 6 },
    });
    await flush();
    // Synthetic/no-op turn reports all-zero usage — must be ignored.
    shared.children[0].stdout.pushLine({
      type: "result", subtype: "success", result: "noop", session_id: "real-z",
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    });
    await flush();

    const ls = mod.getActiveSession("real-z")?.lastStats;
    // Usage still reflects the real turn (drives the dashboard's ctx %).
    expect(ls?.usage?.cache_read_input_tokens).toBe(70_000);
    // Turn counter not inflated by the synthetic frame.
    expect(ls?.totals?.turns).toBe(1);
  });
});

describe("wake resumes the transcript-bearing id (not the volatile canonical)", () => {
  it("re-keys the slot and resumes the alias whose .jsonl exists on disk", async () => {
    delete process.env.HOOP_CWD_ROOTS;
    const fsReal = await import("node:fs");
    const readdir = fsReal.readdirSync as unknown as ReturnType<typeof vi.fn>;
    // Real, resolvable cwd so the wake-time cwd policy passes cleanly.
    const realCwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "wake-rekey-"));

    // Build a session that swapped ids twice: orig-has-transcript → then a
    // later (empty) resume minted canon-no-transcript. Mirrors the real bug
    // where only the earliest id has a transcript on disk.
    await mod.startNewConversation({ cwd: realCwd });
    const child = shared.children[0];
    child.stdout.pushLine({ type: "system", session_id: "orig-has-transcript" });
    await flush();
    child.stdout.pushLine({ type: "system", session_id: "canon-no-transcript" });
    await flush();
    expect(mod.getActiveSession("canon-no-transcript")?.sessionId).toBe("canon-no-transcript");
    const name = mod.getActiveSession("canon-no-transcript")?.displayName;

    // Subprocess exits cleanly → dormant (per the close-handler fix).
    child.emit("close", 0);
    await flush();
    expect(mod.getActiveSession("canon-no-transcript")?.status).toBe("dormant");

    // Only the ORIGINAL id has a transcript on disk.
    fsMock.existsReturnValue = (p: string) => p.endsWith("/projects");
    readdir.mockReturnValue(["-x"] as any);
    fsMock.statImpl = (p: string) => {
      if (p.endsWith("orig-has-transcript.jsonl")) return { mtimeMs: 1000 };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };

    await mod.wakeSession("canon-no-transcript");

    // Re-keyed: the transcript-bearing id is the new canonical; the old
    // canonical still resolves to it; displayName preserved.
    expect(mod.getActiveSession("orig-has-transcript")?.sessionId).toBe("orig-has-transcript");
    expect(mod.getActiveSession("canon-no-transcript")?.sessionId).toBe("orig-has-transcript");
    expect(mod.getActiveSession("orig-has-transcript")?.displayName).toBe(name);

    readdir.mockReturnValue([] as any);
  });
});

describe("wake with no transcript on disk (session created without a Claude turn)", () => {
  // Regression (session 84170c83): a session can be created via the dashboard
  // and go dormant across a sandbox restart before it ever runs a turn, so it
  // has NO transcript. Earlier builds blindly `--resume`d it; `claude --resume`
  // exits 1 ("No conversation found with session ID"), the queued turn was
  // written into a dying stdin, and the session flickered dormant→alive→ended
  // with no answer. The fix: start a FRESH session under the SAME id so the
  // dashboard's URL stays valid and the turn is delivered. It must NOT prune.
  it("starts a FRESH session under the SAME id (--session-id, not --resume)", async () => {
    delete process.env.HOOP_CWD_ROOTS;
    // Real, resolvable cwd so the wake-time cwd policy passes cleanly.
    const realCwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "wake-fresh-"));

    const { sessionId } = await mod.startNewConversation({ cwd: realCwd });
    const child = shared.children[0];
    child.stdout.pushLine({ type: "system", session_id: sessionId });
    await flush();
    const name = mod.getActiveSession(sessionId)?.displayName;

    // Clean exit → dormant. The session never wrote a transcript.
    child.emit("close", 0);
    await flush();
    expect(mod.getActiveSession(sessionId)?.status).toBe("dormant");

    // No transcript anywhere on disk (default fs mock: existsSync=false).
    const meta = await mod.wakeSession(sessionId);

    // Not pruned; revived ALIVE under the SAME id, displayName preserved.
    expect(meta.status).toBe("alive");
    expect(meta.sessionId).toBe(sessionId);
    expect(mod.getActiveSession(sessionId)?.sessionId).toBe(sessionId);
    expect(mod.getActiveSession(sessionId)?.displayName).toBe(name);

    // The revived child was told to START that id (--session-id), NOT --resume it.
    const args = shared.children[shared.children.length - 1].spawnArgs as string[];
    const si = args.indexOf("--session-id");
    expect(si).toBeGreaterThanOrEqual(0);
    expect(args[si + 1]).toBe(sessionId);
    expect(args).not.toContain("--resume");
  });
});

describe("runtime resume-failure recovery (transcript exists but --resume dies)", () => {
  // Set up a dormant session that HAS a transcript on disk, so wakeSession takes
  // the `--resume` path (resumeSpawn=true). Returns the canonical id.
  async function primeDormantWithTranscript(): Promise<{ id: string; realCwd: string }> {
    delete process.env.HOOP_CWD_ROOTS;
    const fsReal = await import("node:fs");
    const readdir = fsReal.readdirSync as unknown as ReturnType<typeof vi.fn>;
    const realCwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "resume-fail-"));

    await mod.startNewConversation({ cwd: realCwd });
    const child = shared.children[0];
    child.stdout.pushLine({ type: "system", session_id: "resumable-id" });
    await flush();
    child.emit("close", 0); // clean exit → dormant
    await flush();
    expect(mod.getActiveSession("resumable-id")?.status).toBe("dormant");

    // A transcript exists for the canonical id (so --resume is attempted).
    fsMock.existsReturnValue = (p: string) => p.endsWith("/projects");
    readdir.mockReturnValue(["-x"] as any);
    fsMock.statImpl = (p: string) => {
      if (p.endsWith("resumable-id.jsonl")) return { mtimeMs: 1000 };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    return { id: "resumable-id", realCwd };
  }

  afterEach(async () => {
    const fsReal = await import("node:fs");
    (fsReal.readdirSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue([] as any);
  });

  it("a frame-less early exit on a resume spawn → fresh session (new id), old id aliased, turn replayed", async () => {
    const { id } = await primeDormantWithTranscript();
    const name = mod.getActiveSession(id)?.displayName;

    // Fire the turn but don't await yet — we need to drive the resumed child's
    // failure while writeUserTurn is parked watching the resume outcome.
    const p = mod.writeUserTurn(id, "please continue");
    await flush();

    // The resume spawn happened (child #2), told to --resume the canonical id.
    expect(shared.children).toHaveLength(2);
    const resumed = shared.children[1];
    expect(resumed.spawnArgs).toContain("--resume");
    expect(resumed.spawnArgs).toContain(id);

    // Simulate a corrupt/unreadable transcript: claude exits WITHOUT ever
    // emitting a frame (the turn we wrote is swallowed).
    resumed.emit("close", 1);

    const res = await p;

    // Recovery spawned a fresh child (#3) under a BRAND-NEW id via --session-id,
    // never --resume, and never reusing the old (transcript-claimed) id.
    expect(shared.children.length).toBeGreaterThanOrEqual(3);
    const fresh = shared.children[shared.children.length - 1];
    const args = fresh.spawnArgs as string[];
    const si = args.indexOf("--session-id");
    expect(si).toBeGreaterThanOrEqual(0);
    const newId = args[si + 1];
    expect(args).not.toContain("--resume");
    expect(newId).not.toBe(id);
    expect(newId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);

    // The returned id is the fresh one; the OLD id resolves to it via alias
    // (dashboard ?session=<oldId> stays valid); displayName carried over.
    expect(res.sessionId).toBe(newId);
    expect(mod.getActiveSession(id)?.sessionId).toBe(newId);
    expect(mod.getActiveSession(newId)?.status).toBe("alive");
    expect(mod.getActiveSession(newId)?.displayName).toBe(name);

    // A user-facing notice was recorded so the lost history isn't silent.
    const notice = ingestEventLineMock.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => typeof e?.ctx?.last_assistant_message === "string"
        && e.ctx.last_assistant_message.includes("Couldn't resume"));
    expect(notice).toBeDefined();
    expect(notice.ctx.session_id).toBe(newId);
  });

  it("a HEALTHY resume (child emits a frame) does NOT trigger recovery", async () => {
    const { id } = await primeDormantWithTranscript();

    const p = mod.writeUserTurn(id, "carry on");
    await flush();
    expect(shared.children).toHaveLength(2);
    const resumed = shared.children[1];

    // The resume takes: claude emits a frame. Use a swapped id so the post-write
    // waitForSwap resolves promptly instead of waiting out its timeout.
    resumed.stdout.pushLine({ type: "system", session_id: "resumed-live-id" });
    const res = await p;

    // No recovery spawn — still just the original + resumed child.
    expect(shared.children).toHaveLength(2);
    expect(res.sessionId).toBe("resumed-live-id");
    expect(mod.getActiveSession(id)?.sessionId).toBe("resumed-live-id");
    // No "couldn't resume" notice was emitted.
    const notice = ingestEventLineMock.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => typeof e?.ctx?.last_assistant_message === "string"
        && e.ctx.last_assistant_message.includes("Couldn't resume"));
    expect(notice).toBeUndefined();
  });
});

describe("close handler: lifecycle on subprocess exit", () => {
  it("marks a clean (code 0) exit as dormant — a between-turns idle session, not ended", async () => {
    const events: any[] = [];
    mod.activeSessionsBus.on("change", (p) => events.push(p));
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-exit0" });
    await flush();
    shared.children[0].emit("close", 0);
    await flush();
    expect(mod.getActiveSession("real-exit0")?.status).toBe("dormant");
    expect(events.find((e) => e.sessionId === "real-exit0" && e.status === "dormant")).toBeDefined();
  });

  it("marks a non-zero exit as ended", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-exit1" });
    await flush();
    shared.children[0].emit("close", 1);
    await flush();
    expect(mod.getActiveSession("real-exit1")?.status).toBe("ended");
  });
});

describe("displayName seeding", () => {
  it("seeds a haiku-style displayName on create when no name is given", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const name = mod.getActiveSession(sessionId)?.displayName;
    expect(name).toBeTruthy();
    // adjective-gerund-surname, all lowercase, dash-separated, three parts.
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  it("uses the user-provided name verbatim when given", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", name: "my-thing" });
    expect(mod.getActiveSession(sessionId)?.displayName).toBe("my-thing");
  });

  it("does NOT overwrite displayName from the first user prompt", async () => {
    // The previous build auto-renamed sessions from their first prompt's
    // text. That made names jump around on revive and turned every session
    // into a slug of its opening message. Now the haiku-name set at create
    // time survives until the user explicitly renames.
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-name" });
    await flush();

    const before = mod.getActiveSession("real-name")?.displayName;
    expect(before).toBeTruthy();

    await mod.writeUserTurn(
      "real-name",
      "Reorganise the project tree to use module-per-feature layout",
    );

    expect(mod.getActiveSession("real-name")?.displayName).toBe(before);
  });
});

describe("workspace transcript migration", () => {
  it("moves *.jsonl from the legacy -workspace project dir into -home-agent-workspace at boot", async () => {
    const fsReal = await import("node:fs");
    const renameSync = fsReal.renameSync as unknown as ReturnType<typeof vi.fn>;
    const readdirSync = fsReal.readdirSync as unknown as ReturnType<typeof vi.fn>;
    renameSync.mockClear();

    // Checkpoint exists; the legacy project dir exists; destination jsonls
    // don't (so they get moved). Everything else: not found.
    fsMock.existsReturnValue = (p: string) => {
      if (p.endsWith("active-sessions.json")) return true;
      if (p.endsWith("/-workspace")) return true;     // old project dir
      if (p.endsWith(".jsonl")) return false;          // dst not present yet
      return false;
    };
    fsMock.readFileReturnValue = makeCheckpoint("sess-mig", "/workspace");
    // Old project dir holds one transcript + one non-jsonl that must be skipped.
    readdirSync.mockReturnValue(["sess-mig.jsonl", "notes.txt"] as any);

    mod.bootActiveSessions();

    const calls = renameSync.mock.calls.map((c) => [String(c[0]), String(c[1])]);
    const moved = calls.find(([src]) => src.endsWith("/-workspace/sess-mig.jsonl"));
    expect(moved).toBeDefined();
    expect(moved![1]).toContain("/-home-agent-workspace/sess-mig.jsonl");
    // The non-jsonl file is never moved.
    expect(calls.some(([src]) => src.endsWith("notes.txt"))).toBe(false);

    readdirSync.mockReturnValue([] as any);
  });
});

describe("endSession", () => {
  it("removes the slot from the registry and emits a status=ended change event", async () => {
    const events: any[] = [];
    mod.activeSessionsBus.on("change", (p) => events.push(p));

    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-end" });
    await flush();
    expect(mod.getActiveSession("real-end")).toBeDefined();

    // Fake a graceful close (no real child kill in tests).
    const child = shared.children[0];
    child.killed = true;
    const endPromise = mod.endSession("real-end");
    child.emit("close", 0);
    await endPromise;

    expect(mod.getActiveSession("real-end")).toBeUndefined();
    expect(mod.getActiveSession(sessionId)).toBeUndefined();
    const endEvt = events.find((e) => e.status === "ended" && e.sessionId === "real-end");
    expect(endEvt).toBeDefined();
  });

  it("is a no-op for an unknown sessionId", async () => {
    await expect(mod.endSession("never-spawned")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dormant session revival + cwd policy re-application
// ---------------------------------------------------------------------------

/**
 * Build a minimal checkpoint JSON string for a single dormant session.
 */
function makeCheckpoint(
  sessionId: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    sessions: [
      {
        sessionId,
        runId: null,
        label: "test session",
        displayName: null,
        cwd,
        via: "new-conversation",
        startedAt: Date.now() - 1000,
        lastSeenAt: Date.now() - 500,
        ...extra,
      },
    ],
  });
}

/**
 * Configure the fs mock so bootActiveSessions will load the given checkpoint.
 * Must be called BEFORE importing the module (i.e. before bootActiveSessions runs).
 */
function stubCheckpoint(sessionId: string, cwd: string) {
  const payload = makeCheckpoint(sessionId, cwd);
  fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
  fsMock.readFileReturnValue = payload;
}

describe("dormant session revival: cwd policy re-application", () => {
  let tmpAllowedRoot: string;
  let tmpOtherRoot: string;

  beforeEach(() => {
    // Use the real fs functions (captured before the mock overrides them) so
    // that directories we create actually exist on disk. The mocked mkdirSync
    // is a vi.fn() no-op and would prevent realpathSync.native from resolving
    // the paths, causing isCwdAllowed to incorrectly reject them.
    const real = fsMock.realFs!;
    tmpAllowedRoot = real.mkdtempSync(join(tmpdir(), "revival-allowed-"));
    tmpOtherRoot = real.mkdtempSync(join(tmpdir(), "revival-other-"));
  });

  afterEach(() => {
    const real = fsMock.realFs!;
    try { real.rmSync(tmpAllowedRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { real.rmSync(tmpOtherRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("prunes a dormant session whose stored cwd no longer satisfies current policy", async () => {
    // Session cwd is under tmpOtherRoot; allowed roots are set to tmpAllowedRoot only.
    const sessionCwd = join(tmpOtherRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    stubCheckpoint("dormant-bad-cwd", sessionCwd);
    process.env.HOOP_CWD_ROOTS = tmpAllowedRoot;

    // bootActiveSessions hasn't been called yet (outer beforeEach only imports the module).
    mod.bootActiveSessions();

    // Session should have been pruned at boot.
    expect(mod.getActiveSession("dormant-bad-cwd")).toBeUndefined();
    expect(mod.listActiveSessions()).toHaveLength(0);
  });

  it("loads a dormant session whose cwd still satisfies current policy", async () => {
    // Session cwd is under tmpAllowedRoot.
    const sessionCwd = join(tmpAllowedRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    stubCheckpoint("dormant-good-cwd", sessionCwd);
    process.env.HOOP_CWD_ROOTS = tmpAllowedRoot;

    mod.bootActiveSessions();

    const entry = mod.getActiveSession("dormant-good-cwd");
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("dormant");
    expect(entry?.cwd).toBe(sessionCwd);
  });

  it("wakeSession rejects a dormant session whose cwd is outside current policy", async () => {
    // Load the session without any env restriction so it passes loadCheckpoint.
    const sessionCwd = join(tmpOtherRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    stubCheckpoint("dormant-wake-bad", sessionCwd);
    // No restriction at boot → session loads as dormant.
    mod.bootActiveSessions();

    expect(mod.getActiveSession("dormant-wake-bad")?.status).toBe("dormant");

    // Now tighten the policy AFTER boot (simulates HOOP_CWD_ROOTS being set later).
    process.env.HOOP_CWD_ROOTS = tmpAllowedRoot;

    // wakeSession should refuse to revive and prune the entry.
    await expect(mod.wakeSession("dormant-wake-bad")).rejects.toThrow(/cwd no longer allowed/);
    expect(mod.getActiveSession("dormant-wake-bad")).toBeUndefined();
  });

  it("wakeSession succeeds for a dormant session whose cwd is still within policy", async () => {
    const sessionCwd = join(tmpAllowedRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    stubCheckpoint("dormant-wake-good", sessionCwd);
    process.env.HOOP_CWD_ROOTS = tmpAllowedRoot;

    mod.bootActiveSessions();

    expect(mod.getActiveSession("dormant-wake-good")?.status).toBe("dormant");

    // wakeSession should succeed (spawns a child process).
    const meta = await mod.wakeSession("dormant-wake-good");
    expect(meta.status).toBe("alive");
    expect(meta.cwd).toBe(sessionCwd);
  });

  it("wakeSession carries cumulative totals from the dormant slot's lastStats into the new alive meta", async () => {
    // Regression: reactivation used to reset turn / token counters
    // because spawnControllable's meta started with no lastStats.
    // The fix threads lastStats through SpawnOpts.carryStats so the
    // dashboard's StatsStrip keeps its running totals across the
    // dormant→awake transition instead of ratcheting back to zero.
    const sessionCwd = join(tmpAllowedRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    const seedStats = {
      v: 1,
      model: "claude-sonnet-4-6",
      mode: "default",
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 287,
        cache_read_input_tokens: 19586,
        output_tokens: 84,
      },
      turnDurationMs: 3624,
      turnEndedAt: 1779277948396,
      totals: {
        input_tokens: 100,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 20000,
        output_tokens: 50,
        turns: 3,
      },
    };
    const payload = makeCheckpoint("dormant-carry", sessionCwd, {
      lastStats: seedStats,
    });
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = payload;
    process.env.HOOP_CWD_ROOTS = tmpAllowedRoot;

    mod.bootActiveSessions();

    // Dormant slot has the seed totals.
    const dormant = mod.getActiveSession("dormant-carry");
    expect(dormant?.lastStats?.totals?.turns).toBe(3);

    // Waking it: the new alive slot must keep them, not reset.
    const meta = await mod.wakeSession("dormant-carry");
    expect(meta.status).toBe("alive");
    expect(meta.lastStats?.totals).toEqual(seedStats.totals);
    expect(meta.lastStats?.model).toBe("claude-sonnet-4-6");
  });

  it("narrowing HOOP_CWD_ROOTS between boot cycles prunes previously-valid sessions", async () => {
    // First cycle: no restriction → session with tmpOtherRoot cwd loads fine.
    const sessionCwd = join(tmpOtherRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    stubCheckpoint("dormant-narrow", sessionCwd);
    // No restriction at first boot.
    mod.bootActiveSessions();
    expect(mod.getActiveSession("dormant-narrow")?.status).toBe("dormant");

    // Re-import for a fresh boot with tighter policy.
    vi.resetModules();
    shared.reset();
    fsMock.reset();
    process.env.HOOP_CWD_ROOTS = tmpAllowedRoot;
    stubCheckpoint("dormant-narrow", sessionCwd);
    mod = await import("./active-sessions");
    mod.bootActiveSessions();

    expect(mod.getActiveSession("dormant-narrow")).toBeUndefined();
  });
});

describe("stderr parser: auth failure detection", () => {
  it("emits activeSessionsBus.error with kind=auth when claude prints a 401", async () => {
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));
    await mod.startNewConversation({ cwd: "/x" });

    (shared.children[0].stderr as any).push("API Error: 401 Invalid Authentication", "utf-8");
    await flush();

    const auth = errors.find((e) => e.kind === "auth");
    expect(auth).toBeDefined();
    expect(auth.message).toMatch(/hoop login/i);
  });

  it("matches `claude login` recommendation text from claude itself", async () => {
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));
    await mod.startNewConversation({ cwd: "/x" });

    (shared.children[0].stderr as any).push("token rejected — please run claude login\n", "utf-8");
    await flush();

    expect(errors.some((e) => e.kind === "auth")).toBe(true);
  });

  it("does NOT fire when stderr only mentions a successful refresh", async () => {
    // Regression guard: claude logs "token refreshed" during a healthy
    // background rotation. That string contains "token" + "refresh" but
    // it's the OPPOSITE of an auth failure — must not trigger the banner.
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));
    await mod.startNewConversation({ cwd: "/x" });

    (shared.children[0].stderr as any).push("oauth token refreshed (expires in 8h)\n", "utf-8");
    await flush();

    expect(errors.filter((e) => e.kind === "auth")).toHaveLength(0);
  });

  it("does NOT fire for unrelated stderr noise (sandbox debug logs, etc.)", async () => {
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));
    await mod.startNewConversation({ cwd: "/x" });

    (shared.children[0].stderr as any).push("debug: spawned child pid=12345\n", "utf-8");
    (shared.children[0].stderr as any).push("warning: tool Bash took 4.2s\n", "utf-8");
    await flush();

    expect(errors.filter((e) => e.kind === "auth")).toHaveLength(0);
  });

  it("fires at most once per slot — repeat 401 chunks don't flood the bus", async () => {
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));
    await mod.startNewConversation({ cwd: "/x" });

    // Three consecutive failure chunks (e.g. claude retried 3 times).
    (shared.children[0].stderr as any).push("API Error: 401 Unauthorized\n", "utf-8");
    (shared.children[0].stderr as any).push("API Error: 401 Unauthorized\n", "utf-8");
    (shared.children[0].stderr as any).push("API Error: 401 Unauthorized\n", "utf-8");
    await flush();

    expect(errors.filter((e) => e.kind === "auth")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Plan-review durability: a synthetic plan review awaiting the human's decision
// must survive a sandbox restart (checkpoint) and a dormant→awake revive, and
// must NOT be idle-reaped out from under the user. Regression for session
// 887db520, where a restart between plan submission and the click dropped the
// review (checkpoint omitted it; revive rebuilt an empty slot).
// ---------------------------------------------------------------------------
describe("plan-review persistence (checkpoint + revive + reap)", () => {
  const TTL = 30 * 60 * 1000; // default HOOP_SESSION_IDLE_TTL_MS

  // Drive a live session to a submitted plan review (the deterministic path: a
  // /plan turn where the model calls submit_plan). Ends the turn so turnActive is
  // false — so the reap test exercises the pending-review exemption, not the
  // turn-in-flight guard. Leaves the session alive with exactly one synthetic
  // pending review.
  async function primePlan(sid: string) {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    await mod.writeUserTurn(sid, "/plan build a widget");
    mod.createPermissionRequest({ sessionId: sid, toolName: "mcp__plugin_hoop_tools__submit_plan", input: { plan: "## Plan\n1. do a\n2. do b" }, toolUseId: `tu-${sid}` });
    (child.stdout as any).pushLine({ type: "result", session_id: sid, result: "Plan submitted for review.", usage: { input_tokens: 5, output_tokens: 5 } });
    await flush();
    return child;
  }

  const syntheticReview = (requestId: string, plan: string) => ({
    requestId, toolUseId: null, toolName: "ExitPlanMode", input: { plan },
    decisionReason: null, receivedAt: Date.now(), author: "host", shareId: null, synthetic: true,
  });

  it("saveCheckpoint persists the synthetic plan review (mirrors lastStats)", async () => {
    const sid = "persist-review";
    await primePlan(sid);
    expect(mod.getPendingRequests(sid).filter((r) => r.synthetic)).toHaveLength(1);

    // The result-frame saveCheckpoint ran BEFORE the review was pushed; trigger a
    // fresh checkpoint (renameSession does) so the review makes it to disk.
    const fsReal = await import("node:fs");
    const writeFileSync = fsReal.writeFileSync as unknown as ReturnType<typeof vi.fn>;
    writeFileSync.mockClear();
    mod.renameSession(sid, "reviewed session");

    const call = [...writeFileSync.mock.calls].reverse().find((c) => String(c[0]).endsWith("active-sessions.json.tmp"));
    expect(call).toBeDefined();
    const body = JSON.parse(String(call![1]));
    const entry = body.sessions.find((s: any) => s.sessionId === sid);
    expect(entry.pendingReviews).toHaveLength(1);
    expect(entry.pendingReviews[0].synthetic).toBe(true);
    expect(entry.pendingReviews[0].input.plan).toContain("do a");
  });

  it("loadCheckpoint restores the review into the dormant slot (survives restart)", async () => {
    const sid = "restore-review";
    // loadCheckpoint re-applies cwd policy (realpathSync) — use a path that
    // actually resolves. No HOOP_CWD_ROOTS set → any existing path is allowed.
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = makeCheckpoint(sid, tmpdir(), {
      pendingReviews: [syntheticReview("rev-restore", "1. persisted step")],
    });
    mod.bootActiveSessions();

    expect(mod.getActiveSession(sid)?.status).toBe("dormant");
    const pending = mod.getPendingRequests(sid);
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("ExitPlanMode");
    expect(pending[0].synthetic).toBe(true);
    expect((pending[0].input as any).plan).toContain("persisted step");
  });

  it("loadCheckpoint defensively drops a non-synthetic entry smuggled into pendingReviews", async () => {
    const sid = "smuggled-review";
    const real = { requestId: "not-a-review", toolUseId: "tu", toolName: "Bash", input: { command: "rm -rf /" }, decisionReason: null, receivedAt: Date.now(), author: "host", shareId: null };
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = makeCheckpoint(sid, tmpdir(), { pendingReviews: [real] });
    mod.bootActiveSessions();

    // No hook waits on this fake ask; it must not resurface as a pending card.
    expect(mod.getPendingRequests(sid)).toHaveLength(0);
  });

  it("wakeSession carries the review into the revived alive slot (survives revive)", async () => {
    const sid = "carry-review";
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = makeCheckpoint(sid, tmpdir(), {
      pendingReviews: [syntheticReview("rev-carry", "1. carried step")],
    });
    mod.bootActiveSessions();
    expect(mod.getActiveSession(sid)?.status).toBe("dormant");

    const meta = await mod.wakeSession(sid);
    expect(meta.status).toBe("alive");
    // The review must still be there on the fresh (alive) slot — the old dormant
    // slot (and its pendingRequests) was discarded when the new one registered.
    const pending = mod.getPendingRequests(sid);
    expect(pending).toHaveLength(1);
    expect(pending[0].synthetic).toBe(true);
    expect((pending[0].input as any).plan).toContain("carried step");
  });

  it("sweepIdleSessions does NOT reap a session with a pending plan review", async () => {
    const sid = "no-reap-review";
    const child = await primePlan(sid);
    expect(mod.getPendingRequests(sid).filter((r) => r.synthetic)).toHaveLength(1);

    // Well past the TTL, but a plan awaiting approval isn't "idle".
    const lastSeen = mod.getActiveSession(sid)!.lastSeenAt;
    expect(mod.sweepIdleSessions(lastSeen + TTL * 10)).not.toContain(sid);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
