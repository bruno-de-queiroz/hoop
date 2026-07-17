import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody, boundedString } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CWD_LEN = 4096;
const MAX_LABEL_LEN = 200;
const MAX_NAME_LEN = 200;
const MAX_MODEL_LEN = 128;

export async function POST(req: NextRequest) {
  const { body, error } = await parseJsonBody<{ cwd?: unknown; label?: unknown; name?: unknown; model?: unknown }>(
    req,
    { maxBytes: 8 * 1024 }
  );
  if (error) return error;

  const cwd = boundedString(body.cwd, MAX_CWD_LEN);
  const label = boundedString(body.label, MAX_LABEL_LEN);
  const name = boundedString(body.name, MAX_NAME_LEN);
  const model = boundedString(body.model, MAX_MODEL_LEN);

  try {
    // The sandbox enforces cwd policy + filesystem checks server-side; the
    // dashboard would be checking the wrong filesystem if it tried locally
    // (the dashboard container no longer mounts the host's ~/.claude or any
    // user workdir).
    const { sessionId, meta } = await client.startNewConversation({
      cwd: cwd ?? undefined,
      label: label ?? undefined,
      name: name ?? undefined,
      model: model ?? undefined,
      via: "new-conversation",
    });
    return Response.json({ sessionId, meta });
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return errorResponse(e?.message ?? "spawn failed", status);
  }
}
