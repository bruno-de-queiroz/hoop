import { client } from "@/lib/sandbox-client";
import { proxy, errorResponse } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (!Number.isFinite(id)) return errorResponse("invalid id", 400);

  return proxy(async () => {
    const row = await client.getEvent(id);
    if (!row) throw Object.assign(new Error("not found"), { status: 404 });
    return row;
  });
}
