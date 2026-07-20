import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { CLAUDE_SESSIONS_DIR } from "./paths";
import { getRunForSession } from "./spawn";
import { getActiveSession, listActiveSessions, bootActiveSessions, aliasesFor, isResumeInFlight } from "./active-sessions";

export interface SessionInfo {
  id: string;           // filename without .json (the PID)
  path: string;
  mtime: string;        // ISO timestamp
  size: number;
  // Parsed from the JSON body — present on healthy session files.
  sessionId?: string;   // UUID used in event.session_id (the one to filter on)
  pid?: number;
  cwd?: string;
  entrypoint?: string;  // "cli" (interactive) | "sdk-cli" (background SDK) | ...
  kind?: string;        // "interactive" | ...
  version?: string;
  status?: string;      // "busy" | "idle" | undefined
  startedAt?: number;
  updatedAt?: number;
  // Decoration from spawn.ts when this session was started by a dashboard skill run.
  skill?: string;
  skillArgs?: string;
  runId?: string;
  // Decoration from active-sessions.ts when this session is dashboard-controllable.
  controllable?: boolean;
  lifecycle?: "alive" | "dormant" | "ended" | "expired" | "error";
  // True while a model turn is in flight (from the active-session registry).
  // Drives the "model is thinking" indicator for all viewers, including late
  // joiners who read it off this row rather than the live event stream.
  turnActive?: boolean;
  displayName?: string | null;  // user-set name or first-prompt auto-name
  // Historical ids the same conversation has been known by. Populated when
  // `claude --resume` minted a new internal session_id under the hood, or
  // when a pending-X spawn id was swapped to a canonical UUID. The
  // dashboard uses this on load to widen its SSE event filter so events
  // under any historical id still join the transcript for the URL the
  // user is on. Absent when no aliases exist.
  aliases?: string[];
  // Last-turn telemetry (model, mode, usage, duration). Surfaced from the
  // active-session registry; absent until the first result frame.
  lastStats?: {
    v: 1;
    model?: string | null;
    mode?: string | null;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
    turnDurationMs?: number;
    turnEndedAt?: number;
  };
}

/**
 * Push-based session change notifications. Subscribers receive a "change" event
 * whenever a session file is created, modified, or deleted in
 * ~/.claude/sessions/. The /api/stream SSE handler relays these to browsers.
 */
export const sessionsBus = new EventEmitter();
sessionsBus.setMaxListeners(100);

const _cache: Map<string, SessionInfo> = new Map();
let _watcher: FSWatcher | null = null;
let _started = false;

