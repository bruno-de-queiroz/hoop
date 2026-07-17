import { NextResponse } from "next/server";
import { client } from "@/lib/sandbox-client";
import { parseJsonBody, errorResponse } from "@/lib/api-helpers";
import { PEER_PENDING_COOKIE, peerSigningSecret, verifyPeerToken } from "@/lib/peer-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pending cookie lives just long enough for the host to admit (sandbox TTL is
 * ~2 min); the peer cookie is issued only at claim, after admission. */
const PENDING_TTL_SEC = 3 * 60;

function normalizeHost(hostHeader: string | null): string {
  if (!hostHeader) return "";
  let h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end >= 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.indexOf(":");
  if (colon >= 0) h = h.slice(0, colon);
  return h;
}

/**
 * Redeem a share link: verify the signed token and bind it to this host, then
 * — instead of granting access — register a PENDING join the host must admit.
 * We set a short-lived HttpOnly `hoop_pending` cookie carrying the ticket
 * secret (binds the pending join to this browser); the real peer cookie is
 * issued later by /api/share/claim, only after the host admits. So a leaked
 * link can't gain access without a live host OK.
 *
 * Reachable without a cookie (middleware-allowlisted). Identical error
 * responses for "no such share" and "bad token" so the endpoint doesn't
 * confirm a share exists for a host the caller guessed.
 */
export async function POST(req: Request) {
  const secret = peerSigningSecret();
  if (!secret) return errorResponse("sharing is not configured", 503);

  const { body, error } = await parseJsonBody<{ token?: string; name?: string }>(req);
  if (error) return error;
  if (!body.token) return errorResponse("invalid or expired share link", 401);
  // The joining peer names themselves; bounded here, authoritative sandbox-side.
  const chosenName = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : null;

  const payload = await verifyPeerToken(body.token, secret);
  if (!payload) return errorResponse("invalid or expired share link", 401);

  const host = normalizeHost(req.headers.get("host"));
  if (payload.host !== host) return errorResponse("invalid or expired share link", 401);

  // The sandbox is the revocation authority — confirm the grant is still live.
  let live = null;
  try {
    live = await client.validateShare(payload.sid, { host });
  } catch {
    live = null;
  }
  if (!live) return errorResponse("invalid or expired share link", 401);

  // Register a pending join (host must admit). The peer's chosen nickname is
  // what the host sees in the admit prompt and what attribution uses; it falls
  // back to any host-suggested default on the share record (sandbox-side).
  let ticket: { ticketId: string; secret: string };
  try {
    ticket = await client.createJoinTicket(payload.sid, chosenName);
  } catch {
    return errorResponse("could not start join request", 502);
  }

  const res = NextResponse.json({
    pending: true,
    ticketId: ticket.ticketId,
    sessionId: payload.ses,
    peerName: chosenName ?? payload.name ?? null,
  });
  res.cookies.set({
    name: PEER_PENDING_COOKIE,
    value: ticket.secret,
    httpOnly: true,
    secure: true, // tunnels are HTTPS
    sameSite: "strict",
    path: "/",
    maxAge: PENDING_TTL_SEC,
  });
  return res;
}
