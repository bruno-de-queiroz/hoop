import { spawn, execFile, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  rmSync,
  readdirSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { Writable } from "node:stream";
import { STATE_DIR, CLAUDE_SESSIONS_DIR, WORKSPACE_DIR } from "./paths";
import { ingestEventLine } from "./ingestor";
import { deleteEventsForSessions, listEventSessionIds } from "./db";
import { discoverInstalledPluginDirs } from "./plugin-paths";
import { isCwdAllowed } from "./cwd-policy";
import { isGitPush } from "./peer-policy";
import { randomSessionName } from "./random-name";
import { listSlashCommands } from "./commands";
import { log } from "@shared/logger";

/**
 * Long-lived `claude --input-format=stream-json --output-format=stream-json`
 * subprocesses, one per controllable session. The dashboard's two-way write
 * path lives here.
 *
 * Stream-json input shape (verified against claude-code v2.1.138):
 *
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}\n
 *
 * Multiple turns over one subprocess are supported; the same session_id flows
 * back on every assistant + result frame.
 *
 * The actual event ingest path (hook -> /api/ingest -> SQLite) is untouched.
 * We only parse stream-json output enough to: (a) learn the spawned sessionId,
 * (b) know when a turn finishes (the `result` frame), and (c) capture the
 * model's final text for an optional run output buffer.
 *
 * Cross-restart recovery: registry mutations atomically write a checkpoint
 * to `~/.claude/hoop/active-sessions.json`. On boot we read it back as
 * `status: "dormant"` and revive on first write attempt via `claude --resume`.
 */

export type LifecycleStatus = "alive" | "dormant" | "ended" | "expired" | "error";

/**
 * Per-turn telemetry captured from stream-json frames. Populated incrementally:
 *   - system/init frame → model, mode
 *   - result frame      → usage, turnDurationMs, turnEndedAt
 * Dashboard renders this in the active-session header (context fill %, last
 * turn time, tokens). Versioned via `v` so the dashboard can fall back
 * gracefully when the schema evolves.
 */
export interface LastStats {
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
  turnEndedAt?: number;     // ms epoch — for relative-time rendering

  // Cumulative across all turns of this session, summed at end of each
  // turn. Survives dormant→alive (kept in the checkpoint). The dashboard's
  // stats strip renders these as "total tokens" — derived from registry
  // state instead of walking event payloads on the client, which would
  // otherwise require fetching EventRowFull for every Stop event.
  totals?: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    turns: number;
  };
}

export interface ActiveSessionMeta {
  sessionId: string;
  runId: string | null;     // links back to lib/spawn.ts RunMeta when applicable
  label: string;            // initial label (skill base name, "new conversation", or user-provided)
  displayName: string | null; // friendly name; auto-set from first prompt if not user-provided
  cwd: string;
  via: "skill" | "new-conversation" | "resumed";
  startedAt: number;
  lastSeenAt: number;
  status: LifecycleStatus;
  // Configured `--model` override for this session (CLI alias or full id), or
  // null for the user's default. Set at creation and by `/model`; persisted so
  // it survives dormant→awake — wakeSession re-applies it on every resume.
  model?: string | null;
  // Ephemeral (NOT persisted): true while a model turn is in flight. Set at
  // writeUserTurn, cleared on the result frame or on child exit. Broadcast via
  // the session row so EVERY connected peer — and late joiners reading
  // /api/sessions — see the "model is thinking" indicator, not just clients
  // that happened to witness the UserPromptSubmit event.
  turnActive?: boolean;
  pid?: number;
  exitCode?: number | null;
  errorMessage?: string;
  lastStats?: LastStats;    // last turn's telemetry; missing until first turn completes
}

/**
 * One outstanding permission ask the model has emitted via a stream-json
 * `control_request` frame. The model pauses until we write a matching
 * `control_response` to stdin. REAL (non-synthetic) asks are intentionally NOT
 * persisted to the checkpoint: a sandbox restart kills the child anyway, so any
 * open ask is dead. SYNTHETIC plan reviews (`synthetic: true`) ARE persisted and
 * carried across revive — no hook waits on them, and losing a plan the user was
 * about to approve is a real bug (see CheckpointFile.pendingReviews). Keyed by
 * `requestId` (claude's UUID for the frame).
 */
export interface PendingPermissionRequest {
  requestId: string;
  toolUseId: string | null;
  toolName: string;
  input: unknown;
  decisionReason: string | null;
  receivedAt: number;
  /** Display name of whoever drove the turn this ask came from ("host" or a
   * peer's name). Lets the dashboard show "from $peer" and offer the
   * host an "allow all from $peer" action. */
  author: string | null;
  /** Share id of the driving peer (null for the host). The trust key for
   * session-scoped auto-approve. Not surfaced to clients. */
  shareId: string | null;
  /** True for a plan review SYNTHESIZED from a plan-mode turn that ended
   * WITHOUT a blocking ExitPlanMode ask (weaker models write the plan as prose
   * and stop). No hook waits on it — approve/reject dispatch a follow-up turn
   * rather than resolving a permission gate. */
  synthetic?: boolean;
  /** True when this ask was raised while the session was in a `/plan` turn
   * (slot.planTurnActive). AskUserQuestion is allowed to surface during plan
   * mode (clarifying questions are read-only); this flag lets the answer relay
   * keep the session in plan mode instead of silently dropping enforcement. */
  planMode?: boolean;
}

interface LiveSlot {
  meta: ActiveSessionMeta;
  child?: ChildProcess;
  stdin?: Writable;
  writeQueue: Promise<void>;
  outBuf: string;           // tail of last stream-json output
  outBufBytes: number;
  pendingRequests: PendingPermissionRequest[];
  // FIFO of authors for turns written via writeUserTurn but whose
  // UserPromptSubmit hook event hasn't been ingested yet. Pushed in stdin
  // order (writeQueue serializes), popped on each real UserPromptSubmit so the
  // transcript can attribute "who sent this" in a shared session. Best-effort:
  // popped null (→ system/replay) when empty; bounded by max length + child
  // close so a crash can't mis-attribute a later turn.
  pendingAuthors: Array<{ author: string | null; shareId: string | null; at: number; thumbnails?: TurnImage[]; kind?: string | null; promptOverride?: string }>;
  // Who drove the turn currently executing (set when its UserPromptSubmit is
  // attributed, valid until the next turn). Lets a PreToolUse permission ask
  // — which fires later in the same turn — know which peer triggered it.
  currentTurn: { author: string | null; shareId: string | null } | null;
  // Share ids the host has granted session-scoped "allow all" to. In-memory
  // only (resets on sandbox restart / session end, by design). A PreToolUse
  // ask from a trusted peer auto-approves (except git push, which always
  // escalates to the host).
  trustedShareIds: Set<string>;
  // ---- plan-review tracking (per turn) ----
  // Latest REAL assistant text seen this turn — fallback plan content when a
  // submit_plan/ExitPlanMode call carries an empty `plan` arg (see the gate's
  // plan-capture path). `<synthetic>` frames (usage-limit notices, "(no
  // content)", compaction summaries) are excluded — they aren't a plan.
  lastAssistantText?: string;
  // This turn was launched in plan mode (`/plan`, or a reject-revise turn).
  planTurnActive?: boolean;
  // This turn executes a just-APPROVED plan: the host already reviewed and
  // approved it, so its tool calls auto-allow without raising per-tool
  // permission cards. Scoped to the single execution turn — set on the approval
  // "proceed" turn (writeUserTurn autoAllowRun), reset at the result frame.
  autoAllowPlanRun?: boolean;
  // One-shot: set right before an INTENTIONAL, self-recovering kill (`/stop`,
  // `/model`). The child's close handler consumes it to keep the visible
  // lifecycle "alive" instead of flipping to dormant — the next turn revives
  // the child transparently, so a user-initiated restart shouldn't read as the
  // session going idle. Cleared on consume so a later genuine exit still flips.
  suppressDormantOnce?: boolean;
  // One-shot: set right before the idle-TTL sweeper kills the child. claude
  // exits NON-ZERO on SIGTERM (see suppressDormantOnce), which would otherwise
  // read as "ended"; this flag forces the close handler to mark the slot
  // "dormant" (idle + resumable) instead. Cleared on consume.
  reapToDormant?: boolean;
  // True when this child was spawned via `claude --resume` (reviving a dormant
  // slot). A resume can fail at runtime even when a transcript exists — a
  // corrupt/partial .jsonl or a claude version that can't read an older
  // transcript makes `--resume` exit before consuming stdin, so the turn we
  // just wrote is silently swallowed. writeUserTurn watches for that (a
  // frame-less early exit on a resume spawn) and recovers. A fresh spawn
  // (--session-id) never sets this: it always starts, so there's nothing to
  // fall back to.
  resumeSpawn?: boolean;
  // Set true the moment the stdout parser reads ANY valid stream-json frame —
  // proof the subprocess came alive and is emitting. Used to distinguish a
  // healthy (re)spawn from a resume that died before producing anything.
  sawFirstFrame?: boolean;
  // One-shot resolver installed by waitForResumeOutcome; the parser calls it on
  // the first frame so a caller can stop waiting the instant the child is
  // confirmed alive (rather than waiting out the timeout).
  notifyFirstFrame?: () => void;
}

const MAX_PENDING_AUTHORS = 8;