export function readSessionMeta(file: string): SessionInfo | null {
  try {
    const stat = statSync(file);
    const id = file.split("/").pop()!.replace(/\.json$/, "");
    const info: SessionInfo = {
      id,
      path: file,
      mtime: stat.mtime.toISOString(),
      size: stat.size,
    };
    try {
      const body = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
      info.sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
      info.pid = typeof body.pid === "number" ? body.pid : undefined;
      info.cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      info.entrypoint = typeof body.entrypoint === "string" ? body.entrypoint : undefined;
      info.kind = typeof body.kind === "string" ? body.kind : undefined;
      info.version = typeof body.version === "string" ? body.version : undefined;
      info.status = typeof body.status === "string" ? body.status : undefined;
      info.startedAt = typeof body.startedAt === "number" ? body.startedAt : undefined;
      info.updatedAt = typeof body.updatedAt === "number" ? body.updatedAt : undefined;
    } catch {
      // Partial / corrupt JSON — surface the file but without parsed fields.
    }
    // Prune stale sdk-cli files whose PID is dead. Each dashboard-spawned
    // claude writes one of these, and they linger on container restart /
    // ungraceful exit, polluting the sidebar with phantom entries that have
    // no registry slot (so they render as read-only). Only sdk-cli is safe to
    // check: cli (the user's TUI) lives in another container and its PID
    // namespace is inaccessible from here.
    if (info.entrypoint === "sdk-cli" && typeof info.pid === "number" && !isPidAlive(info.pid)) {
      try { unlinkSync(file); } catch { /* ignore */ }
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 is a permission probe: returns normally if the process exists
    // and we can signal it, throws ESRCH if the PID doesn't exist, EPERM if
    // it exists but we lack permission (still alive).
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function refreshAll() {
  if (!existsSync(CLAUDE_SESSIONS_DIR)) return;
  _cache.clear();
  for (const name of readdirSync(CLAUDE_SESSIONS_DIR)) {
    if (!name.endsWith(".json")) continue;
    const info = readSessionMeta(join(CLAUDE_SESSIONS_DIR, name));
    if (info) _cache.set(info.id, info);
  }
}

export function startSessionsWatcher() {
  if (_started) return;
  _started = true;
  if (!existsSync(CLAUDE_SESSIONS_DIR)) {
    // Directory may not exist yet on a fresh install; nothing to watch.
    return;
  }
  refreshAll();
  // fs.watch is push-based; no polling.
  _watcher = watch(CLAUDE_SESSIONS_DIR, (_eventType, filename) => {
    if (!filename || !filename.toString().endsWith(".json")) return;
    const file = join(CLAUDE_SESSIONS_DIR, filename.toString());
    if (!existsSync(file)) {
      _cache.delete(filename.toString().replace(/\.json$/, ""));
    } else {
      const info = readSessionMeta(file);
      if (info) _cache.set(info.id, info);
    }
    sessionsBus.emit("change");
  });
}

export function stopSessionsWatcher() {
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
  _started = false;
}

export function listSessions(): SessionInfo[] {
  // Ensure the active-sessions registry has loaded its checkpoint. This is
  // idempotent and protects us from module-bundling quirks where the
  // instrumentation hook ran the boot in a different module instance.
  bootActiveSessions();

  // Decorate with skill metadata + active-sessions controllability at read
  // time. Two `<pid>.json` files can carry the same sessionId (e.g. the
  // user's TUI plus a dashboard `--resume` of that conversation), so we
  // dedupe by sessionId and keep the freshest entry (largest mtime). Files
  // without a sessionId fall back to the pid-keyed bucket.
  const dedupe = new Map<string, SessionInfo>();
  for (const info of _cache.values()) {
    const key = info.sessionId ?? `pid:${info.id}`;
    const existing = dedupe.get(key);
    if (existing) {
      const a = Date.parse(info.mtime);
      const b = Date.parse(existing.mtime);
      if (!(a > b)) continue;
    }
    // Suppress the transient orphan row produced mid-resume. When
    // `claude --resume` mints a new session_id it writes a fresh
    // <newId>.jsonl before our stdout parser swaps the slot, so for ~200ms
    // this cache entry has no registry decoration and would render with a
    // null displayName (sidebar/header fall back to the cwd basename or an
    // id slice — the visible name flicker). A dashboard-spawned session
    // (entrypoint "sdk-cli") ALWAYS gets a registry slot once its id
    // settles, so an undecorated sdk-cli row during an in-flight resume in
    // this cwd is necessarily that orphan. Skip it; the decorated row for
    // the same conversation is still emitted and keeps the real name.
    if (
      info.sessionId &&
      info.entrypoint === "sdk-cli" &&
      !getActiveSession(info.sessionId) &&
      isResumeInFlight(info.cwd)
    ) {
      continue;
    }

    const decorated = { ...info };
    if (info.sessionId) {
      const run = getRunForSession(info.sessionId);
      if (run) {
        decorated.skill = run.skill;
        decorated.skillArgs = run.args;
        decorated.runId = run.runId;
      }
      const active = getActiveSession(info.sessionId);
      if (active) {
        decorated.controllable = active.status !== "expired";
        decorated.lifecycle = active.status;
        decorated.displayName = active.displayName;
        decorated.turnActive = active.turnActive === true;
        if (active.lastStats) decorated.lastStats = active.lastStats;
        // Backfill creation time from the registry when Claude's <pid>.json
        // body didn't carry one (older versions / partial writes).
        decorated.startedAt ??= active.startedAt;
      }
      const a = aliasesFor(info.sessionId);
      if (a.length > 0) decorated.aliases = a;
    }
    dedupe.set(key, decorated);
  }

  const out: SessionInfo[] = Array.from(dedupe.values());
  const seen = new Set<string>(dedupe.keys());

  // Surface every registered session the file cache hasn't already covered.
  // A dashboard session now owns its id from spawn (--session-id), so its
  // registry row carries the SAME id claude will write into its <pid>.json —
  // once that file lands, the top loop's file row supersedes this one (deduped
  // via `seen` on sessionId). Until then (e.g. a freshly-created session with no
  // model turn yet, or a dormant one), this is the only row, so the session is
  // visible/selectable/chattable/bashable from the moment it's created — no
  // longer gated on claude writing a file after the first turn.
  //
  // (Historically this loop skipped `pending-` rows whose cwd matched an sdk-cli
  // cache file, to hide the ~200ms provisional-id spawn race. With ids owned at
  // spawn there is no provisional id and no race, and the shared workspace cwd
  // made that heuristic hide brand-new sessions outright — so it's gone.)
  for (const a of listActiveSessions()) {
    if (seen.has(a.sessionId)) continue;
    const al = aliasesFor(a.sessionId);
    out.push({
      id: `dormant:${a.sessionId.slice(0, 8)}`,
      path: "",
      mtime: new Date(a.lastSeenAt).toISOString(),
      size: 0,
      sessionId: a.sessionId,
      cwd: a.cwd,
      kind: "interactive",
      entrypoint: "sdk-cli",
      startedAt: a.startedAt,
      runId: a.runId ?? undefined,
      skill: a.via === "skill" ? a.label : undefined,
      controllable: a.status !== "expired",
      lifecycle: a.status,
      displayName: a.displayName,
      turnActive: a.turnActive === true,
      ...(al.length > 0 ? { aliases: al } : {}),
      ...(a.lastStats ? { lastStats: a.lastStats } : {}),
    });
  }

  return out.sort((a, b) => (b.mtime > a.mtime ? 1 : -1));
}
