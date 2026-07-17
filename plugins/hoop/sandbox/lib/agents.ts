import { getDb } from "./db";
import { listSessions } from "./sessions";

export interface AgentRun {
  id: number;            // events.id of the PreToolUse(Agent) event
  sessionId: string | null;
  subagentType: string | null;
  model: string | null;  // best-effort extraction from tool_response
  prompt: string | null;
  description: string | null;  // short description from Task input
  startTs: string;
  endTs: string | null;
  durationMs: number | null;
  toolUseCount: number | null;  // number of tool calls the sub-agent made
  result: string | null;
  parentAgentId: number | null;
  // "running"      — Pre fired, Post hasn't, session is still alive.
  // "completed"    — Post fired normally.
  // "interrupted"  — Pre fired, Post never fired, and the parent session has
  //                  no live process or is dormant/ended. The agent will never
  //                  finish; we surface it so it's not stuck pulsing forever.
  status: "running" | "completed" | "interrupted";
}

const STUCK_GRACE_MS = 5 * 60_000;

interface StackFrame {
  agentId: number;
  preTs: string;
  subagentType: string | null;
  prompt: string | null;
  parentAgentId: number | null;
}

/**
 * Reconstructs sub-agent runs by walking the events table in id order. A
 * PreToolUse(Agent) opens a frame; the matching PostToolUse(Agent) closes it.
 * Frames are stacked per session, so nested agents (Agent calls Agent) keep the
 * right parent pointer.
 *
 * Cost: scans all Agent rows in the DB. For typical workloads (a few hundred
 * sub-agents) this is fine. If the table grows large, we'd add a materialized
 * agent_runs table updated at ingest time (Phase 8+).
 *
 * Cached: the client refetches /api/agents on EVERY Task/Agent event, and each
 * uncached call full-scans the events table + JSON.parses per row + calls
 * listSessions(). We memoize the full computed array, valid while the max
 * Task/Agent event id is unchanged AND the cache is younger than
 * AGENT_RUNS_CACHE_TTL_MS — the age bound keeps stuck-agent promotion (which
 * depends on wall-clock + the alive-set) prompt even when no new events arrive.
 */
const AGENT_RUNS_CACHE_TTL_MS = 2_000;
let _agentRunsCache: { maxId: number; at: number; value: AgentRun[] } | null = null;

export function listAgentRuns(limit = 50): AgentRun[] {
  const db = getDb();
  // Cheap freshness probe: the max Task/Agent event id. When it (and the age)
  // are unchanged we serve the memoized array. `.get()` is the real
  // better-sqlite3 scalar API; if it's unavailable (e.g. a unit-test db stub)
  // we fall back to maxId = -1, which disables the cache entirely (always
  // recompute) so tests stay isolated and never see a stale memo.
  let maxId = -1;
  try {
    const row = db
      .prepare(`SELECT MAX(id) AS m FROM events WHERE tool_name IN ('Task','Agent')`)
      .get() as { m: number | null } | undefined;
    maxId = row?.m ?? 0;
  } catch {
    maxId = -1;
  }
  const now = Date.now();
  if (
    maxId >= 0 &&
    _agentRunsCache &&
    _agentRunsCache.maxId === maxId &&
    now - _agentRunsCache.at < AGENT_RUNS_CACHE_TTL_MS
  ) {
    return _agentRunsCache.value.slice(0, limit);
  }
  const value = computeAgentRuns();
  if (maxId >= 0) _agentRunsCache = { maxId, at: now, value };
  return value.slice(0, limit);
}

