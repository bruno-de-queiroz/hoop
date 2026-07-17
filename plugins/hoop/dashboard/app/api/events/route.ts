import { client } from "@/lib/sandbox-client";
import { clampInt } from "@shared/clamp";
import { proxy, errorResponse } from "@/lib/api-helpers";
import { peerSessionId } from "@/lib/peer-auth";
import { peerShareGuard } from "@/lib/peer-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const revoked = await peerShareGuard(request);
  if (revoked) return revoked;

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 1000, fallback: 200 });
  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw != null ? parseInt(beforeRaw, 10) : undefined;
  const hook = url.searchParams.get("hook");
  const tool = url.searchParams.get("tool");
  let session = url.searchParams.get("session");

  // A peer may only read events for the session they were shared into — pin the
  // query to their bound session regardless of the requested `session`.
  const peerSes = peerSessionId(request);
  if (peerSes) {
    if (session && session !== peerSes) {
      return errorResponse("forbidden: out of session scope", 403);
    }
    session = peerSes;
  }

  return proxy(() =>
    client.listEvents({
      limit,
      before: Number.isFinite(before) ? before : undefined,
      hook: hook ?? undefined,
      tool: tool ?? undefined,
      session: session ?? undefined,
    }),
  );
}
