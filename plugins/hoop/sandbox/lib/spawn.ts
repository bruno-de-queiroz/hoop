import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { discoverInstalledPluginDirs } from "./plugin-paths";
import { listSkills } from "./skills";
import { listSlashCommands } from "./commands";

/**
 * Spawns `claude -p '<prompt>'` as a non-interactive subprocess. The dashboard
 * runs inside a Docker container with @anthropic-ai/claude-code installed and
 * the host's ~/.claude bind-mounted, so the spawn inherits the user's
 * authenticated session without re-auth.
 *
 * v0.1 always starts a NEW Claude session (no injection into existing ones).
 * After spawn we poll for the new session file ~/.claude/sessions/<pid>.json
 * to learn its sessionId, then publish a (sessionId -> runMeta) mapping so
 * SessionsPanel / ActiveSessionPanel can label and auto-switch to it.
 */

export interface RunChunk {
  runId: string;
  skill: string;
  kind: "stdout" | "stderr";
  data: string;
}

export interface RunEnd {
  runId: string;
  skill: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface RunMeta {
  runId: string;
  skill: string;
  args: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  pid?: number;
  sessionId?: string;
  output: string;        // accumulated stdout (+ stderr inlined)
  outputBytes: number;
}

const MAX_OUTPUT_BYTES = 64 * 1024; // keep last 64KB of output in memory per run

// ---------- Resource caps ----------
// Default cap: 10 concurrent runs. Configurable via HOOP_MAX_CONCURRENT_RUNS.
const MAX_CONCURRENT_RUNS = parseInt(process.env.HOOP_MAX_CONCURRENT_RUNS ?? "", 10) || 10;
// Default cap: 500 run-meta history entries. Configurable via HOOP_RUN_META_HISTORY.
const RUN_META_HISTORY = parseInt(process.env.HOOP_RUN_META_HISTORY ?? "", 10) || 500;

/** Thrown when the concurrent-run cap is exceeded. Translate to 429 in server.ts. */
export class TooManyConcurrentRunsError extends Error {
  constructor() {
    super("max concurrent runs");
    this.name = "TooManyConcurrentRunsError";
  }
}

export const runsBus = new EventEmitter();
runsBus.setMaxListeners(100);

const activeRuns = new Map<string, { meta: RunMeta; child: ChildProcess }>();
const sessionToRun = new Map<string, string>(); // sessionId -> runId
const runMetas = new Map<string, RunMeta>();    // runId -> meta (lives past close)

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_:/-]{0,127}$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

