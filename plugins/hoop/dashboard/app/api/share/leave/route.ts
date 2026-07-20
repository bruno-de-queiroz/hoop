import { NextRequest, NextResponse } from "next/server";
import { client } from "@/lib/sandbox-client";
import { parseJsonBody, errorResponse, boundedString } from "@/lib/api-helpers";
import { participantOf, peerSessionId } from "@/lib/peer-auth";
import { leave } from "@/lib/presence";
import { PEER_COOKIE } from "@/lib/peer-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A peer deliberately leaves the shared session (the "Leave session" action).
 *
 * Unlike an accidental tab close (which the presence beacon + grace/watchdog
 * handle), this is unambiguous, so we act at once:
 *   1. emit the `PeerLeft` transcript marker immediately (no grace delay);
 *   2. drop the peer from presence SILENTLY, so the grace/watchdog path doesn't
 *      also emit — this call is the single source of the marker;
 *   3. clear the durable peer cookie, so returning requires the share link and
 *      the host's admit gate again (i.e. a real, gated rejoin — and a leaked
 *      link still faces a deny).
 *
 * Identity is taken from the middleware-injected (trusted) participant headers,
 * never from the client. `name` is a cosmetic marker label only.
 */
export async function POST(req: NextRequest) {
  const who = participantOf(req);
  if (who.kind !== "peer") return errorResponse("forbidden", 403);

  const sessionId = peerSessionId(req);
  const { body } = await parseJsonBody<{ name?: unknown }>(req, { maxBytes: 4 * 1024 });
  const name = boundedString(body?.name, 80);

  if (sessionId) {
    leave(sessionId, `peer:${who.shareId}`, { silent: true });
    // Best-effort audit marker; a sandbox blip must not block the peer's exit.
    try {
      await client.peerLeave(sessionId, name);
    } catch { /* non-fatal */ }
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: PEER_COOKIE, value: "", path: "/", maxAge: 0 });
  return res;
}
