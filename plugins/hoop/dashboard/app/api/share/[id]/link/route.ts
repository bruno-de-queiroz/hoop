import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { isHost } from "@/lib/peer-auth";
import { signPeerToken, peerSigningSecret } from "@/lib/peer-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Regenerate a live share's redeemable link (host only) — so the host can view
 * the QR / copy the link again after the create dialog is gone. The peer token
 * isn't stored anywhere (the sandbox keeps only grant metadata; the token is
 * signed statelessly), but signing is deterministic: re-signing the same
 * fields from the stored ShareRecord yields the identical, still-valid token.
 * Only works for a live share — a revoked/expired one 404s.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!isHost(req)) return errorResponse("forbidden", 403);
  const secret = peerSigningSecret();
  if (!secret) return errorResponse("sharing is not configured", 503);

  let record;
  try {
    record = await client.validateShare(params.id, {});
  } catch {
    record = null;
  }
  if (!record) return errorResponse("unknown or revoked share", 404);

  const peerToken = await signPeerToken(
    {
      sid: record.shareId,
      ses: record.sessionId,
      cap: record.capability,
      host: record.publicHost,
      name: record.peerName,
      ...(record.expiresAt ? { exp: record.expiresAt } : {}),
    },
    secret,
  );
  const link = `https://${record.publicHost}/join/${encodeURIComponent(record.shareId)}#k=${peerToken}`;

  return Response.json({
    shareId: record.shareId,
    sessionId: record.sessionId,
    capability: record.capability,
    publicHost: record.publicHost,
    peerName: record.peerName,
    expiresAt: record.expiresAt,
    link,
  });
}