export function listRuns(): RunMeta[] {
  return Array.from(runMetas.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export function getRunForSession(sessionId: string): RunMeta | undefined {
  const runId = sessionToRun.get(sessionId);
  return runId ? runMetas.get(runId) : undefined;
}

export function getRun(runId: string): RunMeta | undefined {
  return runMetas.get(runId);
}

export function abortRun(runId: string): boolean {
  const r = activeRuns.get(runId);
  if (!r) return false;
  r.child.kill("SIGTERM");
  return true;
}

function skillIsKnown(name: string): boolean {
  // Strip a leading slash if present (we accept both "/foo" and "foo" calls).
  const raw = name.startsWith("/") ? name.slice(1) : name;
  for (const s of listSkills()) {
    if (s.name === raw) return true;
  }
  for (const c of listSlashCommands()) {
    if (c.name === raw) return true;
  }
  return false;
}

function evictRunMetas() {
  while (runMetas.size > RUN_META_HISTORY) {
    const firstKey = runMetas.keys().next().value;
    if (firstKey === undefined) break;
    runMetas.delete(firstKey);
  }
}

export function startSkillRun(skill: string, args?: string): { runId: string } {
  if (!isValidSkillName(skill)) {
    throw new Error(`invalid skill name: ${skill}`);
  }
  if (!skillIsKnown(skill)) {
    throw new Error(`unknown skill or command: ${skill}`);
  }
  if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
    throw new TooManyConcurrentRunsError();
  }

  const runId = randomUUID();
  const startedAt = Date.now();
  const cwd = process.env.HOOP_RUN_CWD || homedir() || "/root";
  const sanitizedArgs = (args ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();

  // Slash command vs skill (see prior comment for rationale).
  let prompt: string;
  if (skill.startsWith("/")) {
    prompt = sanitizedArgs ? `${skill} ${sanitizedArgs}` : skill;
  } else if (sanitizedArgs.startsWith("/")) {
    prompt = sanitizedArgs;
  } else {
    const baseName = skill.includes(":") ? skill.slice(skill.indexOf(":") + 1) : skill;
    prompt = sanitizedArgs
      ? `Use the ${baseName} skill: ${sanitizedArgs}`
      : `Use the ${baseName} skill.`;
  }

  // `claude -p` (print mode) does NOT auto-load directory-source marketplace
  // plugins, so our hooks/hoop never get a chance to fire and we miss
  // the spawn's events. Workaround: pass --plugin-dir for every installed
  // plugin so claude loads them explicitly for this subprocess.
  const pluginDirs = discoverInstalledPluginDirs();
  const claudeArgs: string[] = [];
  for (const dir of pluginDirs) {
    claudeArgs.push("--plugin-dir", dir);
  }
  claudeArgs.push("-p", prompt);

  const child = spawn("claude", claudeArgs, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const meta: RunMeta = {
    runId,
    skill,
    args: sanitizedArgs,
    startedAt,
    pid: child.pid,
    output: "",
    outputBytes: 0,
  };
  runMetas.set(runId, meta);
  evictRunMetas();
  activeRuns.set(runId, { meta, child });
  runsBus.emit("start", { runId, skill, startedAt, pid: child.pid });

  // Poll for the new session file Claude writes at ~/.claude/sessions/<pid>.json.
  // Once parsed, register sessionId -> runId so the dashboard can label and
  // auto-focus the session.
  if (child.pid) {
    void linkSession(child.pid, runId);
  }

  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");

  child.stdout?.on("data", (data: string) => {
    appendOutput(meta, data);
    runsBus.emit("chunk", { runId, skill, kind: "stdout", data } satisfies RunChunk);
  });
  child.stderr?.on("data", (data: string) => {
    appendOutput(meta, data);
    runsBus.emit("chunk", { runId, skill, kind: "stderr", data } satisfies RunChunk);
  });

  const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (!activeRuns.has(runId)) return;
    activeRuns.delete(runId);
    meta.endedAt = Date.now();
    meta.exitCode = exitCode;
    runsBus.emit("end", {
      runId, skill, exitCode, signal,
      durationMs: meta.endedAt - startedAt,
    } satisfies RunEnd);
  };

  child.on("close", (code, signal) => finish(code, signal));
  child.on("error", (err) => {
    appendOutput(meta, `spawn failed: ${err.message}\n`);
    runsBus.emit("chunk", { runId, skill, kind: "stderr", data: `spawn failed: ${err.message}\n` } satisfies RunChunk);
    finish(null, null);
  });

  return { runId };
}

function appendOutput(meta: RunMeta, data: string) {
  meta.output += data;
  meta.outputBytes += Buffer.byteLength(data, "utf-8");
  // Trim from the front if we exceed the cap — keep the tail, which is what
  // matters most for "what did the spawn say at the end".
  if (meta.output.length > MAX_OUTPUT_BYTES) {
    const overflow = meta.output.length - MAX_OUTPUT_BYTES;
    meta.output = "…[truncated]…\n" + meta.output.slice(overflow);
  }
}

/**
 * Polls ~/.claude/sessions/<pid>.json for up to ~3s after spawn. Once present,
 * parses out sessionId and registers it. fs.watch on the sessions dir would
 * be more elegant, but the polling cost is trivial and keeps spawn.ts
 * self-contained (no dep on sessions.ts).
 */
async function linkSession(pid: number, runId: string) {
  const file = join(homedir(), ".claude", "sessions", `${pid}.json`);
  for (let i = 0; i < 20; i++) {
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf-8"));
        const sid = typeof data.sessionId === "string" ? data.sessionId : null;
        if (sid) {
          sessionToRun.set(sid, runId);
          const meta = runMetas.get(runId);
          if (meta) meta.sessionId = sid;
          runsBus.emit("link", { runId, sessionId: sid });
          return;
        }
      } catch { /* try again next tick */ }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}