const CHECKPOINT_FILE = join(STATE_DIR, "active-sessions.json");
const CHECKPOINT_TMP = CHECKPOINT_FILE + ".tmp";
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const MAX_OUT_BYTES = 64 * 1024;
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Idle-TTL reaping. `claude -p --input-format=stream-json` is a PERSISTENT
// process: it stays alive between turns (and even with no turn ever sent),
// waiting for the next stream-json message. So nothing makes an idle session
// exit on its own — the "close → dormant" transition only ever fired on
// restart/kill. The sandbox therefore owns idle-dormancy now: a periodic sweep
// kills the subprocess of any session with no activity for IDLE_TTL_MS, which
// routes through the normal close handler → "dormant" → revive-on-next-turn via
// --resume. Tunable via HOOP_SESSION_IDLE_TTL_MS (0 disables reaping).
const IDLE_TTL_MS = (() => {
  const raw = process.env.HOOP_SESSION_IDLE_TTL_MS;
  if (raw != null && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 30 * 60 * 1000; // 30 minutes
})();
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
let _idleSweeper: ReturnType<typeof setInterval> | null = null;

/**
 * Lifecycle events. Subscribers (SSE stream route) get notified when sessions
 * transition between alive/dormant/ended/expired/error.
 */
export const activeSessionsBus = new EventEmitter();
activeSessionsBus.setMaxListeners(100);

const slots = new Map<string, LiveSlot>();        // canonical sessionId -> slot
const aliases = new Map<string, string>();        // any id (pending) -> canonical
let _bootDone = false;

// cwd -> expiry epoch ms. Marks a `claude --resume` whose new session_id
// hasn't landed on stdout yet. listSessions() uses this to suppress the
// transient undecorated orphan cache row during the swap window. Bounded by
// a short TTL so a crashed/never-swapped resume can't hide rows forever.
const resumingCwds = new Map<string, number>();
const RESUME_INFLIGHT_TTL_MS = 15_000;

function markResumeInFlight(cwd: string): void {
  resumingCwds.set(cwd, Date.now() + RESUME_INFLIGHT_TTL_MS);
}
function clearResumeInFlight(cwd: string): void {
  resumingCwds.delete(cwd);
}
/** True when a resume for this cwd is mid-swap (and not past its TTL). */
export function isResumeInFlight(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const exp = resumingCwds.get(cwd);
  if (exp === undefined) return false;
  if (Date.now() > exp) {
    resumingCwds.delete(cwd);
    return false;
  }
  return true;
}

function canonical(id: string): string {
  return aliases.get(id) ?? id;
}
function getSlot(id: string): LiveSlot | undefined {
  return slots.get(canonical(id));
}

/**
 * Inverse alias lookup. Returns every id that has been remapped to
 * `canonicalId` — i.e. the historical ids the same conversation has been
 * known by (e.g. the pre-resume id when `claude --resume` minted a new internal
 * id). Normally empty now that a session owns its id from spawn. The dashboard
 * uses this to rebuild its `aliases` filter after a page reload so events
 * arriving under any historical id still join the transcript for the open URL.
 */
export function aliasesFor(canonicalId: string): string[] {
  const out: string[] = [];
  for (const [old, current] of aliases.entries()) {
    if (current === canonicalId) out.push(old);
  }
  return out;
}

/**
 * Returns the full set of session ids a given id is known by — the
 * canonical (resolving the id through the alias map if necessary)
 * plus every historical alias pointing at that canonical. Used by
 * `listEvents` so the initial transcript fetch for a session shows
 * every event ever logged under any of its prior ids.
 *
 * For an unknown id (not in the registry, e.g. a deleted session)
 * returns `[id]` — we have no alias info to expand with.
 */
export function expandSessionIds(id: string): string[] {
  const canonicalId = aliases.get(id) ?? id;
  const acc = new Set<string>([canonicalId]);
  for (const [old, current] of aliases.entries()) {
    if (current === canonicalId) acc.add(old);
  }
  return [...acc];
}

// ---------- Public API ----------

export function bootActiveSessions() {
  if (_bootDone) return;
  _bootDone = true;
  mkdirSync(STATE_DIR, { recursive: true });
  loadCheckpoint();
}

/** A synthetic plan review is outstanding (awaiting the human's approve/reject). */
function hasPendingReview(slot: LiveSlot): boolean {
  return slot.pendingRequests.some((r) => r.synthetic);
}

/** The synthetic plan reviews in a slot's pending queue (durable across restart/revive). */
function pendingReviewsOf(slot: LiveSlot): PendingPermissionRequest[] {
  return slot.pendingRequests.filter((r) => r.synthetic);
}

/**
 * Reap idle sessions: any alive slot with no activity for IDLE_TTL_MS and no
 * turn in flight has its subprocess killed, transitioning it to "dormant" (the
 * next turn revives it via --resume). Exported + `now`-parameterized so it's
 * unit-testable without wall-clock. Returns the ids it reaped.
 */
export function sweepIdleSessions(now: number = Date.now()): string[] {
  if (IDLE_TTL_MS <= 0) return []; // reaping disabled
  const reaped: string[] = [];
  for (const slot of slots.values()) {
    if (slot.meta.status !== "alive") continue;   // dormant/ended/expired: nothing to reap
    if (slot.meta.turnActive) continue;           // never interrupt an in-flight turn
    // A plan awaiting the human's approval is not "idle" — reaping it would kill
    // the child and (before reviews became durable) drop the pending plan the
    // user is about to act on. Skip while a synthetic review is outstanding.
    if (hasPendingReview(slot)) continue;
    if (!slot.child || slot.child.killed) continue;
    if (now - slot.meta.lastSeenAt < IDLE_TTL_MS) continue;
    // Force the close handler to land on "dormant" (claude exits non-zero on
    // SIGTERM). Keep the slot registered so --resume can revive it.
    slot.reapToDormant = true;
    try { slot.child.kill("SIGTERM"); } catch { /* already gone */ }
    reaped.push(slot.meta.sessionId);
  }
  if (reaped.length) log.info("active-sessions", "idle-reaped sessions to dormant", { count: reaped.length });
  return reaped;
}

/**
 * Start the periodic idle-TTL sweeper. Called once from server startup (NOT
 * from bootActiveSessions, which fires in unit tests too — the interval is a
 * server-runtime concern). Idempotent; a no-op when reaping is disabled.
 */
export function startIdleSweeper() {
  if (_idleSweeper || IDLE_TTL_MS <= 0) return;
  _idleSweeper = setInterval(() => {
    try { sweepIdleSessions(); } catch (e) {
      log.warn("active-sessions", "idle sweep failed", { err: String((e as any)?.message ?? e) });
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive just for the sweeper.
  if (typeof _idleSweeper.unref === "function") _idleSweeper.unref();
}

export function listActiveSessions(): ActiveSessionMeta[] {
  return Array.from(slots.values())
    .map((s) => ({ ...s.meta }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function getActiveSession(sessionId: string): ActiveSessionMeta | undefined {
  const s = getSlot(sessionId);
  return s ? { ...s.meta } : undefined;
}

/**
 * Mark a session as freshly active from a side-channel message (a `!bash`
 * shortcut or a `>` chat) — bump lastSeenAt and broadcast a `change` so every
 * viewer's list re-sorts and the session reads as active. Does NOT set
 * turnActive (no model turn is running, so it must not show "thinking") and
 * does NOT revive a dormant slot — callers pair this with wakeSession when they
 * also want the agent process revived. No-op for an unknown/expired session.
 */
export function markSessionActive(sessionId: string): void {
  const slot = getSlot(sessionId);
  if (!slot || slot.meta.status === "expired") return;
  slot.meta.lastSeenAt = Date.now();
  activeSessionsBus.emit("change", { sessionId: slot.meta.sessionId, status: slot.meta.status });
}

export function isControllable(sessionId: string): boolean {
  const s = getSlot(sessionId);
  // Anything that's still "ours" (in the registry) and not terminally expired
  // counts as controllable — writeUserTurn revives via --resume if the slot
  // is dormant or its subprocess has ended. Print-mode built-in slash commands
  // exit the subprocess after one frame, so "ended" sessions must remain
  // writable or we'd silently drop the user into a spawn-new branch.
  return !!s && s.meta.status !== "expired";
}

export function isAlive(sessionId: string): boolean {
  const s = getSlot(sessionId);
  return !!s && s.meta.status === "alive" && !!s.child && !s.child.killed;
}

/**
 * Derive a safe workspace subdirectory name from a git URL: take the last path
 * segment, drop a trailing `.git`, strip any query/fragment, and keep only
 * filesystem-safe characters. Falls back to "repo" if nothing usable remains.
 */
export function repoDirNameFromUrl(gitRepo: string): string {
  let tail = gitRepo.trim();
  tail = tail.split(/[?#]/)[0]; // drop query/fragment
  tail = tail.replace(/\/+$/, ""); // trailing slashes
  tail = tail.split(/[/:]/).pop() ?? ""; // last path/scp segment
  tail = tail.replace(/\.git$/i, "");
  tail = tail.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
  // Reject "." / ".." / all-dots so the target can't resolve to WORKSPACE_DIR
  // itself or its parent.
  if (!tail || /^\.+$/.test(tail)) return "repo";
  return tail;
}

const execFileAsync = promisify(execFile);

/**
 * Clone `gitRepo` into WORKSPACE_DIR/<name> and return that path. If the target
 * already exists it is reused as-is (we never overwrite an existing folder).
 *
 * Async (not execFileSync) so a slow clone can't block the single-threaded
 * server event loop — that would stall every other session, the SSE fan-out,
 * and the permission-gate long-polls. We clone into a temp sibling and rename
 * it in on success, so a failed/partial clone never leaves a poisoned dir a
 * later session would silently reuse, and concurrent clones of the same repo
 * can't collide on a half-written tree.
 */
async function cloneRepoIntoWorkspace(gitRepo: string): Promise<string> {
  const name = repoDirNameFromUrl(gitRepo);
  const target = join(WORKSPACE_DIR, name);
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  if (existsSync(target)) {
    log.info("active-sessions", "git clone skipped; target exists", { target });
    return target;
  }
  const tmp = join(WORKSPACE_DIR, `.clone-${randomUUID()}`);
  log.info("active-sessions", "git clone", { gitRepo, target });
  try {
    // `--` guards against a URL that looks like a flag. Inherits process env so
    // GH_TOKEN (forwarded by the launcher) is available for gh-authed https.
    await execFileAsync("git", ["clone", "--", gitRepo, tmp], {
      cwd: WORKSPACE_DIR,
      env: process.env,
      timeout: 5 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e: any) {
    rmSync(tmp, { recursive: true, force: true });
    const stderr = e?.stderr?.toString?.().trim();
    throw new Error(`git clone failed: ${stderr || e?.message || "unknown error"}`);
  }
  // A concurrent create may have populated `target` while we cloned; if so,
  // discard our copy and reuse theirs rather than fail on rename.
  if (existsSync(target)) {
    rmSync(tmp, { recursive: true, force: true });
    return target;
  }
  renameSync(tmp, target);
  return target;
}

/**
 * Spawn a fresh controllable session. No initial prompt; the first user turn
 * arrives via writeUserTurn().
 */
export async function startNewConversation(opts: {
  // Optional git URL cloned into the workspace on start; the clone becomes the
  // session cwd. This is what the dashboard sends now (folder selection is gone).
  gitRepo?: string | null;
  // Explicit working directory. No longer settable from the dashboard, but kept
  // for internal callers/tests and honored when no gitRepo is given.
  cwd?: string;
  label?: string;
  name?: string | null;
  model?: string | null;
  runId?: string | null;
  via?: "new-conversation" | "skill";
}): Promise<{ sessionId: string; meta: ActiveSessionMeta }> {
  bootActiveSessions();
  // Sessions run in the sandbox workspace. When a git URL is given, clone it in
  // (once) and use that clone as the cwd; otherwise fall back to an explicit
  // cwd / HOOP_RUN_CWD / the shared workspace.
  const gitRepo = opts.gitRepo?.trim() || null;
  const cwd = gitRepo
    ? await cloneRepoIntoWorkspace(gitRepo)
    : opts.cwd || process.env.HOOP_RUN_CWD || WORKSPACE_DIR;
  const label = opts.label || "new conversation";
  const via = opts.via || "new-conversation";
  const runId = opts.runId ?? null;
  const model = opts.model?.trim() || null;
  // Always seed a haiku-style label so sessions land in the sidebar with a
  // memorable name (and so the dashboard's transcript header has something
  // to render immediately, rather than waiting for the first prompt). User
  // can rename via PATCH /sessions/:id at any time.
  const displayName = opts.name?.trim() || randomSessionName();
  return spawnControllable({ cwd, label, displayName, model, via, runId, resumeSessionId: null });
}

export function renameSession(sessionId: string, name: string): ActiveSessionMeta | null {
  const slot = getSlot(sessionId);
  if (!slot) return null;
  slot.meta.displayName = name.trim() || null;
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId: slot.meta.sessionId, status: slot.meta.status });
  return { ...slot.meta };
}

/**
 * Wake (or eagerly spawn) the subprocess for a known sessionId. Used by the
 * lazy-revive path when the user types into a dormant session.
 */
export async function wakeSession(sessionId: string): Promise<ActiveSessionMeta> {
  bootActiveSessions();
  const slot = getSlot(sessionId);
  if (!slot) throw new Error(`unknown session: ${sessionId}`);
  const canonicalId = slot.meta.sessionId;
  if (slot.meta.status === "alive" && slot.child && !slot.child.killed) {
    return { ...slot.meta };
  }
  if (slot.meta.status === "expired") {
    throw new Error(`session expired: ${canonicalId}`);
  }

  // Re-apply cwd policy on revival. The policy may have been tightened since
  // the session was originally created, or the checkpoint file may have been
  // tampered with. Fail closed: prune the entry and refuse to spawn.
  const cwdCheck = isCwdAllowed(slot.meta.cwd);
  if (!cwdCheck.ok) {
    const reason = cwdCheck.reason;
    log.warn("active-sessions", "dormant session cwd no longer allowed; pruning", {
      sessionId: canonicalId,
      cwd: slot.meta.cwd,
      reason,
    });
    slots.delete(canonicalId);
    for (const [alias, target] of aliases.entries()) {
      if (target === canonicalId) aliases.delete(alias);
    }
    saveCheckpoint();
    activeSessionsBus.emit("change", { sessionId: canonicalId, status: "expired" });
    throw new Error(`session cwd no longer allowed (${reason}): ${canonicalId}`);
  }

  // Resume the id whose transcript actually exists on disk — NOT blindly the
  // canonical id. `claude --resume <id>` only continues the conversation if it
  // finds ~/.claude/projects/<cwd-slug>/<id>.jsonl; given a missing id it exits
  // 1 ("No conversation found"). Earlier builds resumed the canonical (latest
  // swapped) id, which often had no transcript, so every wake spawned an empty
  // session, minted yet another id (growing the alias chain unboundedly), lost
  // the real conversation context, and left usage/ctx near-zero. Pick the
  // transcript-bearing id (newest, if several), re-key the registry so it
  // becomes canonical, and resume THAT — claude keeps the id and continues.
  //
  // findResumableId returns null when NO transcript exists for the id or any
  // alias. That is NOT an error and must NOT prune the slot: a session can be
  // created (dashboard "new session") and go dormant across a sandbox restart
  // before it ever ran a turn, so it legitimately has no history yet. Instead of
  // failing the turn, we start a FRESH session under the SAME id below
  // (--session-id, not --resume): the dashboard is watching that id, so the
  // conversation simply begins now and the queued turn lands.
  const resumeId = findResumableId(canonicalId);
  if (resumeId !== null && resumeId !== canonicalId) {
    rekeyCanonical(canonicalId, resumeId);
  }

  // CRITICAL: forward the existing displayName. Without this the new slot
  // starts with displayName=null, the sidebar falls back to cwd basename,
  // and the auto-name-from-first-prompt logic then rewrites it — a visible
  // name ping-pong on every revive.
  const { meta } = await spawnControllable({
    cwd: slot.meta.cwd,
    label: slot.meta.label,
    displayName: slot.meta.displayName,
    // Re-apply the configured model on every resume. Without this a woken
    // session silently reverts to the user's default `--model`, so a `/stop`
    // (or any dormancy) would quietly undo a `/model` switch.
    model: slot.meta.model,
    via: "resumed",
    runId: slot.meta.runId,
    resumeSessionId: resumeId,
    // No transcript to resume → start a fresh session under the SAME id (see
    // above) so the dashboard's session URL stays valid and the turn is
    // delivered. Ignored by spawnControllable when resumeSessionId is set.
    freshSessionId: resumeId === null ? canonicalId : null,
    // Forward cumulative totals so they accumulate across the
    // dormant→awake transition. The result-frame handler adds to
    // existing.totals; without this, the new spawn starts at zeros
    // and the dashboard's running totals visibly reset every wake.
    carryStats: slot.meta.lastStats ?? null,
    // Carry any plan review awaiting approval into the fresh slot — the old
    // slot (and its pendingRequests) is dropped when spawnControllable registers
    // the new one, so without this a revive would lose the pending plan.
    carryPending: pendingReviewsOf(slot),
  });
  return meta;
}

/**
 * Among a session's canonical id and all its historical aliases, return the id
 * whose transcript file exists on disk, preferring the most recently written
 * one. Returns `null` when NO transcript exists for the canonical id or any
 * alias. `claude --resume <id>` on a transcript-less id exits with "No
 * conversation found with session ID" and silently drops the turn, so callers
 * MUST treat null specially: start a fresh session under the same id
 * (--session-id) rather than blindly --resume it. A null return is NOT an error
 * — a session created but never prompted legitimately has no transcript yet.
 */
function findResumableId(canonicalId: string): string | null {
  const candidates = new Set<string>([canonicalId, ...aliasesFor(canonicalId)]);
  let best: { id: string; mtimeMs: number } | null = null;
  if (existsSync(PROJECTS_DIR)) {
    try {
      for (const proj of readdirSync(PROJECTS_DIR)) {
        for (const id of candidates) {
          try {
            const m = statSync(join(PROJECTS_DIR, proj, `${id}.jsonl`)).mtimeMs;
            if (!best || m > best.mtimeMs) best = { id, mtimeMs: m };
          } catch { /* this id has no transcript in this project dir */ }
        }
      }
    } catch { /* ignore */ }
  }
  return best?.id ?? null;
}

/**
 * Re-key a dormant slot from `fromId` to `toId` (one of its aliases that we're
 * about to resume). Drops the stale slot, repoints every alias of `fromId` to
 * `toId`, makes `fromId` itself an alias of `toId`, and stops `toId` from being
 * its own alias. After this, getSlot(anyHistoricalId) still resolves.
 */
function rekeyCanonical(fromId: string, toId: string): void {
  slots.delete(fromId);
  aliases.delete(toId);
  for (const [a, target] of aliases.entries()) {
    if (target === fromId) aliases.set(a, toId);
  }
  aliases.set(fromId, toId);
}

/**
 * Write one user turn to a session's stdin. Wakes a dormant session first.
 * Serialised per sessionId so concurrent writes don't interleave JSON frames.
 */
// Tools permitted DURING a plan turn — the read-only investigation set, mirror
// of permission-gate.sh's fast-allow list (minus Bash/ExitPlanMode, which route
// to the sandbox policy). Anything not here is hard-denied while planning.
const PLAN_READONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "ToolSearch", "WebFetch", "WebSearch", "NotebookRead", "TodoWrite",
]);

// Appended to the session's system prompt at spawn (`--append-system-prompt`,
// see the arg builder). This is a STANDING behavior rule, not a per-turn
// message: it never appears in the transcript, and it's phrased conditionally so
// it's inert on ordinary turns and only takes effect once the session is in plan
// mode. Its one job is to stop the model from ending a plan turn with the plan
// written as prose instead of submitted via the tool — the only action that
// actually surfaces a review. It names `submit_plan` unqualified (the model
// resolves it to the namespaced MCP tool) and deliberately omits enter_plan_mode:
// `/plan` engages plan mode via the set_permission_mode flip, so telling the
// model to re-enter it only invites confusion.
const PLAN_SYSTEM_PROMPT =
  "When this session is in plan mode (read-only: edits, shell commands, and " +
  "subagents are blocked), you MUST finish the turn by calling the `submit_plan` " +
  "tool with your full plan — a concise numbered list of steps, the files/areas " +
  "you'd touch, and how you'd verify it. Describing the plan as an ordinary " +
  "message does NOT submit it: a plan is captured for human review only when you " +
  "call `submit_plan`. Investigate first with Read/Grep/Glob, then submit.";

// The interactive tools headless mode lacks come from the bundled hoop MCP
// server (see plugins/hoop/.mcp.json + mcp/tools-server.mjs). Claude namespaces
// plugin MCP tools as `mcp__plugin_hoop_tools__<tool>`; we match tolerantly
// (endsWith + "hoop") so the exact namespacing (plugin/server id) can't silently
// break capture. The bare native names ("ExitPlanMode", "AskUserQuestion") are
// accepted too — absent in headless mode today, but kept so the wiring still
// fires if a future claude re-exposes them.
function isPlanSubmitTool(name: string): boolean {
  return name === "ExitPlanMode" || (name.includes("hoop") && name.endsWith("__submit_plan"));
}
function isEnterPlanTool(name: string): boolean {
  return name.includes("hoop") && name.endsWith("__enter_plan_mode");
}
// The MCP ask tool is normalized to the native "AskUserQuestion" toolName in
// createPermissionRequest, so ALL the existing AskUserQuestion wiring (dashboard
// routing, capability gating, the deny+follow-up-turn answer relay) works
// unchanged — only the trigger (a callable tool) is new.
function isAskUserQuestionTool(name: string): boolean {
  return name === "AskUserQuestion" || (name.includes("hoop") && name.endsWith("__ask_user_question"));
}

/** A base64 image attached to a user turn — becomes an image content block. */
export interface TurnImage {
  media_type: string;
  data: string;
}

export async function writeUserTurn(
  sessionId: string,
  text: string,
  author: string | null = null,
  shareId: string | null = null,
  opts?: { mode?: "plan" | "bypassPermissions" | "default"; images?: TurnImage[]; thumbnails?: TurnImage[]; kind?: string | null; autoAllowRun?: boolean },
): Promise<{ sessionId: string }> {
  bootActiveSessions();
  let slot = getSlot(sessionId);
  if (!slot) throw new Error(`unknown session: ${sessionId}`);
  if (slot.meta.status === "expired") throw new Error(`session expired: ${slot.meta.sessionId}`);

  // Lazy revive
  const needsRevive = slot.meta.status !== "alive" || !slot.child || slot.child.killed;
  if (needsRevive) {
    await wakeSession(slot.meta.sessionId);
    slot = getSlot(sessionId)!;
  }
  const beforeId = slot.meta.sessionId;
  // Mark the turn in flight and broadcast it, so the "model is thinking"
  // indicator lights up for every connected peer (and late joiners, who read
  // it off the session row) — not just whoever's client saw the UserPromptSubmit
  // event. Cleared on the result frame or on child exit. The "change" emit
  // triggers a sessions refresh that carries turnActive to all viewers.
  slot.meta.turnActive = true;
  activeSessionsBus.emit("change", { sessionId: beforeId, status: slot.meta.status });
  // Record the author for attribution, in stdin order. Bounded so a missed
  // UserPromptSubmit (crash mid-turn) can't grow the queue unboundedly.
  // `/plan [task]` runs this ONE turn in plan mode: we flip the persistent
  // session to plan via a stdin control_request before the turn, so the agent
  // proposes a plan instead of acting. Because the session was spawned
  // bypassPermissions, plan mode reverts to bypassPermissions once the plan is
  // approved — preserving the hook-as-sole-gate invariant. Claude's built-in
  // /plan is TUI-only, so we intercept the keyword here. `opts.mode` lets an
  // internal caller (plan approve/reject) set the mode explicitly.
  const planMatch = /^\/plan\b[ \t]*([\s\S]*)$/.exec(text.trimStart());
  const mode = opts?.mode ?? (planMatch ? "plan" : undefined);
  // Forward the user's task VERBATIM (just the `/plan` prefix stripped). We do
  // NOT prepend a planning brief to the turn: that would land in the model's
  // real conversation and read like a system prompt bolted onto the user's
  // message. The steering that makes the model finish via submit_plan instead
  // of describing the plan in prose lives in the session's appended system
  // prompt (PLAN_SYSTEM_PROMPT, passed at spawn) — invisible to the transcript
  // and inert outside plan mode. Enforcement is separate and mechanical: the
  // set_permission_mode flip (below) makes the session read-only and the gate
  // captures the plan on submit_plan/ExitPlanMode. A bare `/plan` with no task
  // can't forward an empty turn, so it gets a minimal neutral nudge.
  const planTask = planMatch ? planMatch[1].trim() : "";
  const turnText = planMatch
    ? planTask || "Propose a plan for the task we've been discussing."
    : text;

  // Slash-command turns get tagged `kind: "command"` so the transcript can
  // render them distinctly (a command card, not an ordinary chat bubble). We
  // also carry the ORIGINAL typed text as `promptOverride`: for `/plan` the
  // sandbox forwards only the stripped task to the model, so claude's
  // UserPromptSubmit hook records the task WITHOUT the `/plan` prefix. Without
  // the override the transcript's optimistic row (which holds "/plan …") never
  // reconciles with the real event (which holds "…"), and the message shows up
  // twice. Restoring the typed text here fixes the dupe at the source and keeps
  // the history/peers correct too. Command detection is authoritative: the
  // leading token must match a known slash command (or the `/plan` intercept),
  // so a normal message that merely starts with "/" (e.g. a path) isn't tagged.
  const commandName = /^\/([a-zA-Z][\w:-]*)/.exec(text.trimStart())?.[1] ?? null;
  const isCommandTurn =
    !opts?.kind &&
    commandName != null &&
    (commandName === "plan" || listSlashCommands(slot.meta.cwd).some((c) => c.name === commandName));
  const turnKind = opts?.kind ?? (isCommandTurn ? "command" : null);
  const promptOverride = isCommandTurn ? text.trim() : undefined;

  // Per-turn plan tracking. In plan mode the gate holds the session read-only
  // until the model calls submit_plan/ExitPlanMode — that call is what surfaces
  // a review (captured deterministically at the gate). We do NOT synthesize a
  // review from the turn's final prose.
  slot.planTurnActive = mode === "plan";
  // Per-turn plan-capture state. Clearing lastAssistantText matters: without it
  // a turn that produces no real output could reuse the PREVIOUS turn's prose as
  // the plan for a submit_plan call with an empty arg.
  slot.lastAssistantText = undefined;
  // Approved-plan execution turn → auto-allow its tool calls (reset at the
  // result frame). Only the plan-approval "proceed" turn sets this; every
  // ordinary turn clears it, so the window is exactly this one turn.
  slot.autoAllowPlanRun = opts?.autoAllowRun === true;

  slot.pendingAuthors.push({ author, shareId, at: Date.now(), thumbnails: opts?.thumbnails, kind: turnKind, promptOverride });
  if (slot.pendingAuthors.length > MAX_PENDING_AUTHORS) slot.pendingAuthors.shift();
  // Deliver the turn. The mode flip is ordered on the same stdin pipe so it
  // lands before the turn. Kept as a closure because we may have to replay the
  // exact same turn into a fresh child after a failed resume (below).
  const sendTurn = (targetId: string) => async () => {
    if (mode) await doWriteControl(targetId, { subtype: "set_permission_mode", mode });
    await doWrite(targetId, turnText, opts?.images);
  };
  // Serialise writes per session
  slot.writeQueue = slot.writeQueue.then(sendTurn(beforeId));
  await slot.writeQueue;

  // A resume can fail at runtime even though a transcript exists: a corrupt or
  // version-incompatible .jsonl makes `claude --resume` exit BEFORE it reads
  // stdin, so the turn we just wrote is swallowed and the session would hang
  // "thinking" forever with no answer. Only a resume revive can hit this — a
  // fresh --session-id spawn always starts. Watch for a frame-less early exit;
  // on failure, start a fresh session (new id; the old id is kept as an alias
  // since its transcript is unusable AND its id can't be reused — `--session-id`
  // rejects an id that already has a transcript) and replay the turn into it.
  if (needsRevive && slot.resumeSpawn) {
    const outcome = await waitForResumeOutcome(slot, 5_000);
    if (outcome === "resume-failed") {
      slot = await recoverWithFreshSession(beforeId);
      const freshId = slot.meta.sessionId;
      slot.meta.turnActive = true;
      // Mirror the per-turn plan state onto the fresh slot so a /plan (or a
      // plan-approval) turn that had to be replayed still runs in the right mode.
      slot.planTurnActive = mode === "plan";
      slot.autoAllowPlanRun = opts?.autoAllowRun === true;
      slot.lastAssistantText = undefined;
      slot.pendingAuthors.push({ author, shareId, at: Date.now(), thumbnails: opts?.thumbnails, kind: turnKind, promptOverride });
      if (slot.pendingAuthors.length > MAX_PENDING_AUTHORS) slot.pendingAuthors.shift();
      activeSessionsBus.emit("change", { sessionId: freshId, status: slot.meta.status });
      slot.writeQueue = slot.writeQueue.then(sendTurn(freshId));
      await slot.writeQueue;
      return { sessionId: freshId };
    }
  }

  // A freshly-revived (dormant→alive via --resume) subprocess could report a
  // different session_id than the one we resumed under; wait briefly for that
  // swap so the client follows the right id for the next write. A brand-new
  // session owns its id from spawn (--session-id) and never revives here, so it
  // skips this. (waitForSwap resolves early only if the id already changed; when
  // resume preserves the id it waits out the timeout — a known small wake cost.)
  if (needsRevive) await waitForSwap(slot, beforeId, 5_000);
  return { sessionId: slot.meta.sessionId };
}

/**
 * Interrupt the model's in-flight turn (`/stop`). The sandbox's Claude Code
 * (2.1.169) doesn't honor the stream-json interrupt frame — the turn runs to
 * completion — so we abort by KILLING the child. The `close` handler marks the
 * slot dormant (a signal exit → resumable), and the next writeUserTurn revives
 * it via `--resume`; the in-flight turn's partial output is discarded, which is
 * what "stop" means. claude emits no Stop for a killed turn, so we synthesize
 * one to clear the "thinking" indicator on every client and record the stop.
 */
export async function interruptSession(sessionId: string, byAuthor: string | null = null): Promise<void> {
  bootActiveSessions();
  const slot = getSlot(sessionId);
  if (!slot) throw new Error(`unknown session: ${sessionId}`);
  const child = slot.child;
  if (!child || child.killed) return; // nothing running to stop
  const canonicalSid = slot.meta.sessionId;
  // Echo the `/stop` command once in the transcript (kind:"command") so the
  // host action is visible and reads like any other command — the request. The
  // synthesized Stop below is its result. This is what the composer's client-
  // side interception routes here (the command never reaches the model).
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "UserPromptSubmit",
      ctx: { session_id: canonicalSid, prompt: "/stop", author: byAuthor ?? "host", kind: "command" },
    }));
  } catch { /* best-effort */ }
  // Intentional kill — don't let the close handler flip the session to dormant.
  slot.suppressDormantOnce = true;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "Stop",
      ctx: { session_id: canonicalSid, last_assistant_message: "⏹ Turn stopped.", author: byAuthor ?? "host" },
    }));
  } catch { /* best-effort — the kill already stopped the turn */ }
}

