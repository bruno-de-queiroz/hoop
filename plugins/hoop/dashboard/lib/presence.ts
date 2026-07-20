import { EventEmitter } from "node:events";

/**
 * Ephemeral, dashboard-local presence registry for shared sessions: who is
 * currently viewing a session and whether they're typing. Not durable, not in
 * the sandbox (it's UI awareness, not security state).
 *
 * Stashed on globalThis for the same reason the sandbox client is (Next
 * standalone can load a module in more than one graph; a plain module-level
 * singleton would not be shared between the /api/presence and /api/stream route
 * modules, and presence would silently never update).
 */

export interface PresenceEntry {
  participantId: string;        // "host" or a share id
  name: string;
  kind: "host" | "peer";
  typing: boolean;
  lastSeen: number;
  // When `typing` last went truthy (ms epoch), or 0 when not typing. Used to
  // auto-expire the typing flag independently of the whole-entry TTL — see
  // TYPING_TTL_MS. Not surfaced to clients (stripped in listPresence).
  typingSince: number;
}

/**
 * A pending "did this peer really leave?" check. Only peers get one (a host
 * leaving isn't a transcript-worthy event). The single timer per peer is
 * re-armed on every heartbeat and replaced by the grace timer on an explicit
 * beacon leave, so at most one is outstanding — see armLeaveTimer / fireLeave.
 */
interface LeaveTrack {
  sessionId: string;
  participantId: string;
  name: string | null;
  timer: ReturnType<typeof setTimeout>;
}

interface PresenceState {
  bus: EventEmitter;
  // sessionId -> participantId -> entry
  bySession: Map<string, Map<string, PresenceEntry>>;
  // `${sessionId}\u0000${participantId}` -> pending leave check (peers only).
  leaveTracks: Map<string, LeaveTrack>;
}

const HEARTBEAT_TTL_MS = 30_000; // ~3× a 10s client heartbeat
// Grace before an explicit (beacon) leave becomes a durable "left" marker.
// Deliberately ≥ the client's 10s heartbeat: peers share ONE participantId
// across tabs, so closing one of several tabs drops the shared entry — a
// surviving tab's next heartbeat (≤10s) must be able to cancel the marker
// before it fires. 12s gives that a ~2s margin.
const LEAVE_GRACE_MS = 12_000;
// A peer that simply STOPS heartbeating (crash, sleep, network death — no
// beacon) is declared gone this long after its last beat. Past the entry TTL
// plus the same grace, so it can't fire while the peer is merely stale-but-back.
const SILENT_DROP_MS = HEARTBEAT_TTL_MS + LEAVE_GRACE_MS;
// The `typing` flag expires on its own, much sooner than the whole entry. A
// client asserts typing:true on keystrokes and is supposed to send false when
// idle — but a backgrounded tab or dropped request can lose that false, which
// used to leave "X is typing…" stuck for up to the full 30s entry TTL. Reporting
// typing:false once the assertion is older than this window makes the indicator
// self-heal regardless. Comfortably longer than the composer's ~3s idle reset
// and shorter than the 10s heartbeat, so an actively-typing client (which
// re-asserts on each keystroke) never flickers.
const TYPING_TTL_MS = 6_000;

function state(): PresenceState {
  const g = globalThis as unknown as { __hoop_presence__?: PresenceState };
  if (!g.__hoop_presence__) {
    const bus = new EventEmitter();
    bus.setMaxListeners(100);
    g.__hoop_presence__ = { bus, bySession: new Map(), leaveTracks: new Map() };
  }
  return g.__hoop_presence__;
}

export function presenceBus(): EventEmitter {
  return state().bus;
}

function trackKey(sessionId: string, participantId: string): string {
  return `${sessionId}\u0000${participantId}`;
}

/** (Re)arm the single pending leave-check for a peer, replacing any prior one. */
function armLeaveTimer(
  s: PresenceState,
  sessionId: string,
  participantId: string,
  name: string | null,
  delayMs: number,
): void {
  const key = trackKey(sessionId, participantId);
  const existing = s.leaveTracks.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => fireLeave(s, key), delayMs);
  // A pending leave check must never keep the process alive on its own (matters
  // for graceful shutdown and for test runners).
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  s.leaveTracks.set(key, { sessionId, participantId, name, timer });
}

/** Cancel a peer's pending leave-check without emitting (e.g. explicit leave,
 * which emits its own marker, or a peer coming back). */
