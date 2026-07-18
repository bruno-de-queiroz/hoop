import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { isHost } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admit a pending peer join (host only). The peer's claim then issues the
 * peer cookie and they enter the session. */
export async function POST(req: Request, { params }: { params: Promise<{ ticket: string }> }) {
  if (!isHost(req)) return errorResponse("forbidden", 403);
  const { ticket } = await params;
  try {
    const result = await client.admitJoin(ticket);
    if (!result.ok) return errorResponse("unknown or already-resolved join", 404);
    return Response.json({ ok: true });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "admit failed", status);
  }
}
