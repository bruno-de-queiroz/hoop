/**
 * Node-side helpers for reading the trusted participant identity that
 * middleware injected (`x-hoop-participant`), and for host-only route
 * guards. Middleware strips any client-supplied value and re-sets it after
 * authenticating, so route handlers can trust this header.
 */

const PARTICIPANT_HEADER = "x-hoop-participant";
const PEER_SESSION_HEADER = "x-hoop-peer-session";

export type Participant =
  | { kind: "host" }
  | { kind: "peer"; shareId: string }
  | { kind: "none" };

export function participantOf(req: Request): Participant {
  const raw = req.headers.get(PARTICIPANT_HEADER) ?? "none";
  if (raw === "host") return { kind: "host" };
  if (raw.startsWith("peer:")) return { kind: "peer", shareId: raw.slice("peer:".length) };
  return { kind: "none" };
}

/** True only for the local operator (install-token auth). */
export function isHost(req: Request): boolean {
  return participantOf(req).kind === "host";
}

export function isPeer(req: Request): boolean {
  return participantOf(req).kind === "peer";
}

/** The canonical session id a peer is bound to (null for host/none). Trusted:
 * injected by middleware, inbound value stripped. */
export function peerSessionId(req: Request): string | null {
  if (participantOf(req).kind !== "peer") return null;
  const v = req.headers.get(PEER_SESSION_HEADER);
  return v && v.length > 0 ? v : null;
}

/** May the caller touch this session? Host: always. Peer: only their bound
 * session. (Used to scope per-session read routes.) */
export function canAccessSession(req: Request, sessionId: string): boolean {
  const p = participantOf(req);
  if (p.kind !== "peer") return true;
  return peerSessionId(req) === sessionId;
}

/** The middleware-injected participant value to forward to the sandbox so it
 * can re-validate the share + capability and attribute the action. Returns
 * undefined when absent (treated as host/no-op by the sandbox). */
export function forwardedParticipant(req: Request): string | undefined {
  return req.headers.get(PARTICIPANT_HEADER) ?? undefined;
}
