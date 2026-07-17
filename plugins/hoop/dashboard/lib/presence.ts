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

interface PresenceState {
  bus: EventEmitter;
  // sessionId -> participantId -> entry
  bySession: Map<string, Map<string, PresenceEntry>>;
}

const HEARTBEAT_TTL_MS = 30_000; // ~3× a 10s client heartbeat
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
    g.__hoop_presence__ = { bus, bySession: new Map() };
  }
  return g.__hoop_presence__;
}

export function presenceBus(): EventEmitter {
  return state().bus;
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
  s.bus.emit("change", { sessionId: opts.sessionId });
}

/** Explicitly drop a participant (e.g. tab close) and notify. */
export function leave(sessionId: string, participantId: string): void {
  const s = state();
  const map = s.bySession.get(sessionId);
  if (map?.delete(participantId)) {
    s.bus.emit("change", { sessionId });
  }
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