/**
 * Switch the session's model (`/model <alias>`), effective immediately. The CLI
 * has no live model-change control frame (its built-in `/model` is TUI-only and
 * rejected in stream-json print mode), so we mirror `/stop`: persist the new
 * `--model` on the slot and KILL the child. The close handler marks the slot
 * dormant, and the next writeUserTurn revives it via `--resume` with the new
 * model (wakeSession forwards meta.model). Any in-flight turn is aborted —
 * that's what "effective immediately" means. A `null`/empty model clears the
 * override so the session falls back to the user's default on the next resume.
 */
export function setSessionModel(
  sessionId: string,
  model: string | null,
  byAuthor: string | null = null,
): { sessionId: string; model: string | null } {
  bootActiveSessions();
  const slot = getSlot(sessionId);
  if (!slot) throw new Error(`unknown session: ${sessionId}`);
  if (slot.meta.status === "expired") throw new Error(`session expired: ${slot.meta.sessionId}`);
  const canonicalSid = slot.meta.sessionId;
  const next = model?.trim() || null;
  slot.meta.model = next;
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId: canonicalSid, status: slot.meta.status });
  // Kill the running child so the switch takes effect now; the next turn
  // resumes on the new model. No-op when nothing is running — the persisted
  // model will still be applied on the next wake.
  const child = slot.child;
  if (child && !child.killed) {
    // Intentional kill — don't let the close handler flip the session to dormant.
    slot.suppressDormantOnce = true;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  // Echo the `/model` command once in the transcript (kind:"command") so the
  // switch reads as the host action it is — the request; the synthesized Stop
  // below is its result. This is what the composer's client-side interception
  // routes here (the command never reaches the model).
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "UserPromptSubmit",
      ctx: {
        session_id: canonicalSid,
        prompt: next ? `/model ${next}` : "/model",
        author: byAuthor ?? "host",
        kind: "command",
      },
    }));
  } catch { /* best-effort */ }
  // Synthesize a Stop so the "thinking" indicator clears (as with /stop) and
  // the transcript records the switch. Skipped when there's no child to stop
  // and thus no indicator to clear would still be harmless, so we always emit.
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "Stop",
      ctx: {
        session_id: canonicalSid,
        last_assistant_message: next ? `⚙ Model set to ${next}.` : "⚙ Model reset to default.",
        author: byAuthor ?? "host",
      },
    }));
  } catch { /* best-effort */ }
  return { sessionId: canonicalSid, model: next };
}

