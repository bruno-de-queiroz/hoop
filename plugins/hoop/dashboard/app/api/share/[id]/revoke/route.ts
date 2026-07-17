import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { isHost } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revoke a share (host only). The sandbox is the authoritative deny: revoking
 * cuts the peer's co-drive (and, once forwarded on reads, their view) instantly. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!isHost(req)) return errorResponse("forbidden", 403);
  try {
    const result = await client.revokeShare(params.id);
    if (!result.ok) return errorResponse("unknown share", 404);
    return Response.json({ ok: true });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "revoke failed", status);
  }
}
