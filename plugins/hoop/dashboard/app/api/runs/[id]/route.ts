import { client } from "@/lib/sandbox-client";
import { proxy } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxy(async () => {
    const run = await client.getRun(id);
    if (!run) throw Object.assign(new Error("not found"), { status: 404 });
    return run;
  });
}