/**
 * Mark a session's turn as finished (`Stop` hook). The Stop hook is claude's
 * authoritative "the turn is over" signal — the same one the dashboard's
 * client-side indicator trusts — and unlike the stream-json `result` frame it
 * fires exactly once per real turn (result frames also arrive early/synthetic
 * with all-zero usage mid-turn). Clearing here keeps the "model is thinking"
 * indicator honest for every viewer, including late joiners reading the flag
 * off the session row. No-op when nothing is in flight.
 */
export function markTurnFinished(sessionId: string): void {
  const slot = getSlot(sessionId);
  if (!slot || slot.meta.turnActive !== true) return;
  slot.meta.turnActive = false;
  // Nudge a sessions refresh so every viewer's indicator clears promptly.
  activeSessionsBus.emit("turn", { sessionId: slot.meta.sessionId });
}

/**
 * Pop the author of the next-to-be-ingested UserPromptSubmit for this session,
 * for transcript attribution in shared sessions. Returns null when the queue is
 * empty (a replayed/compaction frame, or a turn not sent via writeUserTurn) —
 * never steals a queued author for a synthetic prompt. Drops stale entries
 * (older than the TTL) first so a crash mid-turn can't mis-attribute later.
 */
const PENDING_AUTHOR_TTL_MS = 5 * 60_000;
/**
 * Pop the queued metadata for the next-to-be-ingested UserPromptSubmit: the
 * author (attribution), any image thumbnails (persisted into the event so the
 * transcript — host and peers — can show what was sent), and an optional `kind`
 * marker (e.g. "plan-approval", "command") that lets the transcript re-style
 * lifecycle/command turns instead of rendering them as ordinary chat, and a
 * `promptOverride` (the original typed text for a command turn, e.g. "/plan …"
 * whose stripped task is what the model actually received). Returns nulls when
 * the queue is empty (replay/compaction/synthetic).
 */
export function popPendingAuthor(sessionId: string): { author: string | null; thumbnails: TurnImage[] | null; kind: string | null; promptOverride: string | null } {
  const slot = getSlot(sessionId);
  if (!slot) return { author: null, thumbnails: null, kind: null, promptOverride: null };
  const now = Date.now();
  while (slot.pendingAuthors.length > 0 && now - slot.pendingAuthors[0].at > PENDING_AUTHOR_TTL_MS) {
    slot.pendingAuthors.shift();
  }
  const next = slot.pendingAuthors.shift();
  // Remember who's driving the turn that's now starting, so a PreToolUse
  // permission ask later in this same turn can be attributed to them. A turn
  // not sent via writeUserTurn (replay/synthetic) leaves the previous value;
  // that's fine — it's only consulted to attribute peer-driven asks, and a
  // synthetic prompt won't trigger one.
  if (next) slot.currentTurn = { author: next.author, shareId: next.shareId };
  return {
    author: next ? next.author : null,
    thumbnails: next?.thumbnails ?? null,
    kind: next?.kind ?? null,
    promptOverride: next?.promptOverride ?? null,
  };
}

/** Grant session-scoped "allow all" to a peer share. Subsequent PreToolUse
 * asks from turns this peer drives auto-approve (except git push). In-memory:
 * cleared on sandbox restart / session end. */
export function trustPeerForSession(sessionId: string, shareId: string): { ok: boolean } {
  const slot = getSlot(sessionId);
  if (!slot || !shareId) return { ok: false };
  slot.trustedShareIds.add(shareId);
  return { ok: true };
}

function waitForSwap(slot: LiveSlot, initialId: string, timeoutMs: number): Promise<void> {
  if (slot.meta.sessionId !== initialId) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      activeSessionsBus.off("change", listener);
      resolve(); // best-effort: resolve even if swap didn't happen
    }, timeoutMs);
    const listener = () => {
      if (slot.meta.sessionId !== initialId) {
        clearTimeout(timer);
        activeSessionsBus.off("change", listener);
        resolve();
      }
    };
    activeSessionsBus.on("change", listener);
  });
}

/**
 * After writing a turn to a just-resumed subprocess, determine whether the
 * resume actually took. Resolves:
 *   - "ok"            as soon as the child emits its first frame (it's alive and
 *                     processing our turn), OR if it already had.
 *   - "resume-failed" if the child CLOSES having never emitted a frame — the
 *                     turn was written into a dying stdin and silently dropped
 *                     (a corrupt/unreadable transcript makes `--resume` exit
 *                     before it reads stdin). The caller recovers.
 *   - "timeout"       if neither happens within timeoutMs. Treated as healthy:
 *                     a slow-but-alive resume must NOT be torn down, so we only
 *                     ever recover on a definitive frame-less CLOSE, never on a
 *                     timeout.
 */
function waitForResumeOutcome(
  slot: LiveSlot,
  timeoutMs: number,
): Promise<"ok" | "resume-failed" | "timeout"> {
  if (slot.sawFirstFrame) return Promise.resolve("ok");
  const child = slot.child;
  // A bad `--resume` exits within milliseconds, so its `close` may have already
  // fired before we got here. `exitCode`/`signalCode` are non-null once the
  // process has exited (both null while alive; `!= null` also tolerates the
  // test mock, where they're undefined). Either way, no frame + gone ⇒ failed.
  const alreadyExited =
    child != null && (child.exitCode != null || (child as { signalCode?: unknown }).signalCode != null);
  if (!child || child.killed || alreadyExited) {
    return Promise.resolve("resume-failed");
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: "ok" | "resume-failed" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.off("close", onClose); } catch { /* ignore */ }
      if (slot.notifyFirstFrame === onFrame) slot.notifyFirstFrame = undefined;
      resolve(r);
    };
    const onFrame = () => done("ok");
    const onClose = () => done(slot.sawFirstFrame ? "ok" : "resume-failed");
    const timer = setTimeout(() => done(slot.sawFirstFrame ? "ok" : "timeout"), timeoutMs);
    slot.notifyFirstFrame = onFrame;
    child.once("close", onClose);
  });
}

/**
 * Recover from a resume that failed at runtime (see waitForResumeOutcome). The
 * dormant slot's transcript is unreadable, so we can't `--resume` it — and we
 * can't reuse its id either: `claude --session-id <id>` refuses with "Session
 * ID already in use" whenever a transcript file exists for that id (verified
 * against the CLI). So we start a genuinely FRESH session under a NEW id and
 * make every id the old session was known by an ALIAS of it. The dashboard's
 * `?session=<oldId>` URL keeps resolving, the caller can replay the turn into a
 * healthy child, and the unreadable transcript is left untouched on disk (this
 * is deliberately NON-destructive — a resume failure can be transient, e.g. a
 * claude version mid-upgrade, so we never delete the old history).
 */
async function recoverWithFreshSession(oldCanonicalId: string): Promise<LiveSlot> {
  const dead = slots.get(oldCanonicalId);
  if (!dead) throw new Error(`recover: unknown session ${oldCanonicalId}`);
  const carryStats = dead.meta.lastStats ?? null;
  const carryPending = pendingReviewsOf(dead);
  const meta = dead.meta;
  // Drop the dead slot before spawning so the new (random) id is the sole live
  // entry; its aliases are re-pointed below.
  slots.delete(oldCanonicalId);
  const { sessionId: newId } = await spawnControllable({
    cwd: meta.cwd,
    label: meta.label,
    displayName: meta.displayName,
    model: meta.model,
    via: "resumed",
    runId: meta.runId,
    // Brand-new id (randomUUID): NOT a resume, NOT the old id (which is claimed
    // by the unreadable transcript on disk).
    resumeSessionId: null,
    freshSessionId: null,
    carryStats,
    carryPending,
  });
  // Point the old canonical id — and everything that already aliased to it —
  // at the fresh session, so the dashboard URL and any in-flight references
  // resolve to the new child.
  aliases.set(oldCanonicalId, newId);
  for (const [k, v] of aliases.entries()) {
    if (v === oldCanonicalId) aliases.set(k, newId);
  }
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId: newId, status: "alive", aliasFrom: oldCanonicalId });
  // Tell the user, in-transcript, why context is gone — never fail silently.
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "Stop",
      ctx: {
        session_id: newId,
        hook_event_name: "Stop",
        last_assistant_message:
          "⚠ Couldn't resume this conversation's saved history — the transcript was unreadable. Continuing in a fresh session, so earlier messages aren't available to me.",
        synthetic: true,
        kind: "error",
      },
    }));
  } catch { /* best-effort notice */ }
  log.warn("active-sessions", "resume failed at runtime; recovered with a fresh session", {
    oldSessionId: oldCanonicalId,
    newSessionId: newId,
    cwd: meta.cwd,
  });
  return slots.get(newId)!;
}

/**
 * Permanently delete a session: terminates the subprocess (if alive), removes
 * the registry entry + checkpoint, and deletes the on-disk transcript file
 * under ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. Cannot be undone.
 *
 * For sessions the dashboard didn't own (e.g. user's interactive TUI), this
 * is a no-op on the subprocess (we don't kill foreign processes) but still
 * removes the transcript file if found.
 */
export async function deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
  bootActiveSessions();
  const canonicalId = canonical(sessionId);
  // Terminate the subprocess if we own it.
  if (slots.has(canonicalId)) {
    await endSession(canonicalId);
  }
  // Best-effort: remove transcript file. Walk projects/ and unlink any match.
  let removed = false;
  if (existsSync(PROJECTS_DIR)) {
    try {
      for (const proj of readdirSync(PROJECTS_DIR)) {
        const candidate = join(PROJECTS_DIR, proj, `${canonicalId}.jsonl`);
        if (existsSync(candidate)) {
          try { unlinkSync(candidate); removed = true; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  // Also remove the ~/.claude/sessions/<pid>.json file claude leaves behind.
  // For orphaned sessions (subprocess died ungracefully) this file lingers and
  // keeps the sidebar entry alive even after we drop the transcript.
  removed = removeClaudeSessionFile(canonicalId) || removed;
  // Purge the session's events from the search DB (events + FTS + vec, hot +
  // archive) so deleted sessions stop showing up in search / observability.
  // expandSessionIds pulls in any alias ids picked up across resume cycles.
  try {
    deleteEventsForSessions(expandSessionIds(canonicalId));
  } catch (err) {
    log.warn("delete", "failed to purge events for deleted session", { sessionId: canonicalId, err });
  }
  return { deleted: removed || slots.has(canonicalId) === false };
}

function removeClaudeSessionFile(sessionId: string): boolean {
  if (!existsSync(CLAUDE_SESSIONS_DIR)) return false;
  try {
    for (const name of readdirSync(CLAUDE_SESSIONS_DIR)) {
      if (!name.endsWith(".json")) continue;
      const file = join(CLAUDE_SESSIONS_DIR, name);
      try {
        const body = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
        if (body?.sessionId === sessionId) {
          try { unlinkSync(file); return true; } catch { /* ignore */ }
        }
      } catch { /* skip corrupt files */ }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * The set of session ids that still "exist" from any authoritative source:
 * the in-memory registry (slots + aliases, keys and values), transcript files
 * under ~/.claude/projects, and the ~/.claude/sessions/*.json files Claude
 * leaves behind. A session present in NONE of these is unreachable from the
 * dashboard — genuinely gone — and its events are safe to purge.
 *
 * These are all filesystem/registry signals, never "no transcript" alone: a
 * session created without a Claude turn still lives in the registry, so it is
 * always kept.
 */
function knownSessionIds(): Set<string> {
  const known = new Set<string>();
  for (const slot of slots.values()) known.add(slot.meta.sessionId);
  for (const [alias, target] of aliases.entries()) { known.add(alias); known.add(target); }
  if (existsSync(PROJECTS_DIR)) {
    try {
      for (const proj of readdirSync(PROJECTS_DIR)) {
        try {
          for (const f of readdirSync(join(PROJECTS_DIR, proj))) {
            if (f.endsWith(".jsonl")) known.add(f.slice(0, -".jsonl".length));
          }
        } catch { /* not a dir / unreadable */ }
      }
    } catch { /* ignore */ }
  }
  if (existsSync(CLAUDE_SESSIONS_DIR)) {
    try {
      for (const name of readdirSync(CLAUDE_SESSIONS_DIR)) {
        if (!name.endsWith(".json")) continue;
        try {
          const body = JSON.parse(readFileSync(join(CLAUDE_SESSIONS_DIR, name), "utf-8")) as Record<string, unknown>;
          if (typeof body?.sessionId === "string") known.add(body.sessionId);
        } catch { /* skip corrupt */ }
      }
    } catch { /* ignore */ }
  }
  return known;
}

/**
 * Boot-time reconciliation: purge events for sessions that no longer exist by
 * any authoritative signal (see knownSessionIds). This self-heals the DB after
 * a session was deleted before delete-time purging existed, and cleans up
 * short-lived "pending-*" ids whose events never mapped to a real session.
 *
 * Called once from server startup AFTER the ingestor has drained events.jsonl
 * (so replayed rows aren't purged and immediately re-added). Best-effort:
 * failures are logged, never fatal.
 */
export function reconcileOrphanEvents(): { deleted: number; sessions: number } {
  bootActiveSessions();
  try {
    const known = knownSessionIds();
    const orphans = listEventSessionIds().filter((s) => !known.has(s));
    if (orphans.length === 0) return { deleted: 0, sessions: 0 };
    const { deleted } = deleteEventsForSessions(orphans);
    log.info("active-sessions", "boot sweep purged events for orphaned sessions", {
      sessions: orphans.length, deleted,
    });
    return { deleted, sessions: orphans.length };
  } catch (err) {
    log.warn("active-sessions", "orphan-events reconciliation skipped", { err: String((err as any)?.message ?? err) });
    return { deleted: 0, sessions: 0 };
  }
}

/**
 * Drain all live sessions on process shutdown. Each subprocess gets the same
 * grace path as endSession (close stdin, wait, then SIGTERM), but we run them
 * in parallel with a tight overall budget so the container exits within its
 * stop_grace_period. Called from server.ts on SIGTERM/SIGINT.
 *
 * Critically, this does NOT remove slots from the registry. endSession()
 * deletes a slot on purpose (the user asked to end it); a shutdown drain
 * must preserve the slot so the child.close handler sets status="ended"
 * and saveCheckpoint() writes a non-empty active-sessions.json. The next
 * sandbox boot then re-loads those slots as dormant and the dashboard
 * surfaces them in /api/sessions for resume.
 */
export async function shutdownActiveSessions(): Promise<void> {
  const ids = Array.from(slots.keys());
  await Promise.all(ids.map(async (id) => {
    const slot = slots.get(id);
    if (!slot) return;
    try {
      if (slot.stdin && !slot.stdin.destroyed) slot.stdin.end();
    } catch { /* ignore */ }
    if (slot.child && !slot.child.killed) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { slot.child!.kill("SIGTERM"); } catch { /* ignore */ }
          resolve();
        }, 5000);
        slot.child!.once("close", () => { clearTimeout(t); resolve(); });
      });
    }
  }));
  // Authoritative final write. The per-child close handler also calls
  // saveCheckpoint, but the order across parallel drains is racey; this
  // guarantees the on-disk file matches the post-drain slot map.
  saveCheckpoint();
}

export async function endSession(sessionId: string): Promise<void> {
  const slot = getSlot(sessionId);
  if (!slot) return;
  const canonicalId = slot.meta.sessionId;
  try {
    if (slot.stdin && !slot.stdin.destroyed) slot.stdin.end();
  } catch { /* ignore */ }
  if (slot.child && !slot.child.killed) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { slot.child!.kill("SIGTERM"); } catch { /* ignore */ }
        resolve();
      }, 5000);
      slot.child!.once("close", () => { clearTimeout(t); resolve(); });
    });
  }
  slots.delete(canonicalId);
  // Clean up aliases pointing at this canonical id
  for (const [alias, target] of aliases.entries()) {
    if (target === canonicalId) aliases.delete(alias);
  }
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId: canonicalId, status: "ended" });
}

