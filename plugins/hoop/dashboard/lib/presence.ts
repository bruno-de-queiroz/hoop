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
  // Whether the viewer's tab is currently in the FOREGROUND. The client reports
  // this (from document.visibilityState, which flips instantly on
  // visibilitychange — before a backgrounded tab's timers get throttled). A
  // backgrounded-but-connected peer sets this false → shown as `away` (dimmed
  // avatar), never as "left".
  active: boolean;
  // Last time this participant was ACTIVE (foreground beat), ms epoch. The
  // "genuinely gone" watchdog is measured from here, NOT from lastSeen: a
  // backgrounded tab keeps beating (throttled) so lastSeen stays fresh, but
  // lastActive freezes when it goes to the background — so a peer that has been
  // away long enough still resolves to a durable "left". See GONE_MS.
  lastActive: number;
  // When `typing` last went truthy (ms epoch), or 0 when not typing. Used to
  // auto-expire the typing flag independently of the whole-entry TTL — see
  // TYPING_TTL_MS. Not surfaced to clients (stripped in listPresence).
  typingSince: number;
}

/**
 * A pending "has this peer been gone long enough to mark left?" check. Only
 * peers get one (a host leaving isn't a transcript-worthy event). At most one
 * timer is outstanding per peer: it is (re)armed on every ACTIVE beat and left
 * to run down across background/inactive beats, and cleared outright on an
 * explicit "Leave session" (which emits its own marker) — see armLeaveTimer /
 * clearLeaveTimer / fireLeave.
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

// A peer whose heartbeat hasn't been seen for this long (or who has reported
// its tab inactive) is shown as `away` — a DIMMED avatar, not a departure. A
// couple of missed 10s beats (backgrounded tab throttling its interval) is
// enough to dim; nothing durable happens.
const IDLE_MS = 25_000;
// The ONLY non-explicit trigger for a durable "left" marker: the peer has been
// inactive (tab not in the foreground, or gone entirely) this long, measured
// from its last ACTIVE beat. Deliberately long — a briefly-backgrounded peer
// that is still connected and can still chat must NOT be marked left; only a
// genuine, sustained absence is. (An explicit "Leave session" click is the
// other trigger and fires immediately, via the leave route.)
const GONE_MS = 3 * 60_000;
// Roster eviction backstop for entries that stop beating entirely with no
// watchdog to reap them (i.e. hosts). Peers are removed by the GONE_MS
// watchdog; keep everyone visible (dimmed once idle) until then.
const EVICT_MS = GONE_MS;
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
    if (now - e.lastSeen > EVICT_MS) map.delete(id);
  }
}

/** Record/refresh a participant's presence on a session and notify listeners. */
export function heartbeat(opts: {
  sessionId: string;
  participantId: string;
  name: string;
  kind: "host" | "peer";
  typing?: boolean;
  /** Whether the viewer's tab is in the foreground. Absent → treated as active
   * (back-compat: an older client that never reports this is assumed present). */
  active?: boolean;
}): void {
  const s = state();
  let map = s.bySession.get(opts.sessionId);
  if (!map) {
    map = new Map();
    s.bySession.set(opts.sessionId, map);
  }
  const now = Date.now();
  const typing = !!opts.typing;
  const active = opts.active !== false;
  const prev = map.get(opts.participantId);
  // lastActive advances only on ACTIVE beats; a backgrounded (inactive) beat
  // keeps refreshing lastSeen (so the peer stays visible, merely dimmed) but
  // freezes lastActive, so the GONE_MS watchdog keeps counting down toward a
  // durable "left".
  const lastActive = active ? now : prev?.lastActive ?? now;
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
    active,
    lastActive,
    typingSince: typing ? now : 0,
  });
  evictStale(map);
  // Peer "genuinely gone" watchdog. (Re)arm ONLY on active beats, for the full
  // GONE_MS from now; inactive (backgrounded) beats leave the existing timer
  // running so it fires GONE_MS after the LAST active beat. An active beat
  // (peer came back to the foreground) pushes it out again, so it only ever
  // fires after a sustained absence — never for a briefly-backgrounded peer.
  if (opts.kind === "peer") {
    const armed = s.leaveTracks.has(trackKey(opts.sessionId, opts.participantId));
    if (active || !armed) {
      const delay = active ? GONE_MS : Math.max(0, lastActive + GONE_MS - now);
      armLeaveTimer(s, opts.sessionId, opts.participantId, opts.name, delay);
    }
  }
  s.bus.emit("change", { sessionId: opts.sessionId });
}

/**
 * Explicitly drop a participant from the roster (e.g. tab close / navigate
 * away) and notify. This is a ROSTER-only operation now — it never emits a
 * "left" marker. A durable "left" has exactly two sources: the GONE_MS
 * watchdog (sustained inactivity) and the explicit "Leave session" route.
 *
 *   - default (beacon on unmount): remove the entry so others see the avatar
 *     drop promptly, but leave the peer's GONE_MS watchdog running — if they've
 *     truly gone it will still resolve to "left" after the long window; if a
 *     second tab (peers share one participantId) is still active, its next beat
 *     re-adds the entry and re-arms the timer, so nothing durable happens.
 *   - `silent`: also cancel the pending watchdog. Used by the explicit "Leave
 *     session" flow, which emits its own marker immediately (and clears the
 *     peer's cookie), so the watchdog must not later double-fire.
 */
export function leave(
  sessionId: string,
  participantId: string,
  opts?: { silent?: boolean },
): void {
  const s = state();
  const map = s.bySession.get(sessionId);
  const removed = map?.delete(participantId) ?? false;
  if (opts?.silent && participantId.startsWith("peer:")) {
    clearLeaveTimer(s, sessionId, participantId);
  }
  if (removed) s.bus.emit("change", { sessionId });
}

/** Current participants on a session, each tagged with `away` (dim the avatar:
 * the peer's tab is backgrounded or its heartbeat is stale, but it is NOT
 * gone). The `typing` flag is independently expired at TYPING_TTL_MS so a lost
 * `typing:false` can't leave an indicator stuck for the whole entry TTL. */
export function listPresence(sessionId: string): Array<PresenceEntry & { away: boolean }> {
  const map = state().bySession.get(sessionId);
  if (!map) return [];
  evictStale(map);
  const now = Date.now();
  return [...map.values()]
    .map((e) => ({
      ...e,
      typing: e.typing && e.typingSince > 0 && now - e.typingSince <= TYPING_TTL_MS,
      // Peers only: a backgrounded (inactive) or stale-heartbeat peer is shown
      // dimmed. Hosts are never dimmed (their idleness isn't surfaced).
      away: e.kind === "peer" && (!e.active || now - e.lastSeen > IDLE_MS),
    }))
    .sort((a, b) => a.participantId.localeCompare(b.participantId));
}
