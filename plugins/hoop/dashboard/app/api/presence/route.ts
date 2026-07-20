import { NextRequest } from "next/server";
import { parseJsonBody, errorResponse, boundedString } from "@/lib/api-helpers";
import { participantOf } from "@/lib/peer-auth";
import { heartbeat, leave, listPresence } from "@/lib/presence";
import { initPresenceLeaveBridge } from "@/lib/presence-leave-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  sessionId?: string;
  name?: string;
  typing?: boolean;
  leaving?: boolean;
}

/**
 * Presence heartbeat for a shared session. The participant identity comes from
 * the middleware-injected (trusted) header; the display name comes from the
 * client (a peer's chosen name / the host label) — a cosmetic label only.
 */
export async function POST(req: NextRequest) {
  // Idempotent: attaches the presence→sandbox "left" listener once. Done here
  // (rather than at import) because presence markers can only originate after a
  // heartbeat/leave, which always flow through this route.
  initPresenceLeaveBridge();

  const who = participantOf(req);
  if (who.kind === "none") return errorResponse("forbidden", 403);

  const { body, error } = await parseJsonBody<Body>(req, { maxBytes: 4 * 1024 });
  if (error) return error;
  const sessionId = boundedString(body.sessionId, 256);
  if (!sessionId) return errorResponse("missing required field: sessionId", 400);

  const participantId = who.kind === "host" ? "host" : `peer:${who.shareId}`;
  const kind = who.kind;
  const defaultName = kind === "host" ? "Host" : "Guest";
  const name = (boundedString(body.name, 80) ?? defaultName).slice(0, 80);

  if (body.leaving) {
    leave(sessionId, participantId);
  } else {
    heartbeat({ sessionId, participantId, name, kind, typing: !!body.typing });
  }
  return Response.json({ participants: listPresence(sessionId) });
}