// ---------- Internal ----------

interface SpawnOpts {
  cwd: string;
  label: string;
  displayName?: string | null;
  /**
   * Optional model override. Passed to `claude --model <value>`. Accepts
   * CLI aliases (opus/sonnet/haiku) or full model IDs. When null/undefined
   * the user's default model selection wins.
   */
  model?: string | null;
  via: "new-conversation" | "skill" | "resumed";
  runId: string | null;
  resumeSessionId: string | null;
  /**
   * When resumeSessionId is null, start a brand-new session under THIS exact id
   * (via `--session-id`) instead of minting a random UUID. Used to revive a
   * dormant slot that has no transcript yet: the session keeps its id (the
   * dashboard is watching it) but begins a fresh conversation. Ignored when
   * resumeSessionId is set.
   */
  freshSessionId?: string | null;
  /**
   * Carry-over cumulative stats from the previous incarnation of this
   * session (used when waking a dormant slot). The new spawn's meta
   * seeds its lastStats with this value so token + turn totals
   * accumulate across dormant→awake cycles instead of resetting.
   */
  carryStats?: LastStats | null;
  /**
   * Synthetic plan reviews from the dormant slot being revived. Seeded into the
   * fresh slot's pendingRequests so a plan awaiting approval survives the
   * wake→respawn cycle (the old slot is discarded when the new one registers).
   */
  carryPending?: PendingPermissionRequest[] | null;
}

const MAX_CONTROLLABLE_SESSIONS = parseInt(process.env.HOOP_MAX_CONTROLLABLE_SESSIONS ?? "", 10) || 50;

/** Thrown when the controllable-session cap is exceeded. Translate to 429 in server.ts. */
export class TooManyControllableSessionsError extends Error {
  constructor() {
    super("max controllable sessions");
    this.name = "TooManyControllableSessionsError";
  }
}

function liveSlotCount(): number {
  let n = 0;
  for (const s of slots.values()) {
    if (s.meta.status !== "ended" && s.meta.status !== "expired") n += 1;
  }
  return n;
}

async function spawnControllable(opts: SpawnOpts): Promise<{ sessionId: string; meta: ActiveSessionMeta }> {
  if (liveSlotCount() >= MAX_CONTROLLABLE_SESSIONS) {
    throw new TooManyControllableSessionsError();
  }
  const args: string[] = [];

  // Load every installed plugin so hooks fire (see lib/spawn.ts comment).
  for (const dir of discoverInstalledPluginDirs()) {
    args.push("--plugin-dir", dir);
  }
  args.push("-p");
  args.push("--input-format=stream-json", "--output-format=stream-json", "--verbose");
  // bypassPermissions skips Claude's built-in permission policy (including
  // the hardcoded "sensitive file" check on `.claude/` paths that an
  // explicit hook `allow` can't override). Our PreToolUse permission-gate
  // hook then becomes the SOLE gate — it short-circuits known-safe tools
  // and long-polls the dashboard for everything else. If the hook is
  // unreachable or times out, the gate defaults to DENY (not pass-through),
  // so the agent can never bypass the dashboard without explicit approval.
  args.push("--permission-mode", "bypassPermissions");
  // Standing plan-mode steering (invisible to the transcript, inert outside plan
  // mode). Headless drops the native ExitPlanMode the built-in plan prompt tells
  // the model to use, so without this the model often ends a plan turn by writing
  // the plan as prose and never calls the MCP submit_plan — nothing is captured
  // and no plan panel appears. See PLAN_SYSTEM_PROMPT.
  args.push("--append-system-prompt", PLAN_SYSTEM_PROMPT);
  if (opts.model) args.push("--model", opts.model);
  // A dashboard session's id is OURS, chosen here and stable for its whole life.
  // For a fresh session we mint a UUID and force claude to adopt it via
  // `--session-id`, so `ctx.session_id` on every hook/frame matches it from the
  // first frame — no `pending-` placeholder, no id swap, no alias dance. (This
  // is why the old provisional-id machinery existed: before --session-id we
  // couldn't know claude's id until its first post-input frame.) On resume we
  // reuse the existing id via `--resume`, which preserves it. `let` because the
  // defensive swap block below can still reassign it if claude ever reports a
  // different id (resume edge cases).
  let sessionId = opts.resumeSessionId ?? opts.freshSessionId ?? randomUUID();
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
    // Defensive: `claude --resume` has historically been able to mint a NEW
    // session_id in print mode, producing a ~200ms window where the cache sees
    // an undecorated orphan row. listSessions() suppresses that orphan while
    // this marker is live. Cleared on id swap (below) or on expiry.
    markResumeInFlight(opts.cwd);
  } else {
    args.push("--session-id", sessionId);
  }

  const child = spawn("claude", args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("spawn: missing stdio pipes");
  }

  const startedAt = Date.now();

  const meta: ActiveSessionMeta = {
    sessionId,
    runId: opts.runId,
    label: opts.label,
    displayName: opts.displayName ?? null,
    cwd: opts.cwd,
    via: opts.via,
    startedAt,
    lastSeenAt: startedAt,
    status: "alive",
    model: opts.model ?? null,
    pid: child.pid,
    // Carry over cumulative stats from a previous incarnation (set by
    // wakeSession). Without this, every dormant→awake cycle would
    // reset the running totals; the dashboard's StatsStrip would
    // ratchet down to "turns: 0" on every reactivation.
    ...(opts.carryStats ? { lastStats: opts.carryStats } : {}),
  };

  const slot: LiveSlot = {
    meta,
    child,
    stdin: child.stdin as Writable,
    writeQueue: Promise.resolve(),
    outBuf: "",
    outBufBytes: 0,
    // Seed with any plan review carried over from the dormant slot we're
    // reviving (wakeSession → carryPending). Fresh spawns pass nothing.
    pendingRequests: opts.carryPending ? opts.carryPending.map((r) => ({ ...r })) : [],
    pendingAuthors: [],
    currentTurn: null,
    trustedShareIds: new Set(),
    // A resume spawn can fail at runtime (corrupt/unreadable transcript); mark
    // it so writeUserTurn can detect a frame-less early exit and recover.
    resumeSpawn: !!opts.resumeSessionId,
  };

  // Hook the stdout parser. We're after sessionId discovery + result frames.
  child.stdout.setEncoding("utf-8");
  let lineBuf = "";
  child.stdout.on("data", (chunk: string) => {
    appendOut(slot, chunk);
    lineBuf += chunk;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const frame = JSON.parse(line);
        // First valid frame → the subprocess is alive and emitting. This is the
        // signal that a `--resume` actually took (vs dying before it read stdin).
        // Notify any waiter so it can stop watching for an early death.
        if (!slot.sawFirstFrame) {
          slot.sawFirstFrame = true;
          try { slot.notifyFirstFrame?.(); } catch { /* ignore */ }
          slot.notifyFirstFrame = undefined;
        }
        // `control_request` frames are claude's stream-json mechanism for
        // asking the wrapper a question — primarily tool-permission asks
        // (`subtype: can_use_tool`). The model pauses until we write a
        // matching `control_response` to stdin. We capture them as
        // `PermissionRequest` events so the dashboard can render an
        // interactive card and call back to /sessions/:id/permission.
        if (frame.type === "control_request" && typeof frame.request_id === "string") {
          const req = frame.request ?? {};
          if (req.subtype === "can_use_tool" && typeof req.tool_name === "string") {
            const pending: PendingPermissionRequest = {
              requestId: frame.request_id,
              toolUseId: typeof frame.tool_use_id === "string" ? frame.tool_use_id : null,
              toolName: req.tool_name,
              input: req.input ?? null,
              decisionReason: typeof req.decision_reason === "string" ? req.decision_reason : null,
              receivedAt: Date.now(),
              author: slot.currentTurn?.author ?? "host",
              shareId: slot.currentTurn?.shareId ?? null,
            };
            slot.pendingRequests.push(pending);
            const eventLine = JSON.stringify({
              ts: new Date().toISOString(),
              hook: "PermissionRequest",
              ctx: {
                session_id: slot.meta.sessionId,
                tool_name: pending.toolName,
                tool_input: typeof pending.input === "string"
                  ? pending.input
                  : safeJson(pending.input),
                request_id: pending.requestId,
                tool_use_id: pending.toolUseId,
                decision_reason: pending.decisionReason,
                author: pending.author,
              },
            });
            try { ingestEventLine(eventLine); } catch (e) {
              log.warn("active-sessions", "permission request ingest failed", { err: String((e as any)?.message ?? e) });
            }
          }
          continue;
        }

        // Track the plan text as a fallback for a submit_plan/ExitPlanMode call
        // that carries an empty `plan` arg. Prefer an ExitPlanMode tool_use's
        // `plan` arg (the authoritative plan); otherwise fall back to the
        // assistant's prose. `<synthetic>` frames are NOT the model talking —
        // they're client-side notices (usage limits, "(no content)") — so they
        // must never be mistaken for a plan; leave lastAssistantText untouched.
        if (frame.type === "assistant" && frame.message && Array.isArray(frame.message.content)) {
          if (frame.message.model !== "<synthetic>") {
            const content = frame.message.content as any[];
            const exitPlan = content.find(
              (c) => c && c.type === "tool_use" && c.name === "ExitPlanMode" &&
                     c.input && typeof c.input.plan === "string" && c.input.plan.trim(),
            );
            if (exitPlan) {
              slot.lastAssistantText = exitPlan.input.plan as string;
            } else {
              const txt = content
                .filter((c) => c && c.type === "text" && typeof c.text === "string")
                .map((c) => c.text as string)
                .join("")
                .trim();
              if (txt) slot.lastAssistantText = txt;
            }
          }
        }

        // Defensive id-swap. A new session owns its id via --session-id and a
        // resume reuses its id, so a frame's session_id normally equals ours.
        // The one case that can still differ: `claude --resume <id>` minting a
        // *new* session_id under the hood (observed in some print-mode versions)
        // — without handling it, future writes would hit the old (dead) slot. We
        // adopt the new id and keep the old one as an alias so in-flight requests
        // and the client's `selected` URL/state still resolve.
        if (typeof frame.session_id === "string" && frame.session_id !== sessionId) {
          const oldId = sessionId;
          sessionId = frame.session_id;
          slots.delete(oldId);
          slot.meta.sessionId = sessionId;
          slots.set(sessionId, slot);
          aliases.set(oldId, sessionId);
          // Re-point any existing aliases that pointed to oldId so the map
          // stays flat. Without this, a session that swaps twice (id-A → id-B →
          // id-C) would leave id-A resolving to the deleted "id-B" slot.
          for (const [k, v] of aliases.entries()) {
            if (v === oldId) aliases.set(k, sessionId);
          }
          saveCheckpoint();
          // The id has settled — getActiveSession(newId) now resolves and the
          // cache row gets decorated, so the resume-in-flight suppression
          // window for this cwd can close.
          clearResumeInFlight(slot.meta.cwd);
          activeSessionsBus.emit("change", { sessionId, status: "alive", aliasFrom: oldId });
        }

        // Built-in slash commands (/cost, /clear, /compact, ...) bypass the
        // normal Stop-hook ingest. Surface their output ourselves.
        //   - /cost, /help-like → synthetic ASSISTANT frame with model
        //     "<synthetic>" and a content array. Ingest the text as a Stop.
        //   - /clear            → synthetic ASSISTANT frame with literal
        //     "(no content)". Tag as kind=cleared so the renderer shows
        //     "Conversation cleared" rather than a blank line.
        //   - /compact          → synthetic USER frame (isSynthetic: true,
        //     isReplay: false) whose `content` IS the new compacted summary.
        //     Tag as kind=compaction; the renderer shows a collapsed notice.
        const synthCtx = (() => {
          if (
            frame.type === "assistant"
            && frame.message
            && frame.message.model === "<synthetic>"
            && Array.isArray(frame.message.content)
          ) {
            const text = frame.message.content
              .filter((c: any) => c?.type === "text" && typeof c.text === "string")
              .map((c: any) => c.text)
              .join("\n");
            if (!text) return null;
            const isCleared = text.trim() === "(no content)";
            // An API failure (usage/rate limit, overload) arrives as a synthetic
            // assistant frame carrying the error CLASS at the frame's top level
            // (`error: "rate_limit"`). Verified against the live stream — note
            // the session .jsonl uses isApiErrorMessage/apiErrorStatus instead,
            // and those are absent here, so don't reach for them.
            // Tagged kind=error (not the kind=info catch-all, which also covers
            // benign notices like /cost output) so the transcript can show it as
            // a failure rather than as something the model said.
            const errKind = typeof frame.error === "string" && frame.error.trim() ? frame.error.trim() : null;
            return {
              kind: errKind ? ("error" as const) : isCleared ? ("cleared" as const) : ("info" as const),
              text: isCleared ? "Conversation cleared." : text,
              error: errKind,
            };
          }
          if (
            frame.type === "user"
            && frame.isSynthetic === true
            && frame.isReplay !== true
            && frame.message
          ) {
            // The summary lives in message.content as a string (compact) or
            // as an array of content blocks (defensive parse).
            const c = frame.message.content;
            let text = "";
            if (typeof c === "string") text = c;
            else if (Array.isArray(c)) {
              text = c
                .map((b: any) => (typeof b === "string" ? b : (b?.text ?? "")))
                .filter((s: string) => !!s)
                .join("\n");
            }
            if (!text) return null;
            return { kind: "compaction" as const, text, error: null };
          }
          return null;
        })();
        if (synthCtx) {
          try {
            ingestEventLine(JSON.stringify({
              ts: new Date().toISOString(),
              hook: "Stop",
              ctx: {
                session_id: frame.session_id ?? sessionId,
                hook_event_name: "Stop",
                last_assistant_message: synthCtx.text,
                synthetic: true,
                kind: synthCtx.kind,
                ...(synthCtx.error ? { error: synthCtx.error } : {}),
              },
            }));
          } catch (err) {
            log.warn("active-sessions", "synthetic ingest failed", { err });
          }
        }

        // System/init frame is the FIRST frame of every turn — it carries
        // model + permissionMode (claude's name for "mode": default/plan/etc).
        // We treat it as authoritative for those two fields and let the
        // result frame fill in usage + duration at end-of-turn. Keep
        // existing lastStats fields when a key is missing so the header
        // stays populated across model swaps mid-conversation.
        if (frame.type === "system" && (frame.subtype === "init" || !frame.subtype)) {
          const existing = slot.meta.lastStats ?? { v: 1 as const };
          slot.meta.lastStats = {
            ...existing,
            v: 1,
            model: typeof frame.model === "string" ? frame.model : existing.model,
            mode: typeof frame.permissionMode === "string" ? frame.permissionMode
                  : typeof frame.output_style === "string" ? frame.output_style
                  : existing.mode,
          };
        }

        if (frame.type === "result") {
          slot.meta.lastSeenAt = Date.now();
          // Capture usage + turn duration. Claude's result frame shape:
          //   { type: "result", duration_ms: 3214, usage: { input_tokens,
          //     cache_creation_input_tokens, cache_read_input_tokens,
          //     output_tokens, ... }, ... }
          // We defensively coerce to the shape the dashboard expects and
          // drop everything else.
          const u = (frame.usage ?? {}) as Record<string, unknown>;
          const pickInt = (k: string): number | undefined => {
            const v = u[k];
            return typeof v === "number" && Number.isFinite(v) ? v : undefined;
          };
          const existing = slot.meta.lastStats ?? { v: 1 as const };
          const turnUsage = {
            input_tokens: pickInt("input_tokens"),
            cache_creation_input_tokens: pickInt("cache_creation_input_tokens"),
            cache_read_input_tokens: pickInt("cache_read_input_tokens"),
            output_tokens: pickInt("output_tokens"),
          };
          const prevTotals = existing.totals ?? {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            turns: 0,
          };
          // Synthetic / no-op turns (claude-mem observer frames, `<synthetic>`
          // model frames, the empty trailing frame claude sometimes emits)
          // report an all-zero usage block. Those must NOT overwrite the real
          // per-turn `usage` — it drives the context-fill % — nor inflate the
          // turn counter. Only a turn that actually consumed tokens updates
          // usage/totals; everything else just bumps lastSeenAt.
          const turnTotal =
            (turnUsage.input_tokens ?? 0) +
            (turnUsage.cache_creation_input_tokens ?? 0) +
            (turnUsage.cache_read_input_tokens ?? 0) +
            (turnUsage.output_tokens ?? 0);
          if (turnTotal > 0) {
            slot.meta.lastStats = {
              ...existing,
              v: 1,
              usage: turnUsage,
              turnDurationMs: typeof frame.duration_ms === "number" ? frame.duration_ms : undefined,
              turnEndedAt: Date.now(),
              totals: {
                input_tokens: prevTotals.input_tokens + (turnUsage.input_tokens ?? 0),
                cache_creation_input_tokens:
                  prevTotals.cache_creation_input_tokens + (turnUsage.cache_creation_input_tokens ?? 0),
                cache_read_input_tokens:
                  prevTotals.cache_read_input_tokens + (turnUsage.cache_read_input_tokens ?? 0),
                output_tokens: prevTotals.output_tokens + (turnUsage.output_tokens ?? 0),
                turns: prevTotals.turns + 1,
              },
            };
          }
          // The result frame is the subprocess's authoritative end-of-turn, so
          // the "model is thinking" indicator clears HERE — not only on the Stop
          // HOOK (server.ts /ingest → markTurnFinished). A turn that dies before
          // the model ever runs (usage limit, auth failure) emits no Stop hook at
          // all, so relying on the hook alone left every viewer's indicator
          // spinning forever. Observed live on a rate_limit turn. The emit below
          // carries the cleared flag out to all viewers.
          slot.meta.turnActive = false;
          saveCheckpoint();
          activeSessionsBus.emit("turn", { sessionId, result: frame.result });

          // Plan-mode turn ended — reset per-turn plan state. A plan review is
          // surfaced ONLY when the model explicitly calls submit_plan/ExitPlanMode
          // (captured deterministically at the gate). We deliberately do NOT
          // synthesize a review from the turn's final prose: it misfired on
          // conversational replies — a decline, a clarifying question, or an
          // acknowledgment after a rejection all became spurious Plan cards.
          slot.planTurnActive = false;
          // Close the approved-plan auto-allow window at turn end.
          slot.autoAllowPlanRun = false;
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  });

  child.stderr.setEncoding("utf-8");
  // Match patterns claude emits on Anthropic-rejected OAuth. We sniff each
  // stderr chunk; first match wins to avoid spamming the bus on retries.
  // Patterns are intentionally generous — claude's exact error text changes
  // between versions, but all current variants name "auth" or "401" plainly.
  // Negative match guards: explicitly skip the harmless "refresh succeeded"
  // log that claude emits when it silently rotates a near-expiry token.
  const AUTH_FAIL_RE = /\b(401|unauthorized|invalid[_ -]?authentication|invalid[_ -]?credentials|auth(?:entication)?[_ ]?(?:error|failed)|please[_ ]?run[_ ]?claude[_ ]?login)\b/i;
  const REFRESH_OK_RE = /\b(refresh[_ ]?(?:succeeded|completed)|token[_ ]?refreshed)\b/i;
  let authFailReported = false;
  child.stderr.on("data", (data: string) => {
    appendOut(slot, `[stderr] ${data}`);
    if (
      !authFailReported &&
      AUTH_FAIL_RE.test(data) &&
      !REFRESH_OK_RE.test(data)
    ) {
      authFailReported = true;
      activeSessionsBus.emit("error", {
        sessionId,
        kind: "auth",
        message: "sandbox authentication failed — run `claude login` on host",
      });
      log.warn("active-sessions", "auth failure detected from claude stderr", {
        sessionId,
        snippet: data.slice(0, 200),
      });
    }
  });

  child.on("error", (err) => {
    slot.meta.status = "error";
    slot.meta.errorMessage = err.message;
    activeSessionsBus.emit("error", { sessionId, message: err.message });
    saveCheckpoint();
  });

  child.on("close", (code) => {
    slot.meta.exitCode = code;
    // The child is gone → no turn can be in flight. Clear the flag regardless
    // of why it exited (turn end, /stop, /model, crash, shutdown).
    const wasTurnActive = slot.meta.turnActive === true;
    slot.meta.turnActive = false;
    // If the slot is still in the registry (i.e. the user didn't explicitly
    // endSession(), which deletes it), the subprocess exited on its own.
    // In print mode that's the NORMAL between-turns state: claude finishes a
    // turn and exits; the next writeUserTurn revives it via --resume. Surface
    // a clean exit (code 0) or a signal kill (null, e.g. shutdown drain) as
    // "dormant" — idle and resumable — so a freshly-answered session doesn't
    // read as dead in the sidebar/header. Reserve "ended" for a genuinely
    // abnormal (non-zero) exit.
    if (slots.has(sessionId)) {
      if (slot.suppressDormantOnce) {
        // Intentional, self-recovering kill (`/stop`, `/model`): the child is
        // gone but the next writeUserTurn revives it via --resume. Keep the
        // visible lifecycle "alive" so the sidebar/composer don't flip to
        // dormant/ended for a user-initiated restart. NB we ignore the exit
        // code here — a SIGTERM kill of claude exits non-zero, which would
        // otherwise read as "ended"; the flag (set only right before our own
        // kill) is the authoritative signal that this exit was deliberate.
        // One-shot — clear it so a later genuine exit still transitions. We
        // don't emit "change" (that would signal a lifecycle transition), but
        // we DO nudge a sessions refresh so the cleared turnActive reaches
        // viewers and the thinking indicator turns off promptly.
        slot.suppressDormantOnce = false;
        saveCheckpoint();
        if (wasTurnActive) activeSessionsBus.emit("turn", { sessionId });
      } else {
        // Clean exit (code 0) or signal kill (null, e.g. shutdown drain) is the
        // normal idle-between-turns state → "dormant"; reserve "ended" for a
        // genuinely abnormal non-zero exit. An idle-TTL reap forces "dormant"
        // regardless of code (claude exits non-zero on our SIGTERM).
        const reaped = slot.reapToDormant === true;
        slot.reapToDormant = false;
        const nextStatus: LifecycleStatus = reaped || code === 0 || code === null ? "dormant" : "ended";
        slot.meta.status = nextStatus;
        saveCheckpoint();
        activeSessionsBus.emit("change", { sessionId, status: nextStatus, exitCode: code });
      }
    }
  });

  // Register the slot under the id we own (passed to claude via --session-id, or
  // the resume id). It's the session's real, stable id from this moment — no
  // provisional/pending phase — so it's immediately writable, listable, and
  // shareable, before claude emits any frame.
  slots.set(sessionId, slot);
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId, status: "alive" });

  return { sessionId, meta: { ...slot.meta } };
}

