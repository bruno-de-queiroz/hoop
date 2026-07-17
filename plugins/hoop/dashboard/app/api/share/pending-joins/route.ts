import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { isHost } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pending peer joins awaiting the host's Admit/Deny (host only). */
export async function GET(req: Request) {
  if (!isHost(req)) return errorResponse("forbidden", 403);
  try {
    return Response.json(await client.listPendingJoins());
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "list failed", status);
  }
}