function clearLeaveTimer(s: PresenceState, sessionId: string, participantId: string): void {
  const key = trackKey(sessionId, participantId);
  const t = s.leaveTracks.get(key);
  if (t) {
    clearTimeout(t.timer);
    s.leaveTracks.delete(key);
  }
}

/** A pending leave-check elapsed with no heartbeat cancelling it → the peer is
 * genuinely gone. Drop them from the roster (if not already evicted) and emit
 * the `left` signal that the leave-bridge turns into a durable transcript
 * marker. Fires at most once per track (the timer that ran is discarded). */
function fireLeave(s: PresenceState, key: string): void {
  const t = s.leaveTracks.get(key);
  if (!t) return;
  s.leaveTracks.delete(key);
  const map = s.bySession.get(t.sessionId);
  if (map?.delete(t.participantId)) s.bus.emit("change", { sessionId: t.sessionId });
  s.bus.emit("left", { sessionId: t.sessionId, participantId: t.participantId, name: t.name });
}

function evictStale(map: Map<string, PresenceEntry>): void {
  const now = Date.now();
  for (const [id, e] of map) {
    if (now - e.lastSeen > HEARTBEAT_TTL_MS) map.delete(id);
  }
}

/** Record/refresh a participant's presence on a session and notify listeners. */
export function heartbeat(opts: {
  sessionId: string;
  participantId: string;
  name: string;
  kind: "host" | "peer";
  typing?: boolean;
}): void {
  const s = state();
  let map = s.bySession.get(opts.sessionId);
  if (!map) {
    map = new Map();
    s.bySession.set(opts.sessionId, map);
  }
  const now = Date.now();
  const typing = !!opts.typing;
  // Refresh typingSince on every truthy assertion. The client re-asserts
  // typing:true on a keepalive interval shorter than TYPING_TTL_MS while the
  // user is actively typing, so this stays fresh during a long burst and goes
  // stale within the TTL once assertions stop (idle, tab backgrounded, dropped
  // request) — see listPresence.
  map.set(opts.participantId, {
    participantId: opts.participantId,
    name: opts.name,
    kind: opts.kind,
    typing,
    lastSeen: now,
    typingSince: typing ? now : 0,
  });
  evictStale(map);
  // Peer watchdog: (re)arm on every beat so a peer that stops beating (crash,
  // sleep, network death — no explicit leave) still produces a durable "left"
  // marker once it's been silent long enough. A live peer's next beat clears
  // and re-arms this, so it only ever fires when the beats genuinely stop.
  if (opts.kind === "peer") {
    armLeaveTimer(s, opts.sessionId, opts.participantId, opts.name, SILENT_DROP_MS);
  }
  s.bus.emit("change", { sessionId: opts.sessionId });
}

/**
 * Explicitly drop a participant (e.g. tab close) and notify.
 *
 * For a PEER this also governs the "left" marker:
 *   - default (beacon leave): hold a short grace window before emitting, so a
 *     second tab's heartbeat (peers share one participantId) or a quick reload
 *     can cancel it — only a real departure fires the marker.
 *   - `silent`: cancel any pending marker without emitting. Used by the explicit
 *     "Leave session" flow, which emits its own marker immediately (and clears
 *     the peer's cookie), so the follow-on unmount beacon must not double-fire.
 */
export function leave(
  sessionId: string,
  participantId: string,
  opts?: { silent?: boolean },
): void {
  const s = state();
  const map = s.bySession.get(sessionId);
  const removed = map?.delete(participantId) ?? false;
  if (participantId.startsWith("peer:")) {
    if (opts?.silent) {
      clearLeaveTimer(s, sessionId, participantId);
    } else {
      const prevName = s.leaveTracks.get(trackKey(sessionId, participantId))?.name ?? null;
      armLeaveTimer(s, sessionId, participantId, prevName, LEAVE_GRACE_MS);
    }
  }
  if (removed) s.bus.emit("change", { sessionId });
}

/** Current (non-stale) participants on a session. The `typing` flag is
 * independently expired at TYPING_TTL_MS so a lost `typing:false` can't leave
 * an indicator stuck for the whole 30s entry TTL. */
export function listPresence(sessionId: string): PresenceEntry[] {
  const map = state().bySession.get(sessionId);
  if (!map) return [];
  evictStale(map);
  const now = Date.now();
  return [...map.values()]
    .map((e) => ({
      ...e,
      typing: e.typing && e.typingSince > 0 && now - e.typingSince <= TYPING_TTL_MS,
    }))
    .sort((a, b) => a.participantId.localeCompare(b.participantId));
}