async function doWrite(sessionId: string, text: string, images?: TurnImage[]): Promise<void> {
  const slot = slots.get(sessionId);
  if (!slot || !slot.stdin || slot.stdin.destroyed) {
    throw new Error(`session not writable: ${sessionId}`);
  }
  // Build the Messages-API content array: image blocks first (recommended
  // ordering for vision), then the text. `claude -p --input-format=stream-json`
  // accepts base64 image blocks and the model interprets them (verified).
  const content: Array<Record<string, unknown>> = [];
  for (const img of images ?? []) {
    content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
  }
  if (text || content.length === 0) content.push({ type: "text", text });
  const frame = JSON.stringify({
    type: "user",
    message: { role: "user", content },
  }) + "\n";
  await new Promise<void>((resolve, reject) => {
    slot.stdin!.write(frame, "utf-8", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  slot.meta.lastSeenAt = Date.now();
  saveCheckpoint();
}

/**
 * Write a stream-json `control_request` to the subprocess stdin — used to flip
 * permission mode (`set_permission_mode`) for a `/plan` turn. Ordered on the
 * same pipe as user turns, so a mode change enqueued before a turn is applied
 * first. claude answers with a matching `control_response` on stdout, which our
 * stdout parser ignores (it only acts on inbound `can_use_tool` asks) — harmless.
 */
async function doWriteControl(sessionId: string, request: Record<string, unknown>): Promise<void> {
  const slot = slots.get(sessionId);
  if (!slot || !slot.stdin || slot.stdin.destroyed) {
    throw new Error(`session not writable: ${sessionId}`);
  }
  const frame = JSON.stringify({ type: "control_request", request_id: randomUUID(), request }) + "\n";
  await new Promise<void>((resolve, reject) => {
    slot.stdin!.write(frame, "utf-8", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function appendOut(slot: LiveSlot, data: string) {
  slot.outBuf += data;
  slot.outBufBytes += Buffer.byteLength(data, "utf-8");
  if (slot.outBuf.length > MAX_OUT_BYTES) {
    const overflow = slot.outBuf.length - MAX_OUT_BYTES;
    slot.outBuf = "…[truncated]…\n" + slot.outBuf.slice(overflow);
  }
}

// ---------- Checkpoint ----------

interface CheckpointFile {
  version: number;
  savedAt: string;
  sessions: Array<{
    sessionId: string;
    runId: string | null;
    label: string;
    displayName?: string | null;
    cwd: string;
    via: ActiveSessionMeta["via"];
    startedAt: number;
    lastSeenAt: number;
    // Configured `--model` override, re-applied on every resume. Optional for
    // backwards compat with files written before the field existed.
    model?: string | null;
    // Historical ids that have been remapped to this canonical session.
    // Persisting them lets the dashboard's "transcript spans alias swaps"
    // behaviour survive a sandbox restart — without this, the in-memory
    // aliases map dies on shutdown and a reload-after-restart loses the
    // link between the URL's old session_id and the post-resume canonical
    // id. Optional for backwards compat with v1 files that pre-date it.
    aliases?: string[];
    // Per-turn telemetry from the most recent result frame (model, mode,
    // usage, duration). Persisted so dashboard reloads can render the
    // stats header without waiting for a fresh turn.
    lastStats?: LastStats;
    // Outstanding SYNTHETIC plan reviews (see PendingPermissionRequest.synthetic).
    // Unlike live permission asks — which are bound to a running child that a
    // restart kills, so they're intentionally dropped — a synthetic review has
    // no hook waiting on it and is answered by dispatching a follow-up turn. It
    // must survive restart/revive so a plan the user was about to approve isn't
    // silently lost. Optional; absent on v1 files and sessions with no review.
    pendingReviews?: PendingPermissionRequest[];
  }>;
}

function saveCheckpoint() {
  try {
    mkdirSync(dirname(CHECKPOINT_FILE), { recursive: true });
    // Persist only sessions worth reviving: alive + ended (could be resumed);
    // skip expired (already broken).
    const sessions = Array.from(slots.values())
      .filter((s) => s.meta.status !== "expired")
      .map((s) => {
        const al = aliasesFor(s.meta.sessionId);
        const reviews = pendingReviewsOf(s);
        return {
          sessionId: s.meta.sessionId,
          runId: s.meta.runId,
          label: s.meta.label,
          displayName: s.meta.displayName,
          cwd: s.meta.cwd,
          via: s.meta.via,
          startedAt: s.meta.startedAt,
          lastSeenAt: s.meta.lastSeenAt,
          ...(s.meta.model ? { model: s.meta.model } : {}),
          ...(al.length > 0 ? { aliases: al } : {}),
          ...(s.meta.lastStats ? { lastStats: s.meta.lastStats } : {}),
          ...(reviews.length > 0 ? { pendingReviews: reviews } : {}),
        };
      });
    const body: CheckpointFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      sessions,
    };
    writeFileSync(CHECKPOINT_TMP, JSON.stringify(body, null, 2), "utf-8");
    renameSync(CHECKPOINT_TMP, CHECKPOINT_FILE);
  } catch (err) {
    log.error("active-sessions", "checkpoint save failed", { err });
  }
}

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return;
  let body: CheckpointFile;
  try {
    body = JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8"));
  } catch (err) {
    log.warn("active-sessions", "could not parse checkpoint, ignoring", { err });
    return;
  }
  const now = Date.now();
  let pruned = 0;
  let migrated = 0;
  for (const entry of body.sessions ?? []) {
    // Prune old entries
    if (now - entry.lastSeenAt > PRUNE_AGE_MS) {
      pruned++;
      continue;
    }

    // One-shot cwd migration: the old container layout used `/workspace`
    // for the session workdir, which is now reserved for plugin source
    // (moved to /opt/hoop) and isn't writable by the agent user.
    // Rewrite stale checkpoints so previously-created sessions stay alive.
    if (entry.cwd === "/workspace") {
      entry.cwd = "/home/agent/workspace";
      migrated++;
    }

    // Re-apply cwd policy at boot time. If HOOP_CWD_ROOTS was tightened
    // or the checkpoint was tampered with, the entry must not be revived.
    const cwdCheck = isCwdAllowed(entry.cwd);
    if (!cwdCheck.ok) {
      log.warn("active-sessions", "dormant session cwd no longer allowed; pruning", {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        reason: cwdCheck.reason,
      });
      pruned++;
      continue;
    }

    // Don't prune based on transcript existence at boot. A session spawned
    // but not yet written-to has no transcript file yet, and dropping it
    // here means the user can never resume that fresh session after a
    // restart. wakeSession will surface "no transcript / --resume failed"
    // lazily if the conversation is truly unrecoverable.
    const meta: ActiveSessionMeta = {
      sessionId: entry.sessionId,
      runId: entry.runId,
      label: entry.label,
      displayName: entry.displayName ?? null,
      cwd: entry.cwd,
      via: entry.via,
      startedAt: entry.startedAt,
      lastSeenAt: entry.lastSeenAt,
      status: "dormant",
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.lastStats ? { lastStats: entry.lastStats } : {}),
    };
    slots.set(entry.sessionId, {
      meta,
      writeQueue: Promise.resolve(),
      outBuf: "",
      outBufBytes: 0,
      // Restore only synthetic plan reviews (see CheckpointFile.pendingReviews).
      // Filter defensively: a hand-edited checkpoint must not smuggle in a
      // non-synthetic "pending ask" with no hook behind it.
      pendingRequests: (entry.pendingReviews ?? []).filter((r) => r && r.synthetic),
      pendingAuthors: [],
      currentTurn: null,
      trustedShareIds: new Set(),
    });
    // Restore historical aliases. Each entry.aliases id is an "old id"
    // that previously resolved to entry.sessionId — we re-key the in-memory
    // alias map so future getSlot() lookups on old ids hit the right slot,
    // and so aliasesFor() returns the same list it would have before the
    // shutdown. Without this the dashboard's transcript loses continuity
    // for any session that swapped ids before restart.
    for (const oldId of entry.aliases ?? []) {
      aliases.set(oldId, entry.sessionId);
    }
  }
  if (pruned > 0 || migrated > 0) saveCheckpoint();
  // The checkpoint cwd rewrite (above) is only half the migration: claude
  // files each transcript under ~/.claude/projects/<cwd-slug>/, so a session
  // whose cwd moved from /workspace to /home/agent/workspace also needs its
  // .jsonl relocated or `claude --resume` can't find the history and starts
  // a blank conversation. Run it unconditionally (idempotent) so it heals
  // even if the cwd rewrite already happened on a prior boot.
  const migratedTranscripts = migrateWorkspaceTranscripts();
  log.info("active-sessions", "booted", {
    dormant: slots.size,
    pruned,
    migrated,
    migratedTranscripts,
    aliases: aliases.size,
  });
}

/**
 * Claude's project-dir slug for a cwd: every `/` and `.` becomes `-`.
 * `/workspace` → `-workspace`; `/home/agent/workspace` → `-home-agent-workspace`.
 */
function projectDirForCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Move transcripts filed under the legacy `/workspace` project dir into the
 * new `/home/agent/workspace` project dir. Idempotent: only moves a file when
 * the target doesn't already exist, so it's safe to run on every boot and
 * under duplicate module instances. Returns the count moved.
 */
function migrateWorkspaceTranscripts(): number {
  const oldDir = join(PROJECTS_DIR, projectDirForCwd("/workspace"));
  const newDir = join(PROJECTS_DIR, projectDirForCwd("/home/agent/workspace"));
  if (!existsSync(oldDir)) return 0;
  let moved = 0;
  try {
    mkdirSync(newDir, { recursive: true });
    for (const name of readdirSync(oldDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const src = join(oldDir, name);
      const dst = join(newDir, name);
      if (existsSync(dst)) continue; // already migrated
      try {
        renameSync(src, dst);
      } catch (err: any) {
        // Cross-device (EXDEV) or similar: fall back to copy + unlink.
        if (err?.code === "EXDEV") {
          copyFileSync(src, dst);
          try { unlinkSync(src); } catch { /* leave original; target exists */ }
        } else {
          log.warn("active-sessions", "transcript migrate failed for one file", {
            file: name,
            err: String(err?.message ?? err),
          });
          continue;
        }
      }
      moved++;
    }
  } catch (err: any) {
    log.warn("active-sessions", "transcript migration error", { err: String(err?.message ?? err) });
  }
  return moved;
}

function safeJson(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Permission waiters — used by the hook-driven permission gate. When a
 * PreToolUse hook posts to /permission-ask, the sandbox creates a request
 * (calling `createPermissionRequest`) and the hook then long-polls
 * /permission-wait, which calls `awaitPermissionDecision`. When the
 * dashboard posts the user's allow/deny via /sessions/:id/permission
 * (the existing endpoint, which calls `respondToPermission`), the
 * matching waiter is resolved.
 *
 * Stored as a flat module-level map (NOT per-slot): a hook's requestId
 * is unique cluster-wide and the resolver doesn't need slot context.
 */
type PermissionResolver = (result: { decision: "allow" | "deny"; reason: string | null }) => void;
const permissionWaiters = new Map<string, PermissionResolver>();
// Decisions that landed before the hook started long-polling. Tiny race in
// practice (sub-millisecond between POST return and GET start), but the
// failure mode is a 30s hang for the user — so we stash early decisions
// and let the next awaitPermissionDecision consume them.
const earlyPermissionDecisions = new Map<string, { decision: "allow" | "deny"; reason: string | null }>();

// Pending asks for sessions with NO live slot. Standalone skill runs (spawn.ts
// spawns `claude -p` without registering a controllable slot) still fire the
// PreToolUse gate, which creates a request and blocks on it. Without a home for
// that request, getPendingRequests returns nothing: the dashboard shows a
// PermissionRequest event with no actionable card, the gate times out, and the
// run is silently denied. Track those here, keyed by session id.
const slotlessPending = new Map<string, PendingPermissionRequest[]>();

function dropSlotlessPending(sessionId: string, requestId: string): void {
  const list = slotlessPending.get(sessionId);
  if (!list) return;
  const next = list.filter((r) => r.requestId !== requestId);
  if (next.length) slotlessPending.set(sessionId, next);
  else slotlessPending.delete(sessionId);
}

/**
 * Register a permission request that originated from a hook (PreToolUse).
 * Adds it to the matching session's pendingRequests so the dashboard's
 * hydration endpoint sees it, ingests a `PermissionRequest` event so the
 * dashboard SSE picks it up, and returns the requestId the hook should
 * long-poll on.
 *
 * The hook tells us its own `requestId` (we use `tool_use_id` from the
 * PreToolUse payload). If the hook doesn't supply one, we mint a UUID.
 */
// ---------- Shared plan-review comments ----------
// Inline review comments on a plan, keyed by the plan review's requestId. Held
// in memory and shared across every participant in the session (host + peers)
// so a collaborative review is visible before anyone submits. Cleared when the
// plan is decided (respondToPermission) or the sandbox restarts — ephemeral by
// design. `offset`/`length` index into the RENDERED plan text so each client
// can pin the bubble on its own layout.
export interface PlanReviewReply {
  id: string;
  author: string | null;
  body: string;
  at: number;
}
export interface PlanReviewComment {
  id: string;
  author: string | null;
  quote: string;
  offset: number;
  length: number;
  body: string;
  replies: PlanReviewReply[];
  at: number;
}
const planReviewComments = new Map<string, PlanReviewComment[]>();

export function listPlanReviewComments(requestId: string): PlanReviewComment[] {
  return (planReviewComments.get(requestId) ?? []).map((c) => ({ ...c, replies: c.replies.map((r) => ({ ...r })) }));
}
export function addPlanReviewComment(opts: {
  requestId: string; author: string | null; quote: string; offset: number; length: number; body: string;
}): PlanReviewComment {
  const c: PlanReviewComment = {
    id: randomUUID(),
    author: opts.author,
    quote: opts.quote.slice(0, 400),
    offset: Math.max(0, Math.floor(opts.offset) || 0),
    length: Math.max(0, Math.floor(opts.length) || 0),
    body: opts.body.slice(0, 4000),
    replies: [],
    at: Date.now(),
  };
  const list = planReviewComments.get(opts.requestId) ?? [];
  list.push(c);
  planReviewComments.set(opts.requestId, list);
  return c;
}
export function addPlanReviewReply(opts: { requestId: string; commentId: string; author: string | null; body: string }): boolean {
  const c = planReviewComments.get(opts.requestId)?.find((x) => x.id === opts.commentId);
  if (!c) return false;
  c.replies.push({ id: randomUUID(), author: opts.author, body: opts.body.slice(0, 4000), at: Date.now() });
  return true;
}
// Edit/remove are author-scoped: only the participant who wrote a comment may
// change or delete it. Returns a status the HTTP layer maps to 200/403/404.
export type CommentMutation = "ok" | "notfound" | "forbidden";
export function editPlanReviewComment(requestId: string, commentId: string, requester: string | null, body: string): CommentMutation {
  const c = planReviewComments.get(requestId)?.find((x) => x.id === commentId);
  if (!c) return "notfound";
  if (c.author !== requester) return "forbidden";
  c.body = body.slice(0, 4000);
  return "ok";
}
export function removePlanReviewComment(requestId: string, commentId: string, requester: string | null): CommentMutation {
  const list = planReviewComments.get(requestId);
  const c = list?.find((x) => x.id === commentId);
  if (!list || !c) return "notfound";
  if (c.author !== requester) return "forbidden";
  const next = list.filter((x) => x.id !== commentId);
  if (next.length) planReviewComments.set(requestId, next);
  else planReviewComments.delete(requestId);
  return "ok";
}
function clearPlanReviewComments(requestId: string): void {
  planReviewComments.delete(requestId);
}

/**
 * Push a SYNTHETIC plan review (see PendingPermissionRequest.synthetic). Used
 * when a plan-mode turn ends without a blocking ExitPlanMode ask: the agent's
 * final message becomes the plan, surfaced to the dashboard as an ExitPlanMode
 * pending so the existing PlanPanel renders it unchanged. No hook waits on it.
 */
function pushPlanReview(slot: LiveSlot, planText: string): void {
  const pending: PendingPermissionRequest = {
    requestId: randomUUID(),
    toolUseId: null,
    toolName: "ExitPlanMode",
    input: { plan: planText },
    decisionReason: null,
    receivedAt: Date.now(),
    author: slot.currentTurn?.author ?? "host",
    shareId: slot.currentTurn?.shareId ?? null,
    synthetic: true,
  };
  slot.pendingRequests.push(pending);
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PermissionRequest",
      ctx: {
        session_id: slot.meta.sessionId,
        tool_name: "ExitPlanMode",
        tool_input: safeJson(pending.input),
        request_id: pending.requestId,
        tool_use_id: null,
        decision_reason: null,
        author: pending.author,
      },
    }));
  } catch (e) {
    log.warn("active-sessions", "plan review ingest failed", { err: String((e as any)?.message ?? e) });
  }
}

export function createPermissionRequest(opts: {
  sessionId: string;
  toolName: string;
  input: unknown;
  toolUseId?: string | null;
  requestId?: string | null;
  decisionReason?: string | null;
}): { requestId: string; sessionId: string } {
  const slot = getSlot(opts.sessionId);
  const canonicalSid = slot?.meta.sessionId ?? opts.sessionId;
  const requestId = opts.requestId || opts.toolUseId || randomUUID();
  // Normalize the bundled MCP ask tool (mcp__plugin_hoop_tools__ask_user_question)
  // to the native "AskUserQuestion" name, so the pending request — and everything
  // downstream keyed on toolName (dashboard AskQuestion UI, capability gating, the
  // deny+follow-up-turn answer relay) — treats it exactly like the native tool.
  const toolName = isAskUserQuestionTool(opts.toolName) ? "AskUserQuestion" : opts.toolName;
  // Attribute the ask to whoever drove the current turn (host or a peer).
  const turn = slot?.currentTurn ?? null;
  const pending: PendingPermissionRequest = {
    requestId,
    toolUseId: opts.toolUseId ?? null,
    toolName,
    input: opts.input,
    decisionReason: opts.decisionReason ?? null,
    receivedAt: Date.now(),
    author: turn?.author ?? "host",
    shareId: turn?.shareId ?? null,
    planMode: slot?.planTurnActive === true,
  };

  // Answer the hook immediately (its /permission-wait consumes this) without a
  // dashboard card. Used by the plan-mode gate and the non-plan Bash fast-lane.
  const decideNow = (decision: "allow" | "deny", reason: string): { requestId: string; sessionId: string } => {
    earlyPermissionDecisions.set(requestId, { decision, reason });
    setTimeout(() => earlyPermissionDecisions.delete(requestId), 60_000);
    return { requestId, sessionId: canonicalSid };
  };

  // ── Plan lifecycle tools ─────────────────────────────────────────────────
  // The model submits/enters plans via the bundled hoop MCP tools
  // (mcp__plugin_hoop_tools__{submit_plan,enter_plan_mode}); the native
  // ExitPlanMode name is matched too (it's absent in headless mode, but harmless
  // to keep). Handled up front, independent of plan-mode state, so a submitted
  // plan is ALWAYS captured. The PreToolUse deny blocks dispatch, so the MCP
  // handler never runs — all real behavior lives here.
  if (isPlanSubmitTool(opts.toolName)) {
    // Deterministic plan capture (replaces the heuristic result-frame path as the
    // primary): pull the plan from the tool input (or the turn's assistant prose),
    // surface it for review via pushPlanReview — the SAME review the dashboard
    // renders and inline comments/annotations attach to (keyed by its requestId)
    // — then DENY so the turn stops and holds for approval.
    const cur = pending.input;
    const planStr = cur && typeof cur === "object" ? (cur as { plan?: unknown }).plan : undefined;
    const planText = typeof planStr === "string" && planStr.trim()
      ? (planStr as string)
      : (slot?.lastAssistantText ?? "");
    if (slot && planText.trim()) pushPlanReview(slot, planText);
    return decideNow("deny", "Your plan has been submitted for review. Stop here — do not act until it is approved.");
  }
  if (isEnterPlanTool(opts.toolName)) {
    // Model-initiated plan mode: flip the session read-only for the rest of the
    // turn. Deny-with-guidance (the reason IS the model-facing instruction) keeps
    // the MCP server declaration-only.
    if (slot) slot.planTurnActive = true;
    return decideNow("deny", "Plan mode engaged — this session is now read-only. Investigate with Read/Grep/Glob, then call the submit_plan tool with your plan.");
  }

  // ── Plan-mode enforcement (hard read-only) ───────────────────────────────
  // While a `/plan` turn is active (slot.planTurnActive), the gate routes every
  // non-read tool here and we answer immediately, so the agent CANNOT mutate
  // until the plan is approved — enforcement is mechanical, not a prompt.
  // AskUserQuestion is carved out: clarifying questions don't mutate anything
  // (the answer is relayed back as a follow-up user turn), and they're most
  // useful DURING planning — to resolve a design decision before submitting the
  // plan. Let it fall through to the normal ask handling below, which surfaces
  // the dashboard question card. The answer relay (respondToPermission) reads
  // `pending.planMode` to keep the session in plan mode afterwards.
  if (slot?.planTurnActive && !isAskUserQuestionTool(opts.toolName)) {
    if (!PLAN_READONLY_TOOLS.has(opts.toolName)) {
      return decideNow(
        "deny",
        "Plan mode: this session is read-only until the plan is approved. Investigate with Read/Grep/Glob, then submit your plan with the submit_plan tool.",
      );
    }
    // A read-only tool that somehow reached here (the gate normally fast-allows
    // these): permit it — reads are safe in plan mode.
    return decideNow("allow", "read-only (plan mode)");
  }

  // ── Non-plan Bash fast-lane (moved out of permission-gate.sh) ─────────────
  // The gate no longer auto-allows Bash; keep it frictionless here — no card, no
  // transcript record — EXCEPT `git push`, which always escalates to the host.
  if (opts.toolName === "Bash") {
    const bashCmd = (pending.input as { command?: unknown } | null)?.command;
    if (!(typeof bashCmd === "string" && isGitPush(bashCmd))) {
      return decideNow("allow", "auto-allowed (bash)");
    }
    // git push → fall through to a dashboard prompt (host-only decision).
  }

  // Immediate auto-approve: hand the hook an allow when it long-polls
  // /permission-wait and record it in the transcript as an auto-approval. Does
  // NOT push to pendingRequests — no card surfaces for an auto-approved ask.
  const autoApprove = (reason: string) => {
    earlyPermissionDecisions.set(requestId, { decision: "allow", reason });
    setTimeout(() => earlyPermissionDecisions.delete(requestId), 60_000);
    try {
      ingestEventLine(JSON.stringify({
        ts: new Date().toISOString(),
        hook: "PermissionResponse",
        ctx: {
          session_id: canonicalSid,
          tool_name: pending.toolName,
          tool_input: typeof pending.input === "string" ? pending.input : safeJson(pending.input),
          request_id: requestId,
          tool_use_id: pending.toolUseId,
          decision: "allow",
          author: pending.author,
          auto: true,
        },
      }));
    } catch (e) {
      log.warn("active-sessions", "auto-approve ingest failed", { err: String((e as any)?.message ?? e) });
    }
    return { requestId, sessionId: canonicalSid };
  };

  // Approved-plan execution: the host already reviewed and approved this plan,
  // so its tool calls run WITHOUT re-prompting — no carve-out, git push
  // included. Scoped to the single execution turn (see slot.autoAllowPlanRun).
  if (slot?.autoAllowPlanRun) {
    return autoApprove("auto: approved plan");
  }

  // Session-scoped "allow all from $peer": if this ask comes from a turn driven
  // by a trusted peer, auto-approve without prompting the host — EXCEPT git
  // push, which always escalates to the host (the one hard guardrail).
  const command = (pending.input as { command?: unknown } | null)?.command;
  const isPush = typeof command === "string" && isGitPush(command);
  if (slot && pending.shareId && slot.trustedShareIds.has(pending.shareId) && !isPush) {
    return autoApprove("auto: trusted peer");
  }

  if (slot) {
    slot.pendingRequests.push(pending);
  } else {
    // No live slot → standalone skill run. Keep the ask actionable instead of
    // dropping it (see slotlessPending).
    const list = slotlessPending.get(canonicalSid) ?? [];
    list.push(pending);
    slotlessPending.set(canonicalSid, list);
    // Safety net: never-answered asks (gate timeout) shouldn't accumulate.
    setTimeout(() => dropSlotlessPending(canonicalSid, requestId), 130_000);
  }
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PermissionRequest",
      ctx: {
        session_id: canonicalSid,
        tool_name: pending.toolName,
        tool_input: typeof pending.input === "string" ? pending.input : safeJson(pending.input),
        request_id: pending.requestId,
        tool_use_id: pending.toolUseId,
        decision_reason: pending.decisionReason,
        author: pending.author,
      },
    }));
  } catch (e) {
    log.warn("active-sessions", "permission request ingest failed", { err: String((e as any)?.message ?? e) });
  }
  return { requestId, sessionId: canonicalSid };
}