/** Full sorted agent-run list (newest first), before any limit slice. */
function computeAgentRuns(): AgentRun[] {
  const db = getDb();
  // Claude Code's sub-agent invocation tool is named `Task` (not `Agent`).
  // We match both to stay forward-compatible.
  const rows = db
    .prepare(
      `SELECT id, ts, session_id, hook_type, payload
       FROM events
       WHERE tool_name IN ('Task', 'Agent')
       ORDER BY id ASC`
    )
    .all() as Array<{ id: number; ts: string; session_id: string | null; hook_type: string; payload: string }>;

  const sessionStacks: Map<string, StackFrame[]> = new Map();
  const runsById: Map<number, AgentRun> = new Map();

  for (const row of rows) {
    const session = row.session_id ?? "(none)";
    let stack = sessionStacks.get(session);
    if (!stack) {
      stack = [];
      sessionStacks.set(session, stack);
    }
    if (row.hook_type === "PreToolUse") {
      let subagentType: string | null = null;
      let prompt: string | null = null;
      let description: string | null = null;
      try {
        const event = JSON.parse(row.payload);
        const input = event.ctx?.tool_input;
        if (input && typeof input === "object") {
          subagentType = typeof input.subagent_type === "string" ? input.subagent_type : null;
          prompt = typeof input.prompt === "string" ? input.prompt : null;
          description = typeof input.description === "string" ? input.description : null;
        }
      } catch {}
      const parent = stack.length > 0 ? stack[stack.length - 1].agentId : null;
      stack.push({ agentId: row.id, preTs: row.ts, subagentType, prompt, parentAgentId: parent });
      runsById.set(row.id, {
        id: row.id,
        sessionId: row.session_id,
        subagentType,
        model: null,
        prompt,
        description,
        startTs: row.ts,
        endTs: null,
        durationMs: null,
        toolUseCount: null,
        result: null,
        parentAgentId: parent,
        status: "running",
      });
    } else if (row.hook_type === "PostToolUse") {
      const top = stack.pop();
      if (!top) continue;
      const run = runsById.get(top.agentId);
      if (!run) continue;
      run.endTs = row.ts;
      run.status = "completed";
      run.durationMs = Date.parse(row.ts) - Date.parse(top.preTs);
      try {
        const event = JSON.parse(row.payload);
        const r = event.ctx?.tool_response ?? event.ctx?.tool_result ?? null;
        if (r != null) {
          run.result = extractAgentText(r).slice(0, 4000);
          run.model = extractModel(r);
          run.toolUseCount = extractToolUseCount(r);
        }
      } catch {}
    }
  }

  // Promote stuck "running" agents to "interrupted" when their parent session
  // is no longer alive. Without this, sub-agents from crashed/exited sessions
  // pulse forever in the panel even though they cannot possibly finish.
  const aliveSessions = new Set<string>();
  try {
    for (const s of listSessions()) {
      if (!s.sessionId) continue;
      // Alive means: ambient cli/SDK session with no lifecycle decoration,
      // or an active-session entry that's currently alive.
      if (!s.lifecycle || s.lifecycle === "alive") aliveSessions.add(s.sessionId);
    }
  } catch { /* if sessions can't be read, fall back to leaving status untouched */ }

  const now = Date.now();
  for (const run of runsById.values()) {
    if (run.status !== "running") continue;
    const sid = run.sessionId;
    const sessionDead = !sid || !aliveSessions.has(sid);
    const startMs = Date.parse(run.startTs);
    const elapsed = now - startMs;
    if (sessionDead && elapsed > STUCK_GRACE_MS) {
      run.status = "interrupted";
      run.durationMs = elapsed;
    }
  }

  return Array.from(runsById.values()).sort((a, b) => b.id - a.id);
}

export function getAgentDetail(id: number): AgentRun | null {
  const runs = listAgentRuns(10_000);
  return runs.find((r) => r.id === id) ?? null;
}

/**
 * Best-effort: pull the model id (e.g. "claude-haiku-4-5", "claude-sonnet-4-6")
 * out of a Task tool_response. The response shape isn't strictly documented;
 * we check the spots Claude Code has historically put it.
 */
function extractModel(v: unknown): string | null {
  if (v == null || typeof v !== "object") return null;
  const obj = v as Record<string, any>;
  if (typeof obj.model === "string") return obj.model;
  if (obj.usage && typeof obj.usage.model === "string") return obj.usage.model;
  if (obj.metadata && typeof obj.metadata.model === "string") return obj.metadata.model;
  // Walk nested message objects (sometimes wrapped under .response or .message)
  for (const key of ["response", "message", "result"]) {
    const inner = obj[key];
    if (inner && typeof inner === "object" && typeof inner.model === "string") return inner.model;
  }
  return null;
}

/**
 * Best-effort tool-use count from the Task response. The TUI shows this in
 * the "Done (N tool uses · ...)" summary; we surface it the same way.
 */
function extractToolUseCount(v: unknown): number | null {
  if (v == null || typeof v !== "object") return null;
  const obj = v as Record<string, any>;
  if (typeof obj.tool_uses === "number") return obj.tool_uses;
  if (typeof obj.toolUseCount === "number") return obj.toolUseCount;
  if (obj.usage && typeof obj.usage.tool_use_count === "number") return obj.usage.tool_use_count;
  return null;
}

/**
 * Sub-agent tool_response is usually a wrapped object like
 *   { content: [{ type: "text", text: "..." }], ... }
 * or { text: "..." }. Pull the text out instead of dumping JSON so the panel
 * shows the agent's actual answer rather than the serialized envelope.
 */
function extractAgentText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  const obj = v as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.output === "string") return obj.output;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.result === "string") return obj.result;
  if (Array.isArray(obj.content)) {
    const texts = (obj.content as unknown[])
      .map((c) => {
        if (typeof c === "string") return c;
        const item = c as Record<string, unknown>;
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
        return "";
      })
      .filter((s) => s.length > 0);
    if (texts.length) return texts.join("\n");
  }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
