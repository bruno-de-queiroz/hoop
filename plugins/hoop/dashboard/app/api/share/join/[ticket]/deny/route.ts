import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { isHost } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deny a pending peer join (host only). Denial is treated as hostile: the
 * sandbox revokes the whole share, so the link dies. */
export async function POST(req: Request, { params }: { params: { ticket: string } }) {
  if (!isHost(req)) return errorResponse("forbidden", 403);
  try {
    const result = await client.denyJoin(params.ticket);
    if (!result.ok) return errorResponse("unknown or already-resolved join", 404);
    return Response.json({ ok: true });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "deny failed", status);
  }
}