/**
 * Wait for the dashboard to decide on a permission request. Returns the
 * decision on success or `{ decision: "timeout" }` on timeout. Idempotent
 * cleanup: if a decision arrives after timeout, the resolver is a no-op.
 */
export function awaitPermissionDecision(
  requestId: string,
  timeoutMs: number,
): Promise<{ decision: "allow" | "deny" | "timeout"; reason: string | null }> {
  // Consume an early decision if one is stashed (race: dashboard responded
  // before the hook started long-polling).
  const early = earlyPermissionDecisions.get(requestId);
  if (early) {
    earlyPermissionDecisions.delete(requestId);
    return Promise.resolve(early);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { decision: "allow" | "deny" | "timeout"; reason: string | null }) => {
      if (settled) return;
      settled = true;
      permissionWaiters.delete(requestId);
      resolve(r);
    };
    permissionWaiters.set(requestId, (r) => finish(r));
    setTimeout(() => finish({ decision: "timeout", reason: null }), Math.max(1000, timeoutMs));
  });
}

/**
 * Read pending permission requests for a session. Returns an empty array
 * for unknown / restarted sessions. Used by GET /sessions/:id/pending-requests
 * so the dashboard can hydrate after a page reload.
 */
export function getPendingRequests(sessionId: string): PendingPermissionRequest[] {
  const slot = getSlot(sessionId);
  if (slot) return slot.pendingRequests.map((r) => ({ ...r }));
  const list = slotlessPending.get(sessionId);
  return list ? list.map((r) => ({ ...r })) : [];
}

/**
 * Answer a permission ask. Writes a `control_response` frame to the
 * subprocess stdin and removes the request from the pending queue.
 * Reuses the existing per-session writeQueue so we don't interleave
 * with a user turn already in flight.
 */
export async function respondToPermission(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
  reason: string | null = null,
  trustPeer = false,
  answerAuthor: string | null = null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const slot = getSlot(sessionId);

  // Locate the request in the live slot, or — for a standalone skill run with
  // no slot — in the slot-less store. Either way we resolve it identically:
  // the hook long-poll (keyed by requestId) is what unblocks the turn.
  let pending: PendingPermissionRequest;
  let canonicalSid: string;
  if (slot) {
    if (slot.meta.status === "expired") return { ok: false, reason: "session expired" };
    const idx = slot.pendingRequests.findIndex((r) => r.requestId === requestId);
    if (idx < 0) return { ok: false, reason: "unknown request" };
    // "Allow all from $peer": grant session-scoped trust to the driving peer so
    // their later asks auto-approve. Only meaningful on an allow of a peer-driven
    // request; ignored for host asks or denials.
    if (trustPeer && decision === "allow") {
      const sid = slot.pendingRequests[idx].shareId;
      if (sid) slot.trustedShareIds.add(sid);
    }
    pending = slot.pendingRequests[idx];
    slot.pendingRequests.splice(idx, 1);
    canonicalSid = slot.meta.sessionId;
    clearPlanReviewComments(requestId); // review is over once decided

    // A synthesized plan review has no hook waiting on it. Approve → leave plan
    // mode and tell the agent to proceed; reject → send the feedback and stay
    // in plan mode so it revises (writeUserTurn handles reviving a dormant
    // between-turns subprocess). Record the decision and return early — the
    // waiter path below only applies to real (blocking) asks.
    if (pending.synthetic) {
      if (decision === "allow") {
        void writeUserTurn(canonicalSid, "The plan is approved — proceed with implementing it.", "host", null, { mode: "bypassPermissions", kind: "plan-approval", autoAllowRun: true })
          .catch((e) => log.warn("active-sessions", "plan approve turn failed", { err: String((e as any)?.message ?? e) }));
      } else {
        const fb = reason?.trim() ? reason.trim() : "Please revise the plan.";
        void writeUserTurn(canonicalSid, `The plan was rejected. Revise it based on this feedback:\n\n${fb}`, "host", null, { mode: "plan", kind: "plan-rejection" })
          .catch((e) => log.warn("active-sessions", "plan reject turn failed", { err: String((e as any)?.message ?? e) }));
      }
      try {
        ingestEventLine(JSON.stringify({
          ts: new Date().toISOString(),
          hook: "PermissionResponse",
          ctx: { session_id: canonicalSid, tool_name: pending.toolName, tool_input: safeJson(pending.input), request_id: requestId, tool_use_id: null, decision },
        }));
      } catch { /* best-effort transcript record */ }
      return { ok: true };
    }
  } else {
    const list = slotlessPending.get(sessionId) ?? [];
    const found = list.find((r) => r.requestId === requestId);
    if (!found) return { ok: false, reason: "unknown request" };
    pending = found;
    dropSlotlessPending(sessionId, requestId);
    canonicalSid = sessionId;
    clearPlanReviewComments(requestId); // review is over once decided
  }

  // Notify the hook's long-poll — that's the path that actually unblocks the
  // turn. The hook's stdout JSON (emitted by permission-gate.sh) carries the
  // allow/deny back to claude via the standard hookSpecificOutput contract,
  // so we deliberately do NOT write a control_response frame to claude's
  // stdin. Empirically, claude in `-p` print mode never emits
  // control_request, and a stray control_response frame on stdin caused
  // claude to exit early (turn went dormant after Allow without the tool
  // actually running) — observed in the stoic-blowing-lovelace session.
  // AskUserQuestion has no native answer channel in headless mode. We unblock
  // the tool with a deny, but the operator's selection is delivered as a
  // follow-up user turn (below) — a denied tool alone just gets acknowledged
  // and the model stops. Keep the deny reason minimal so the model waits for
  // that turn instead of half-acting on the reason text.
  const isAskAnswer = pending.toolName === "AskUserQuestion" && decision === "deny";
  const relayReason = isAskAnswer
    ? "The operator answered your question — their answer follows in the next message."
    : reason;

  const waiter = permissionWaiters.get(requestId);
  if (waiter) {
    waiter({ decision, reason: relayReason });
  } else {
    // No long-poller has registered yet (the hook is between POST and GET).
    // Stash so the next awaitPermissionDecision consumes it. Auto-expire to
    // avoid leaking entries when a hook crashes before getting to long-poll.
    earlyPermissionDecisions.set(requestId, { decision, reason: relayReason });
    setTimeout(() => earlyPermissionDecisions.delete(requestId), 60_000);
  }

  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PermissionResponse",
      ctx: {
        session_id: canonicalSid,
        tool_name: pending.toolName,
        tool_input: typeof pending.input === "string" ? pending.input : safeJson(pending.input),
        request_id: requestId,
        tool_use_id: pending.toolUseId,
        decision,
      },
    }));
  } catch (e) {
    log.warn("active-sessions", "permission response ingest failed", { err: String((e as any)?.message ?? e) });
  }

  // Deliver the answer as a user turn so the model resumes the task WITH it.
  // Mirrors the synthetic-plan approve/reject follow-up. Runs after the waiter
  // is unblocked, so it queues as the next turn on the same stdin pipe.
  if (isAskAnswer) {
    const answer = (reason ?? "").trim() || "(the operator did not provide a specific answer)";
    // If the question was asked during a /plan turn, keep the session in plan
    // mode for the answer turn. Without this, writeUserTurn (mode undefined)
    // would set slot.planTurnActive = false and silently drop plan-mode
    // enforcement — letting the model mutate before its plan is approved.
    const relayOpts = pending.planMode ? { mode: "plan" as const } : undefined;
    void writeUserTurn(
      canonicalSid,
      `${answer}\n\nThat is my answer to the question you just asked — please continue with the task using it.`,
      answerAuthor,
      null,
      relayOpts,
    ).catch((e) => log.warn("active-sessions", "askquestion follow-up turn failed", { err: String((e as any)?.message ?? e) }));
  }

  return { ok: true };
}

