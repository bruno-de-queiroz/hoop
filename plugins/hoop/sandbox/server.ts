/**
 * Sandbox HTTP API.
 *
 * AUTH MODEL: bearer token in `X-Sandbox-Token` (or `X-Hook-Token` for /ingest).
 * NO same-origin / referer / CSRF check — this API is designed to be reached
 * over a Unix Domain Socket only. Do NOT bind it to a TCP port. The whole
 * security model assumes that holding the UDS file descriptor is itself a
 * privileged operation; any TCP exposure breaks it (no Origin header, no
 * SameSite cookie protection, no rate-limit-by-IP). If you really need
 * remote access, put a TLS-terminating reverse proxy between you and a
 * client that connects to the UDS — never expose the UDS as TCP.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, statSync, unlinkSync, chmodSync, chownSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { URL } from "node:url";

import {
  sandboxTokenMatches,
  hookTokenMatches,
  sandboxToken,
  hookToken,
  SANDBOX_TOKEN_HEADER,
  HOOK_TOKEN_HEADER,
} from "./auth";

import {
  startNewConversation,
  writeUserTurn,
  popPendingAuthor,
  markTurnFinished,
  markSessionActive,
  isControllable,
  endSession,
  deleteSession,
  renameSession,
  getActiveSession,
  getPendingRequests,
  interruptSession,
  setSessionModel,
  respondToPermission,
  createPermissionRequest,
  listPlanReviewComments,
  addPlanReviewComment,
  addPlanReviewReply,
  editPlanReviewComment,
  removePlanReviewComment,
  awaitPermissionDecision,
  activeSessionsBus,
  bootActiveSessions,
  startIdleSweeper,
  reconcileOrphanEvents,
  type TurnImage,
  shutdownActiveSessions,
  listActiveSessions,
} from "./lib/active-sessions";
import {
  listSessions,
  startSessionsWatcher,
  stopSessionsWatcher,
  sessionsBus,
} from "./lib/sessions";
import {
  startSkillRun,
  listRuns,
  getRun,
  isValidSkillName,
  runsBus,
} from "./lib/spawn";
import {
  ingestEventLine,
  startIngestor,
  eventBus,
} from "./lib/ingestor";
import { listSkills, startSkillsWatcher, stopSkillsWatcher, syncProjectSkillWatchers, skillsBus } from "./lib/skills";
import {
  bootShares,
  createShare,
  revokeShare,
  revokeAllShares,
  setSharePeerName,
  listShares,
  getShare,
  validateShareById,
  capabilityAllows,
  type ShareCapability,
} from "./lib/shares";
import { peerBashAllowed } from "./lib/peer-policy";
import { validateImageBase64 } from "./lib/image-guard";
import {
  createJoinTicket,
  joinStatus,
  admitJoin,
  denyJoin,
  claimJoin,
  listPendingJoins,
  dropJoinsForShare,
} from "./lib/peer-joins";
import { listSlashCommands } from "./lib/commands";
import { listAgentRuns, getAgentDetail } from "./lib/agents";
import { search, type SearchType } from "./lib/search";
import { listMcps } from "./lib/mcps";
import { getStack } from "./lib/stack";
import { getIdentity } from "./lib/identity";
import { getSessionModel } from "./lib/session-model";
import { getSessionSummary } from "./lib/session-summary";
import { listFiles, CwdPolicyError } from "./lib/files";
import { listEvents, getEvent } from "./lib/events-query";
import { clampInt } from "@shared/clamp";
import { isAllowedCwd } from "./lib/cwd-policy";
import { backupEventsDb, checkpointDb } from "./lib/db";
import { mutatingLimiter } from "./rate-limit";
import { log } from "@shared/logger";
import { registerShutdown } from "@shared/shutdown";

const SOCKET_PATH = process.env.HOOP_SANDBOX_SOCKET
  || "/var/run/hoop/sandbox.sock";

const MAX_BYTES_DEFAULT = 32 * 1024;
const MAX_BYTES_MESSAGE = 100 * 1024 + 1024;
// A user turn may carry base64 images (vision). The message route allows a
// larger body than plain text, bounded per-image and per-count below.
const MAX_BYTES_TURN = 16 * 1024 * 1024;
const MAX_IMAGES_PER_TURN = 8;
const MAX_IMAGE_B64_BYTES = 4 * 1024 * 1024; // ~3MB decoded per image (full → model)
// Thumbnails (≤512px) are persisted into the turn's event and broadcast to
// every peer, so the whole set is bounded to keep event entries small.
const MAX_EVENT_THUMBS_B64_BYTES = 512 * 1024;
const ALLOWED_IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES_INGEST = 64 * 1024;
const MAX_BYTES_ARGS = 16 * 1024;

const ALLOWED_HOOKS = new Set([
  "SessionStart",
  "SessionEnd",
  "Stop",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "SubagentStop",
  "PreCompact",
  "ToolUseConfirmation",
  // Dashboard-driven `!cmd` shortcut. Bypasses the model — bash runs
  // directly in the session's cwd and the result is appended to the
  // event log as a synthesized hook frame.
  "BashShortcut",
  // Tool-permission asks captured from claude's stream-json
  // `control_request` frames. Emitted when the model wants approval to
  // run a non-allowlisted tool; the dashboard renders an interactive
  // card. PermissionResponse records the user's decision so the
  // transcript shows the resolution.
  "PermissionRequest",
  "PermissionResponse",
]);

const REQUEST_ID_HEADER = "x-request-id";

// ---------- HTTP helpers ----------

function reqId(req: IncomingMessage): string | undefined {
  const v = req.headers[REQUEST_ID_HEADER];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}

function json(res: ServerResponse, status: number, body: unknown, rid?: string) {
  const payload = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  };
  if (rid) headers[REQUEST_ID_HEADER] = rid;
  res.writeHead(status, headers);
  res.end(payload);
}

function err(res: ServerResponse, status: number, message: string, rid?: string) {
  json(res, status, { error: message, ...(rid ? { requestId: rid } : {}) }, rid);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      received += c.length;
      if (received > maxBytes) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function readJson<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const ct = (req.headers["content-type"] ?? "").toString().toLowerCase();
  if (!ct.includes("application/json")) {
    throw Object.assign(new Error("expected application/json"), { status: 415 });
  }
  const text = await readBody(req, maxBytes);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

function getHeader(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === "string" ? v : null;
}

const PARTICIPANT_HEADER = "x-hoop-participant";

/**
 * Authoritative peer-context guard for co-drive actions. The dashboard forwards
 * `x-hoop-participant` (already authenticated by the dashboard's signed-token
 * gate); this is the independent SECOND check that a compromised dashboard
 * cannot bypass — it re-validates the share against the sandbox's own durable
 * registry (revocation + session scope) and the capability for this action.
 *
 * Host (or no participant header) → allowed, author "host". Peer → validated;
 * returns the share's peerName as the author for attribution.
 */
function checkParticipant(
  req: IncomingMessage,
  requestedSessionId: string,
  action: "turn" | "bash" | "permission",
): { ok: true; author: string | null; isPeer: boolean; shareId: string | null; capability: ShareCapability | null } | { ok: false; status: number; reason: string } {
  const raw = getHeader(req, PARTICIPANT_HEADER);
  if (!raw || raw === "host") return { ok: true, author: "host", isPeer: false, shareId: null, capability: null };
  if (raw.startsWith("peer:")) {
    const shareId = raw.slice("peer:".length);
    // Liveness only here (not revoked/expired); session scope is checked
    // below with alias-awareness.
    const v = validateShareById(shareId, {});
    if (!v.ok || !v.record) {
      return { ok: false, status: 403, reason: "share revoked or expired" };
    }
    // Session-equivalence: a share is bound to the session id it was created
    // under, but `claude --resume` swaps the canonical id mid-life. Resolve
    // BOTH the requested id and the share's bound id through the registry
    // (which follows aliases) and compare the resulting canonical ids, so a
    // resumed session still matches its share.
    const reqCanonical = getActiveSession(requestedSessionId)?.sessionId ?? requestedSessionId;
    const shareCanonical = getActiveSession(v.record.sessionId)?.sessionId ?? v.record.sessionId;
    if (reqCanonical !== shareCanonical) {
      return { ok: false, status: 403, reason: "out of session scope" };
    }
    if (!capabilityAllows(v.record.capability, action)) {
      return { ok: false, status: 403, reason: `share capability '${v.record.capability}' does not permit ${action}` };
    }
    return { ok: true, author: v.record.peerName ?? "peer", isPeer: true, shareId, capability: v.record.capability };
  }
  // Unknown participant format — treat as unauthorized.
  return { ok: false, status: 403, reason: "invalid participant" };
}

function boundedString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

// ---------- Router ----------

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  // "none" is reserved for Docker healthchecks reaching the UDS without the
  // token. It MUST stay narrow (no info leak beyond "process is alive").
  auth: "sandbox" | "hook" | "none";
}

const routes: Route[] = [];

// Per MDN: chars that need escaping inside a RegExp character class.
const REGEX_META = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
  return s.replace(REGEX_META, "\\$&");
}

function add(method: string, path: string, handler: RouteHandler, auth: Route["auth"] = "sandbox") {
  const paramNames: string[] = [];
  // Escape regex metacharacters in literal segments BEFORE substituting
  // :param patterns. Otherwise a future path like `/foo.json` would match
  // `/fooxjson`, or a path containing `+`/`?`/`*` would behave unpredictably.
  const pattern = new RegExp(
    "^" + escapeRegex(path).replace(/:([a-zA-Z]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    }) + "$"
  );
  routes.push({ method, pattern, paramNames, handler, auth });
}

// ---------- Routes ----------

// Liveness only; no auth. Returns nothing that would leak state. Used by the
// Docker HEALTHCHECK and any service-discovery probe.
add("GET", "/health", (_req, res) => {
  json(res, 200, { ok: true });
}, "none");

add("GET", "/sessions", (_req, res) => {
  startSessionsWatcher();
  startIngestor();
  json(res, 200, listSessions());
});

add("POST", "/sessions", async (req, res) => {
  let body: { cwd?: unknown; label?: unknown; name?: unknown; model?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }

  const cwd = boundedString(body.cwd, 4096);
  const label = boundedString(body.label, 200);
  const name = boundedString(body.name, 200);
  const model = boundedString(body.model, 128);

  if (cwd) {
    const policy = isAllowedCwd(cwd);
    if (!policy.ok) return err(res, 400, policy.reason ?? "cwd not allowed");
    if (!existsSync(cwd)) return err(res, 400, `cwd does not exist: ${cwd}`);
    try {
      if (!statSync(cwd).isDirectory()) {
        return err(res, 400, `cwd is not a directory: ${cwd}`);
      }
    } catch (e: any) {
      return err(res, 400, `cwd unreadable: ${e?.message ?? cwd}`);
    }
  }

  // Reject model values that could be misinterpreted as flags. The claude
  // CLI accepts arbitrary strings here (aliases like opus/sonnet/haiku or
  // full IDs), so we only block the structural footgun.
  if (model && (model.startsWith("-") || /\s/.test(model))) {
    return err(res, 400, "model must not start with '-' or contain whitespace");
  }

  try {
    const { sessionId, meta } = await startNewConversation({
      cwd: cwd ?? undefined,
      label: label ?? undefined,
      name: name ?? undefined,
      model: model ?? undefined,
      via: "new-conversation",
    });
    json(res, 200, { sessionId, meta });
  } catch (e: any) {
    if (e?.name === "TooManyControllableSessionsError") {
      res.setHeader("Retry-After", "5");
      return err(res, 429, e.message);
    }
    err(res, 500, e?.message ?? "spawn failed");
  }
});

add("PATCH", "/sessions/:id", async (req, res, params) => {
  let body: { name?: unknown };
  try { body = await readJson(req, 4 * 1024); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const name = boundedString(body.name, 200);
  if (name == null) return err(res, 400, "missing required field: name");
  const meta = renameSession(params.id, name);
  if (!meta) return err(res, 404, "session not found");
  json(res, 200, { ok: true, meta });
});

add("DELETE", "/sessions/:id", async (_req, res, params) => {
  try {
    const result = await deleteSession(params.id);
    json(res, 200, { ok: true, ...result });
  } catch (e: any) {
    err(res, 500, e?.message ?? "delete failed");
  }
});

add("POST", "/sessions/:id/end", async (_req, res, params) => {
  try {
    await endSession(params.id);
    json(res, 200, { ok: true });
  } catch (e: any) {
    err(res, 500, e?.message ?? "end failed");
  }
});

add("POST", "/sessions/:id/message", async (req, res, params) => {
  if (!isControllable(params.id)) return err(res, 409, "session not controllable");
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  let body: { text?: unknown; images?: unknown };
  try { body = await readJson(req, MAX_BYTES_TURN); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const text = typeof body.text === "string" ? body.text : "";
  if (text.length > 100_000) return err(res, 413, "text too long (>100kb)");
  // Optional base64 image attachments (vision). Validated strictly: known media
  // types only, bounded count + size — this is untrusted peer-supplied data.
  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > MAX_IMAGES_PER_TURN) return err(res, 413, `too many images (max ${MAX_IMAGES_PER_TURN})`);
  const images: TurnImage[] = [];      // full-res → the model
  const thumbnails: TurnImage[] = [];  // ≤512px → persisted in the event
  let thumbBytes = 0;
  for (const it of rawImages) {
    const o = it && typeof it === "object" ? (it as { media_type?: unknown; data?: unknown; thumb?: unknown }) : {};
    if (typeof o.media_type !== "string" || !ALLOWED_IMAGE_MEDIA.has(o.media_type)) return err(res, 400, "unsupported image media_type");
    if (typeof o.data !== "string" || o.data.length === 0) return err(res, 400, "empty image data");
    if (o.data.length > MAX_IMAGE_B64_BYTES) return err(res, 413, "image too large");
    // The bytes are untrusted (any turn-capable peer). Verify they're valid
    // base64 AND actually the declared image type AND not a decompression bomb.
    const full = validateImageBase64(o.data, o.media_type, 8192);
    if (!full.ok) return err(res, 400, full.reason ?? "invalid image");
    images.push({ media_type: o.media_type, data: o.data });
    // Thumbnail is a JPEG the client downscaled; fall back to the full data if
    // absent. This is what gets broadcast + rendered by every peer, so hold it
    // to a tighter dimension cap.
    const thumb = typeof o.thumb === "string" && o.thumb ? o.thumb : o.data;
    const thumbType = typeof o.thumb === "string" && o.thumb ? "image/jpeg" : o.media_type;
    const thumbCheck = validateImageBase64(thumb, thumbType, 1024);
    if (!thumbCheck.ok) return err(res, 400, `thumbnail rejected: ${thumbCheck.reason}`);
    thumbBytes += thumb.length;
    thumbnails.push({ media_type: thumbType, data: thumb });
  }
  if (thumbBytes > MAX_EVENT_THUMBS_B64_BYTES) {
    return err(res, 413, `image thumbnails too large for the transcript (max ${Math.floor(MAX_EVENT_THUMBS_B64_BYTES / 1024)}KB total) — attach fewer or smaller images`);
  }
  if (!text && images.length === 0) return err(res, 400, "missing text or images");
  try {
    const result = await writeUserTurn(
      params.id, text, guard.author, guard.shareId,
      images.length ? { images, thumbnails } : undefined,
    );
    json(res, 200, { ok: true, sessionId: result.sessionId });
  } catch (e: any) {
    err(res, 500, e?.message ?? "write failed");
  }
});

// Interrupt the model's current turn (`/stop`). Any turn-capable participant
// may stop a run they can drive; spectate is rejected at the gate.
add("POST", "/sessions/:id/interrupt", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  try {
    await interruptSession(params.id, guard.author);
    json(res, 200, { ok: true });
  } catch (e: any) {
    err(res, 500, e?.message ?? "interrupt failed");
  }
});

// Participant-to-participant chat: a message (optionally with images) that is
// persisted + broadcast to everyone in the session but NEVER written to the
// model's stdin. `>`-prefixed in the composer. Images here are already ≤512
// thumbnails (there's no model to send a full-res copy to). Any turn-capable
// participant may chat; spectate is read-only.
add("POST", "/sessions/:id/chat", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  let body: { text?: unknown; images?: unknown };
  try { body = await readJson(req, MAX_BYTES_TURN); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const text = typeof body.text === "string" ? body.text.slice(0, 10_000) : "";
  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > MAX_IMAGES_PER_TURN) return err(res, 413, `too many images (max ${MAX_IMAGES_PER_TURN})`);
  const images: TurnImage[] = [];
  let imgBytes = 0;
  for (const it of rawImages) {
    const o = it && typeof it === "object" ? (it as { media_type?: unknown; data?: unknown }) : {};
    if (typeof o.media_type !== "string" || !ALLOWED_IMAGE_MEDIA.has(o.media_type)) return err(res, 400, "unsupported image media_type");
    if (typeof o.data !== "string" || o.data.length === 0) return err(res, 400, "empty image data");
    const check = validateImageBase64(o.data, o.media_type, 1024);
    if (!check.ok) return err(res, 400, check.reason ?? "invalid image");
    imgBytes += o.data.length;
    images.push({ media_type: o.media_type, data: o.data });
  }
  if (imgBytes > MAX_EVENT_THUMBS_B64_BYTES) {
    return err(res, 413, `chat images too large (max ${Math.floor(MAX_EVENT_THUMBS_B64_BYTES / 1024)}KB total) — attach fewer or smaller images`);
  }
  if (!text.trim() && images.length === 0) return err(res, 400, "empty chat message");
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "Chat",
      ctx: { session_id: canonicalId, prompt: text, author: guard.author, images: images.length ? images : undefined },
    }));
    json(res, 200, { ok: true });
    // A chat is a side conversation — NEVER sent to the model — so it must not
    // wake the agent. Waking a dormant session (claude --resume) with no turn to
    // run makes claude exit immediately (non-zero in print mode), flipping the
    // session dormant→alive→ended in a flicker. We only mark activity so the
    // session surfaces/sorts as recently-active; its lifecycle correctly stays
    // whatever it was (a chat doesn't make the agent run).
    markSessionActive(canonicalId);
  } catch (e: any) {
    err(res, 500, e?.message ?? "chat failed");
  }
});

add("POST", "/sessions/:id/bash", async (req, res, params) => {
  // Dashboard `!cmd` shortcut: execute bash directly in the session's cwd,
  // bypass the model entirely, and synthesize a BashShortcut event so the
  // transcript shows it like any other tool call. No claude turn, no token
  // cost. Trust boundary is still the container — the agent user already
  // has shell, this just gives the dashboard composer a fast lane to it.
  const meta = getActiveSession(params.id);
  if (!meta) return err(res, 404, "unknown session");
  if (meta.status === "expired") return err(res, 409, "session expired");

  const guard = checkParticipant(req, meta.sessionId, "bash");
  if (!guard.ok) return err(res, guard.status, guard.reason);

  let body: { command?: unknown };
  try { body = await readJson(req, MAX_BYTES_MESSAGE); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.command !== "string" || body.command.trim().length === 0) {
    return err(res, 400, "missing required field: command");
  }
  // Peer hardening: the `!bash` fast lane bypasses the model + permission gate,
  // so a guest could otherwise read host secrets/tokens or push. Apply the peer
  // command policy here (the host is unrestricted).
  if (guard.isPeer) {
    const policy = peerBashAllowed(body.command);
    if (!policy.ok) return err(res, 403, policy.reason ?? "command not allowed for guests");
  }
  if (body.command.length > 16 * 1024) {
    return err(res, 413, "command too long (>16kb)");
  }

  const command = body.command;
  const cwd = meta.cwd;
  const startedAt = Date.now();
  const STDOUT_CAP = 1 * 1024 * 1024; // 1 MB
  const STDERR_CAP = 256 * 1024;       // 256 KB
  // Generous safety cap so genuinely long processes finish (was 30s, which made
  // long commands time out with a bare error). Still bounded so a hung/runaway
  // command can't linger forever — the kill surfaces as timed_out on the final
  // snapshot, not a request error.
  const HARD_CAP_MS = 10 * 60_000;

  // A `!bash` runs directly in the cwd and BYPASSES the model entirely, so it
  // must not wake the agent. Waking a dormant session (claude --resume) with no
  // turn to run makes claude exit immediately (non-zero in print mode), flipping
  // the session dormant→alive→ended in a flicker. We only mark activity so the
  // session surfaces/sorts as recently-active; its lifecycle correctly stays put
  // (running a shell command doesn't make the agent run). Events below are keyed
  // to `stableSid` (a snapshot) so co-driving peers receive them regardless.
  const stableSid = meta.sessionId;
  markSessionActive(stableSid);

  const { randomUUID } = await import("node:crypto");
  const runId = randomUUID();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutLen = 0;
  let stderrLen = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;

  // Emit one self-contained BashShortcut snapshot. `run_id` groups every
  // snapshot for this command into ONE live card in the transcript; `status`
  // flips running→done. Each snapshot carries the full output-so-far (capped),
  // so a dropped SSE frame can't leave the card stale — the latest snapshot is
  // complete on its own. Emitted under stableSid so co-driving peers get every
  // update despite a wake-triggered alias swap.
  const emitSnapshot = (
    status: "running" | "done",
    fin?: { exitCode: number | null; signal: NodeJS.Signals | null },
  ): number | null => {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        hook: "BashShortcut",
        ctx: {
          session_id: stableSid,
          author: guard.author,
          tool_name: "BashShortcut",
          tool_input: command,
          tool_response: {
            run_id: runId,
            status,
            exit_code: fin ? fin.exitCode : null,
            signal: fin ? fin.signal : null,
            duration_ms: Date.now() - startedAt,
            timed_out: timedOut,
            stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
            stderr: Buffer.concat(stderrChunks).toString("utf-8"),
            stdout_truncated: stdoutTruncated,
            stderr_truncated: stderrTruncated,
          },
        },
      });
      const r = ingestEventLine(line);
      if (!r.ok) log.warn("bash-shortcut", "snapshot ingest failed", { reason: r.reason });
      return r.ok ? (r.id ?? null) : null;
    } catch (e: any) {
      log.warn("bash-shortcut", "snapshot emit threw", { err: String(e?.message ?? e) });
      return null;
    }
  };

  // Show the running card immediately and RESPOND NOW — the command runs in the
  // background and streams updates over SSE. A long-running process therefore
  // no longer blocks (or times out) the request.
  const startEventId = emitSnapshot("running");
  json(res, 200, { ok: true, runId, eventId: startEventId });

  const { spawn } = await import("node:child_process");
  const child = spawn("bash", ["-lc", command], { cwd, env: { ...process.env } });

  const collect = (chunk: Buffer, chunks: Buffer[], len: number, cap: number): { len: number; truncated: boolean } => {
    if (len >= cap) return { len, truncated: true };
    const room = cap - len;
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room));
      return { len: cap, truncated: true };
    }
    chunks.push(chunk);
    return { len: len + chunk.length, truncated: false };
  };
  let dirty = false;
  child.stdout.on("data", (c: Buffer) => {
    const r = collect(c, stdoutChunks, stdoutLen, STDOUT_CAP);
    stdoutLen = r.len; stdoutTruncated ||= r.truncated; dirty = true;
  });
  child.stderr.on("data", (c: Buffer) => {
    const r = collect(c, stderrChunks, stderrLen, STDERR_CAP);
    stderrLen = r.len; stderrTruncated ||= r.truncated; dirty = true;
  });

  // Throttled live updates: at most one snapshot per FLUSH_MS, and only when
  // output actually changed — bounds event volume for chatty processes.
  const FLUSH_MS = 500;
  const flushTimer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    emitSnapshot("running");
    markSessionActive(stableSid); // keep the session reading as active while it runs
  }, FLUSH_MS);

  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }, HARD_CAP_MS);

  const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    clearTimeout(timer);
    clearInterval(flushTimer);
    emitSnapshot("done", { exitCode, signal });
    markSessionActive(stableSid);
  };
  child.once("close", (code, signal) => finish(code, signal));
  child.once("error", () => finish(null, null));
});

add("GET", "/sessions/:id/pending-requests", (_req, res, params) => {
  // Lets the dashboard re-hydrate the permission-card stack after a
  // page reload — SSE only delivers live, so without this an in-flight
  // ask would be invisible to a freshly-mounted client.
  // Strip the internal shareId: clients display `author` and act by
  // requestId; the trust grant is resolved sandbox-side.
  const requests = getPendingRequests(params.id).map(({ shareId, ...pub }) => pub);
  json(res, 200, { requests });
});

add("POST", "/sessions/:id/permission", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  // Base gate is "turn": a spectate peer (no turn capability) is rejected here.
  // Per-tool authority is then refined below once we know what's being decided.
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  let body: { requestId?: unknown; decision?: unknown; scope?: unknown; feedback?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.requestId !== "string" || body.requestId.length === 0) {
    return err(res, 400, "missing required field: requestId");
  }
  // What is being decided determines who may decide it:
  //   - AskUserQuestion → answering a question is input, not a gate decision;
  //     any turn-capable participant (host, full or drive peer) may answer.
  //   - ExitPlanMode (plan review) → approve/reject needs "permission" capability
  //     (host or a full peer), matching the share model.
  //   - everything else (Write/Edit/git push/…) → needs "permission" capability:
  //     the host or a full-access peer may allow/deny; drive/spectate cannot
  //     (their dashboard shows a read-only "waiting for the host" bubble).
  if (guard.isPeer) {
    const target = getPendingRequests(params.id).find((r) => r.requestId === body.requestId);
    const toolName = target?.toolName ?? null;
    if (toolName === "AskUserQuestion") {
      // turn capability already confirmed by the base gate — allow.
    } else if (toolName === "ExitPlanMode") {
      if (!capabilityAllows(guard.capability ?? "spectate", "permission")) {
        return err(res, 403, "your share can view the plan and comment, but only the host or a full-access peer can approve or reject it");
      }
    } else if (!capabilityAllows(guard.capability ?? "spectate", "permission")) {
      return err(res, 403, "your share can't approve tool use — only the host or a full-access peer can");
    }
  }
  if (body.decision !== "allow" && body.decision !== "deny") {
    return err(res, 400, "decision must be 'allow' or 'deny'");
  }
  // Host feedback (e.g. a plan rejection note) is relayed to the model as the
  // decision reason so it can revise. Bounded to keep the hook payload small.
  const feedback = typeof body.feedback === "string" && body.feedback.trim()
    ? body.feedback.slice(0, 4096)
    : null;
  // scope:"always" → grant the driving peer session-scoped auto-approve. git
  // push is still excluded from auto-approve at request-creation time, so the
  // host keeps that one guardrail even after granting trust.
  const trustPeer = body.scope === "always" && body.decision === "allow";
  try {
    const result = await respondToPermission(params.id, body.requestId, body.decision, feedback, trustPeer, guard.author);
    if (!result.ok) {
      return err(res, 404, result.reason);
    }
    json(res, 200, { ok: true });
  } catch (e: any) {
    err(res, 500, e?.message ?? "permission response failed");
  }
});

// ---------- Shared plan-review comments (host + peers) ----------
// Collaborative inline comments on a plan review, keyed by the plan's requestId.
// Everyone in the session may add comments/replies (checkParticipant "turn"
// lets peers through); edit/remove are author-scoped in the store. The dashboard
// polls the GET while the review panel is open, so every peer sees them live.
add("GET", "/sessions/:id/plan-comments", (req, res, params, url) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  const requestId = url?.searchParams.get("requestId");
  if (!requestId) return err(res, 400, "missing requestId");
  // `you` lets the client show edit/remove only on the caller's own comments.
  json(res, 200, { comments: listPlanReviewComments(requestId), you: guard.author });
});

add("POST", "/sessions/:id/plan-comments", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  let body: any;
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const requestId = typeof body.requestId === "string" ? body.requestId : null;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!requestId || !text) return err(res, 400, "missing requestId or body");
  const comment = addPlanReviewComment({
    requestId,
    author: guard.author,
    quote: typeof body.quote === "string" ? body.quote : "",
    offset: typeof body.offset === "number" ? body.offset : 0,
    length: typeof body.length === "number" ? body.length : 0,
    body: text,
  });
  json(res, 200, { comment });
});

add("POST", "/sessions/:id/plan-comments/reply", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  let body: any;
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (typeof body.requestId !== "string" || typeof body.commentId !== "string" || !text) {
    return err(res, 400, "missing requestId, commentId or body");
  }
  const ok = addPlanReviewReply({ requestId: body.requestId, commentId: body.commentId, author: guard.author, body: text });
  if (!ok) return err(res, 404, "comment not found");
  json(res, 200, { ok: true });
});

// edit + remove are author-scoped (store returns "forbidden" for a non-author).
for (const action of ["edit", "remove"] as const) {
  add("POST", `/sessions/:id/plan-comments/${action}`, async (req, res, params) => {
    const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
    const guard = checkParticipant(req, canonicalId, "turn");
    if (!guard.ok) return err(res, guard.status, guard.reason);
    let body: any;
    try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
    if (typeof body.requestId !== "string" || typeof body.commentId !== "string") {
      return err(res, 400, "missing requestId or commentId");
    }
    const result = action === "edit"
      ? editPlanReviewComment(body.requestId, body.commentId, guard.author, typeof body.body === "string" ? body.body : "")
      : removePlanReviewComment(body.requestId, body.commentId, guard.author);
    if (result === "notfound") return err(res, 404, "comment not found");
    if (result === "forbidden") return err(res, 403, "only the comment's author can modify it");
    json(res, 200, { ok: true });
  });
}

add("GET", "/sessions/:id/model", (_req, res, params) => {
  // Prefer the slot's configured `--model` (set at creation or by `/model`) so
  // a just-switched model shows immediately, before the next turn writes it to
  // the transcript. Fall back to the transcript-derived value (which reports
  // the resolved id the CLI actually ran) for sessions with no override.
  const configured = getActiveSession(params.id)?.model;
  if (configured) return json(res, 200, { model: configured });
  json(res, 200, getSessionModel(params.id));
});

// Switch the session's model (`/model <alias>`), effective immediately — the
// child is restarted on the new `--model`, aborting any in-flight turn. Any
// turn-capable participant may switch; spectate is rejected at the gate.
add("POST", "/sessions/:id/model", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  let body: { model?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const model = boundedString(body.model, 128);
  if (!model) return err(res, 400, "missing required field: model");
  // Same flag-injection guard as new-session: the CLI accepts arbitrary model
  // strings, so we only block the structural footgun.
  if (model.startsWith("-") || /\s/.test(model)) {
    return err(res, 400, "model must not start with '-' or contain whitespace");
  }
  try {
    const result = setSessionModel(params.id, model, guard.author);
    json(res, 200, { ok: true, ...result });
  } catch (e: any) {
    err(res, 500, e?.message ?? "model switch failed");
  }
});

add("GET", "/sessions/:id/summary", (_req, res, params) => {
  // Returns claude-mem's structured summary for the session, or null when
  // claude-mem hasn't indexed it yet (new session) or isn't installed.
  // The dashboard sidebar dropdown renders this in place of the raw
  // event tail; structured fields read better than a stream of hook rows.
  json(res, 200, { summary: getSessionSummary(params.id) });
});

add("GET", "/files", async (_req, res, _params, url) => {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) return err(res, 400, "missing required query param: cwd");
  const q = url.searchParams.get("q") ?? undefined;
  const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 100, fallback: 20 });
  try {
    const entries = await listFiles({ cwd, q, limit });
    json(res, 200, { entries });
  } catch (e: any) {
    if (e instanceof CwdPolicyError) return err(res, 400, e.message);
    err(res, 500, e?.message ?? "files lookup failed");
  }
});

add("GET", "/events", (_req, res, _params, url) => {
  const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 1000, fallback: 200 });
  const beforeStr = url.searchParams.get("before");
  const before = beforeStr ? parseInt(beforeStr, 10) : undefined;
  const hook = url.searchParams.get("hook") ?? undefined;
  const tool = url.searchParams.get("tool") ?? undefined;
  const session = url.searchParams.get("session") ?? undefined;
  json(res, 200, listEvents({ limit, before, hook, tool, session }));
});

// /events/stream is a static path. The router scans in registration order
// and a /events/:id route would otherwise eat it, so this MUST be declared
// before the :id route below.
const MAX_SSE_CLIENTS = parseInt(process.env.HOOP_MAX_SSE_CLIENTS ?? "", 10) || 50;
let sseClientCount = 0;

add("GET", "/events/stream", async (_req, res) => {
  if (sseClientCount >= MAX_SSE_CLIENTS) {
    res.setHeader("Retry-After", "10");
    return err(res, 503, "max sse clients");
  }
  sseClientCount += 1;
  startSessionsWatcher();
  startSkillsWatcher();
  startIngestor();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* connection closed */ }
  };

  res.write(`retry: 5000\n\n`);
  res.write(`: hoop sandbox event stream open\n\n`);

  const onEvent = (e: unknown) => send("event", e);
  const onSessions = () => send("sessions", { changed: true });
  const onSkills = () => send("skills", { changed: true });
  const onRunLink = (p: unknown) => { send("sessions", { changed: true }); send("run", p); };
  const onRunChunk = (p: unknown) => send("run-chunk", p);
  const onRunEnd = (p: unknown) => send("run-end", p);
  const onActiveChange = (p: unknown) => { send("sessions", { changed: true }); send("session-status", p); };
  const onActiveError = (p: unknown) => send("session-error", p);
  // Result-frame "turn" events update slot.meta.lastStats.totals
  // (cumulative tokens) but don't write to the session-watcher's
  // directory, so sessionsBus never sees them. Without this bridge the
  // dashboard's StatsStrip would never refresh after a completed turn.
  const onActiveTurn = () => send("sessions", { changed: true });

  eventBus.on("event", onEvent);
  sessionsBus.on("change", onSessions);
  skillsBus.on("change", onSkills);
  runsBus.on("link", onRunLink);
  runsBus.on("chunk", onRunChunk);
  runsBus.on("end", onRunEnd);
  activeSessionsBus.on("change", onActiveChange);
  activeSessionsBus.on("error", onActiveError);
  activeSessionsBus.on("turn", onActiveTurn);

  const hb = setInterval(() => {
    try { res.write(`: heartbeat\n\n`); } catch { /* closed */ }
  }, 20_000);

  const cleanup = () => {
    eventBus.off("event", onEvent);
    sessionsBus.off("change", onSessions);
    skillsBus.off("change", onSkills);
    runsBus.off("link", onRunLink);
    runsBus.off("chunk", onRunChunk);
    runsBus.off("end", onRunEnd);
    activeSessionsBus.off("change", onActiveChange);
    activeSessionsBus.off("error", onActiveError);
    activeSessionsBus.off("turn", onActiveTurn);
    clearInterval(hb);
    sseClientCount = Math.max(0, sseClientCount - 1);
  };
  res.on("close", cleanup);
});

add("GET", "/events/:id", (_req, res, params) => {
  const id = parseInt(params.id, 10);
  if (!Number.isFinite(id)) return err(res, 400, "invalid id");
  const row = getEvent(id);
  if (!row) return err(res, 404, "not found");
  json(res, 200, row);
});

// Hook-driven permission gate.
//
// Flow: PreToolUse hook (`permission-gate.sh`) inside the sandbox container
// POSTs the hook context here, gets a requestId, then long-polls
// /permission-wait until the dashboard responds via the existing
// /sessions/:id/permission endpoint. The dashboard never talks to these two
// routes — they're hook-only (X-Hook-Token).
add("POST", "/permission-ask", async (req, res) => {
  let body: any;
  try { body = await readJson(req, MAX_BYTES_INGEST); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (!body || typeof body !== "object") return err(res, 400, "body must be JSON");
  const sessionId = typeof body.session_id === "string" ? body.session_id : null;
  const toolName = typeof body.tool_name === "string" ? body.tool_name : null;
  if (!sessionId || !toolName) return err(res, 400, "missing session_id or tool_name");
  const toolUseId = typeof body.tool_use_id === "string" ? body.tool_use_id : null;
  const { requestId } = createPermissionRequest({
    sessionId,
    toolName,
    input: body.tool_input ?? body.input ?? null,
    toolUseId,
    requestId: toolUseId, // use claude's tool_use_id as our stable key
  });
  json(res, 200, { requestId });
}, "hook");

add("GET", "/permission-wait", async (req, res, _params, url) => {
  const requestId = url.searchParams.get("requestId");
  if (!requestId) return err(res, 400, "missing requestId");
  const rawTimeout = url.searchParams.get("timeout");
  const seconds = rawTimeout ? parseInt(rawTimeout, 10) : 30;
  const timeoutMs = (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : 30) * 1000;

  // Track client disconnects so we don't try to write a JSON response to a
  // closed socket. Curl in the hook script enforces a slightly-longer
  // max-time than our timeoutMs; if claude kills the hook for any reason
  // the socket closes mid-wait and Node would otherwise throw on res.end().
  let aborted = false;
  req.on("close", () => { aborted = true; });

  const result = await awaitPermissionDecision(requestId, timeoutMs);
  if (aborted || res.writableEnded) return;
  try { json(res, 200, result); } catch { /* socket closed between check and write */ }
}, "hook");

add("POST", "/ingest", async (req, res) => {
  startIngestor();
  const rid = reqId(req);
  let text: string;
  try { text = await readBody(req, MAX_BYTES_INGEST); } catch (e: any) { return err(res, e.status ?? 400, e.message, rid); }
  const trimmed = text.trim();
  if (!trimmed) return err(res, 400, "empty body", rid);
  let event: any;
  try { event = JSON.parse(trimmed); } catch { return err(res, 400, "invalid JSON body", rid); }
  if (!event || typeof event !== "object") return err(res, 400, "event must be a JSON object", rid);
  if (typeof event.hook !== "string" || !ALLOWED_HOOKS.has(event.hook)) {
    return err(res, 400, "unknown or missing hook name", rid);
  }
  // Attribution: stamp the sender on UserPromptSubmit so a shared session's
  // transcript can show "who sent this". The author was queued by
  // writeUserTurn (in stdin order); pop it here. Empty queue → null (a
  // replayed/compaction prompt or a turn not from the dashboard).
  let line = trimmed;
  if (event.hook === "UserPromptSubmit" && event.ctx && typeof event.ctx.session_id === "string") {
    if (event.ctx.author == null) {
      const { author, thumbnails, kind } = popPendingAuthor(event.ctx.session_id);
      if (author != null) event.ctx.author = author;
      // Persist ≤512 image thumbnails onto the turn's event so the transcript
      // (host + peers) can show what was attached. Kept small on purpose — the
      // full image goes only to the model, never into the broadcast event.
      if (thumbnails && thumbnails.length) event.ctx.images = thumbnails;
      // A lifecycle marker (e.g. "plan-approval") queued by writeUserTurn, so
      // the transcript can re-style this turn rather than show it as plain chat.
      if (kind != null) event.ctx.kind = kind;
      if (author != null || (thumbnails && thumbnails.length) || kind != null) line = JSON.stringify(event);
    }
  }
  // Turn over → drop the "model is thinking" flag so every viewer's indicator
  // clears (late joiners read it off the session row). Stop is claude's
  // authoritative end-of-turn signal; SubagentStop is a nested agent finishing,
  // NOT the turn, so it must not clear.
  if (event.hook === "Stop" && event.ctx && typeof event.ctx.session_id === "string") {
    markTurnFinished(event.ctx.session_id);
  }
  const result = ingestEventLine(line);
  if (!result.ok) {
    return err(res, 500, result.reason, rid);
  }
  json(res, 200, { ok: true, ...(result.id !== undefined ? { id: result.id } : {}) });
}, "hook");

add("GET", "/skills", (_req, res, _params, url) => {
  startSkillsWatcher();
  const cwd = url.searchParams.get("cwd");
  json(res, 200, listSkills(cwd));
});
add("GET", "/commands", (_req, res, _params, url) => {
  const cwd = url.searchParams.get("cwd");
  json(res, 200, listSlashCommands(cwd));
});
add("GET", "/mcps", (_req, res) => json(res, 200, listMcps()));
add("GET", "/stack", (_req, res) => json(res, 200, getStack()));
add("GET", "/identity", (_req, res) => json(res, 200, getIdentity()));

// ── Session sharing (peer co-drive) ─────────────────────────────────────────
// The sandbox owns share grants (durable + authoritative). The dashboard
// proxies these host-only routes; peer requests never reach them (peers can't
// mint or revoke shares). Capability is re-validated sandbox-side on the
// message/bash/permission routes so a compromised dashboard can't forge it.
const VALID_CAPABILITIES = new Set<ShareCapability>(["full", "drive", "spectate"]);

add("POST", "/shares", async (req, res) => {
  let body: {
    sessionId?: unknown;
    publicHost?: unknown;
    capability?: unknown;
    expiresInMs?: unknown;
    peerName?: unknown;
  };
  try { body = await readJson(req, MAX_BYTES_MESSAGE); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
    return err(res, 400, "missing required field: sessionId");
  }
  if (typeof body.publicHost !== "string" || body.publicHost.trim().length === 0) {
    return err(res, 400, "missing required field: publicHost");
  }
  // The session must exist (and be controllable) to be shareable.
  const meta = getActiveSession(body.sessionId);
  if (!meta) return err(res, 404, "unknown session");
  if (meta.status === "expired") return err(res, 409, "session expired");

  let capability: ShareCapability = "full";
  if (body.capability !== undefined) {
    if (typeof body.capability !== "string" || !VALID_CAPABILITIES.has(body.capability as ShareCapability)) {
      return err(res, 400, "invalid capability");
    }
    capability = body.capability as ShareCapability;
  }
  let expiresInMs: number | null = null;
  if (body.expiresInMs !== undefined && body.expiresInMs !== null) {
    if (typeof body.expiresInMs !== "number" || !Number.isFinite(body.expiresInMs) || body.expiresInMs <= 0) {
      return err(res, 400, "invalid expiresInMs");
    }
    expiresInMs = body.expiresInMs;
  }
  const peerName = typeof body.peerName === "string" && body.peerName.trim().length > 0
    ? body.peerName.trim().slice(0, 80)
    : null;

  const record = createShare({
    sessionId: meta.sessionId,
    publicHost: body.publicHost,
    capability,
    expiresInMs,
    peerName,
  });
  // The sandbox stores only grant metadata; the DASHBOARD signs the peer
  // token (it holds the HMAC secret). Return the record so the dashboard can
  // sign {shareId, sessionId, capability, host, exp}.
  json(res, 200, record);
});

add("POST", "/shares/:id/revoke", (_req, res, params) => {
  const result = revokeShare(params.id);
  if (!result.ok) return err(res, 404, "unknown share");
  dropJoinsForShare(params.id); // kill any pending/admitted joins on this share
  json(res, 200, { ok: true });
});

// Bulk revoke — clears EVERY share (and its joins) at once. The front process
// calls this when the tunnel goes down or stops (the tunnel host every share is
// bound to is gone, so the grants are dangling), and the shutdown drainer calls
// revokeAllShares() directly. Idempotent.
add("POST", "/shares/revoke-all", (_req, res) => {
  const { revoked } = revokeAllShares();
  for (const id of revoked) dropJoinsForShare(id);
  json(res, 200, { ok: true, revoked: revoked.length });
});

add("GET", "/shares", (_req, res) => json(res, 200, { shares: listShares() }));

// Redemption lookup: the dashboard's /api/share/redeem calls this to confirm a
// share exists for (shareId, host) before setting the peer cookie. Returns only
// non-secret material; the raw token is verified by the dashboard's node layer
// against the published validation file (hash compare), not here.
add("GET", "/shares/:id", (_req, res, params, url) => {
  const r = getShare(params.id);
  // Identical 404 for "no such share" and "host mismatch" — don't confirm
  // a share exists for a host the caller guessed.
  const host = url.searchParams.get("host");
  if (!r || (host && r.publicHost !== host.toLowerCase())) {
    return err(res, 404, "unknown share");
  }
  json(res, 200, {
    shareId: r.shareId,
    sessionId: r.sessionId,
    capability: r.capability,
    publicHost: r.publicHost,
    peerName: r.peerName,
    expiresAt: r.expiresAt,
  });
});

// ── Host-admits-each-join gate ───────────────────────────────────────────────
// A redeemed link creates a PENDING ticket here; the peer waits until the host
// admits. The peer credential is only issued (dashboard-side) after a claim of
// an admitted ticket. Deny revokes the share. The sandbox is the authority.

/** Redemption creates a pending join ticket. Session + peerName are taken from
 * the sandbox's own share record (not trusted from the caller). */
add("POST", "/join-request", async (req, res) => {
  let body: { shareId?: unknown; name?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.shareId !== "string" || body.shareId.length === 0) {
    return err(res, 400, "missing required field: shareId");
  }
  const share = getShare(body.shareId);
  if (!share) return err(res, 404, "unknown share");
  // The JOINING peer names themselves. Their chosen nickname becomes the
  // authoritative display name (attribution + admit prompt + presence),
  // falling back to any host-suggested default on the share. Persist it onto
  // the share so checkParticipant returns it for every peer-context call.
  const chosen = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : null;
  const peerName = chosen ?? share.peerName;
  if (chosen) setSharePeerName(share.shareId, chosen);
  const { ticketId, secret } = createJoinTicket({
    shareId: share.shareId,
    sessionId: share.sessionId,
    peerName,
  });
  // Notify the host live (event stream → host dashboard) + leave an audit trail.
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PeerJoinRequest",
      // `message` is what the dashboard transcript surfaces as the divider
      // label (deriveText → systemText), so name the peer there rather than
      // leaving a bare "[PeerJoinRequest]".
      ctx: { session_id: share.sessionId, peer_name: peerName, ticket_id: ticketId, message: `${peerName ?? "A guest"} asked to join` },
    }));
  } catch { /* non-fatal */ }
  json(res, 200, { ticketId, secret });
});

add("GET", "/join-status", (_req, res, _params, url) => {
  const ticketId = url.searchParams.get("ticket") ?? "";
  json(res, 200, { status: joinStatus(ticketId) });
});

add("POST", "/join-admit", async (req, res) => {
  let body: { ticketId?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.ticketId !== "string") return err(res, 400, "missing required field: ticketId");
  const r = admitJoin(body.ticketId);
  if (!r.ok) return err(res, 404, "unknown or already-resolved join");
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PeerJoinResolved",
      ctx: { session_id: r.ticket!.sessionId, peer_name: r.ticket!.peerName, ticket_id: body.ticketId, decision: "admit", message: `${r.ticket!.peerName ?? "A guest"} joined` },
    }));
  } catch { /* non-fatal */ }
  json(res, 200, { ok: true });
});

add("POST", "/join-deny", async (req, res) => {
  let body: { ticketId?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.ticketId !== "string") return err(res, 400, "missing required field: ticketId");
  const r = denyJoin(body.ticketId);
  if (!r.ok) return err(res, 404, "unknown or already-resolved join");
  // Deny is treated as hostile: revoke the whole share and drop its tickets.
  if (r.shareId) {
    revokeShare(r.shareId);
    dropJoinsForShare(r.shareId);
  }
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PeerJoinResolved",
      ctx: { ticket_id: body.ticketId, decision: "deny", peer_name: r.peerName ?? null, message: `${r.peerName ?? "A guest"}'s join was declined` },
    }));
  } catch { /* non-fatal */ }
  json(res, 200, { ok: true });
});

/** Claim an admitted ticket (one-time). Requires the redeeming browser's
 * secret. Returns the grant so the dashboard can issue the peer cookie. */
add("POST", "/join-claim", async (req, res) => {
  let body: { ticketId?: unknown; secret?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.ticketId !== "string" || typeof body.secret !== "string") {
    return err(res, 400, "missing required fields");
  }
  const grant = claimJoin(body.ticketId, body.secret);
  if (!grant) return err(res, 403, "not admitted");
  json(res, 200, grant);
});

add("GET", "/pending-joins", (_req, res) => json(res, 200, { joins: listPendingJoins() }));

add("GET", "/runs", (_req, res) => {
  const runs = listRuns().map((r) => ({
    runId: r.runId,
    skill: r.skill,
    args: r.args,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitCode: r.exitCode,
    pid: r.pid,
    sessionId: r.sessionId,
    outputBytes: r.outputBytes,
  }));
  json(res, 200, { runs });
});

add("GET", "/runs/:id", (_req, res, params) => {
  const run = getRun(params.id);
  if (!run) return err(res, 404, "not found");
  json(res, 200, run);
});

add("GET", "/agents", (_req, res, _params, url) => {
  const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 500, fallback: 50 });
  json(res, 200, listAgentRuns(limit));
});

add("GET", "/agents/:id", (_req, res, params) => {
  const n = parseInt(params.id, 10);
  if (!Number.isFinite(n)) return err(res, 400, "invalid id");
  const run = getAgentDetail(n);
  if (!run) return err(res, 404, "not found");
  json(res, 200, run);
});

add("POST", "/search", async (req, res) => {
  let body: { q?: unknown; type?: unknown; limit?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const q = typeof body.q === "string" ? body.q : "";
  const rawType = body.type;
  const type: SearchType = rawType === "semantic" || rawType === "hybrid" ? rawType : "bm25";
  const limit = clampInt(body.limit ?? 50, { min: 1, max: 200, fallback: 50 });
  json(res, 200, await search(q, type, limit));
});

// ---------- JSON: skill run ----------
//
// Returns 200 JSON { runId } immediately after the subprocess has been
// spawned. Run-progress events (chunks, end, errors) are multiplexed onto
// the existing /events/stream SSE channel via runsBus → the stream handler
// already forwards run-chunk / run-end frames, keyed by runId so each
// subscriber can filter for their own run.
//
// Error codes:
//   400 — invalid skill name or malformed args body
//   404 — skill or command not registered on this sandbox
//   500 — spawn failed for an unexpected reason
//
// req.on("close") is intentionally absent here: the response is not
// long-lived, so there is nothing to clean up on client disconnect.

add("POST", "/skill/:name/run", async (req, res, params) => {
  const skill = params.name;
  if (!isValidSkillName(skill)) return err(res, 400, "invalid skill name");

  let body: { args?: unknown };
  try { body = await readJson(req, MAX_BYTES_ARGS); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const args = boundedString(body.args, 8 * 1024) ?? undefined;

  let runId: string;
  try {
    ({ runId } = startSkillRun(skill, args));
  } catch (e: any) {
    const msg: string = e?.message ?? "spawn failed";
    if (e?.name === "TooManyConcurrentRunsError") {
      res.setHeader("Retry-After", "5");
      return err(res, 429, msg);
    }
    if (msg.startsWith("unknown skill or command")) return err(res, 404, msg);
    if (msg.startsWith("invalid skill name")) return err(res, 400, msg);
    return err(res, 500, msg);
  }

  json(res, 200, { runId });
});

// ---------- Dispatcher ----------

function authorize(req: IncomingMessage, route: Route): boolean {
  if (route.auth === "none") return true;
  if (route.auth === "hook") {
    return hookTokenMatches(getHeader(req, HOOK_TOKEN_HEADER));
  }
  return sandboxTokenMatches(getHeader(req, SANDBOX_TOKEN_HEADER));
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function dispatch(req: IncomingMessage, res: ServerResponse) {
  const rawUrl = req.url || "/";
  const url = new URL(rawUrl, "http://sandbox.local");
  const rid = reqId(req);

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const m = url.pathname.match(route.pattern);
    if (!m) continue;

    if (!authorize(req, route)) {
      return err(res, 401, "unauthorized", rid);
    }

    // Sandbox-side rate limit for mutating routes — defence-in-depth if the
    // dashboard is compromised or if some other client picks up the sandbox
    // token. Keyed on the inbound token (sandbox or hook, whichever applies)
    // since "valid token holder" is the unit we want to throttle.
    if (!SAFE_METHODS.has(req.method ?? "")) {
      const tokenHeader = route.auth === "hook" ? HOOK_TOKEN_HEADER : SANDBOX_TOKEN_HEADER;
      const key = getHeader(req, tokenHeader) ?? "unknown";
      const rate = mutatingLimiter.check(key);
      if (!rate.ok) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(rate.resetSec),
        };
        if (rid) headers[REQUEST_ID_HEADER] = rid;
        res.writeHead(429, headers);
        res.end(JSON.stringify({ error: "rate limit exceeded", ...(rid ? { requestId: rid } : {}) }));
        return;
      }
    }

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });

    try {
      await route.handler(req, res, params, url);
    } catch (e: any) {
      if (!res.headersSent) err(res, 500, e?.message ?? "handler failed", rid);
      else { try { res.end(); } catch { /* ignore */ } }
    }
    return;
  }

  err(res, 404, "not found", rid);
}

// ---------- Bootstrap ----------

export function createSandboxServer() {
  return createServer((req, res) => { void dispatch(req, res); });
}


// Exported for shutdown so SIGTERM can close cleanly. Set once in main().
let _running: import("node:http").Server | null = null;
let _backupTimer: NodeJS.Timeout | null = null;

const BACKUP_INTERVAL_MS = parseInt(process.env.HOOP_BACKUP_INTERVAL_MS ?? "", 10) || 60 * 60 * 1000;

async function main() {
  // Eagerly mint tokens so the dashboard sees them at startup.
  sandboxToken();
  hookToken();
  bootActiveSessions();
  startIdleSweeper();
  bootShares();
  startSessionsWatcher();
  startSkillsWatcher();
  startIngestor();
  // After the ingestor has drained events.jsonl, purge events for sessions that
  // no longer exist (deleted before delete-time purging, or stray pending-* ids)
  // so search / observability don't surface gone sessions.
  try { reconcileOrphanEvents(); } catch (err) { log.warn("boot", "orphan-events sweep skipped", { err: String(err) }); }

  // Keep the per-cwd project-skill watchers in sync with the live/dormant
  // session set: a session at any cwd should have its `<cwd>/.claude/skills`
  // watched so skills authored there refresh the dashboard live. Reconcile at
  // boot and whenever the session set changes (cheap set diff; no-op when the
  // cwd set is unchanged).
  const reconcileSkillWatchers = () => {
    try { syncProjectSkillWatchers(listActiveSessions().map((s) => s.cwd)); }
    catch { /* best-effort */ }
  };
  reconcileSkillWatchers();
  sessionsBus.on("change", reconcileSkillWatchers);

  _running = await listenOnSocket(SOCKET_PATH);

  // Hourly atomic backup of events.db to events.db.bak. The backup uses
  // SQLite's online backup API so it's safe to run while writers are active.
  // unref() so a missed tick doesn't keep the event loop alive past
  // shutdown; the explicit clearInterval in the SIGTERM path is the real
  // teardown.
  _backupTimer = setInterval(() => {
    backupEventsDb()
      .then((path) => log.debug("backup", "wrote events.db.bak", { path }))
      .catch((err) => log.error("backup", "failed", { err: String(err) }));
  }, BACKUP_INTERVAL_MS);
  _backupTimer.unref();

  // Drain on shutdown:
  //   1) stop accepting new HTTP connections (server.close)
  //   2) terminate live claude subprocesses owned by active-sessions
  //   3) flush the SQLite events DB to disk
  //
  // Docker sends SIGTERM and waits up to stop_grace_period (default 10s)
  // before SIGKILL; we cap our drain at 8s to stay inside that.
  registerShutdown({
    graceMs: 8_000,
    logger: log,
    drainer: async (signal) => {
      log.info("sandbox", "shutdown signal", { signal });

      if (_running) {
        // server.close() only stops accepting new connections; existing
        // SSE sockets (e.g. the dashboard's long-lived /events/stream) keep
        // the callback pending indefinitely. closeAllConnections() — added
        // in Node 18.2 — forcibly closes them so the drain completes
        // promptly. Without it, a partial restart (sandbox only) would
        // hang here until the 8s grace force-exits.
        _running.closeAllConnections?.();
        await new Promise<void>((resolve) => _running!.close(() => resolve()));
      }
      if (_backupTimer) { clearInterval(_backupTimer); _backupTimer = null; }
      try { stopSessionsWatcher(); } catch { /* ignore */ }
      try { stopSkillsWatcher(); } catch { /* ignore */ }
      // Clear all share grants on shutdown so `shares.json` can't carry dangling
      // links across a stop/start (the tunnel host they're bound to is gone).
      try { revokeAllShares(); } catch (e) {
        log.warn("sandbox", "revokeAllShares on shutdown failed", { err: String(e) });
      }
      try { await shutdownActiveSessions(); } catch (e) {
        log.warn("sandbox", "shutdownActiveSessions failed", { err: String(e) });
      }
      // Final durability pass: snapshot the DB and roll the WAL back into
      // the main file so the next start doesn't depend on the -wal sidecar.
      try { await backupEventsDb(); } catch (e) {
        log.warn("sandbox", "final backup failed (non-fatal)", { err: String(e) });
      }
      try { checkpointDb(); } catch { /* ignore */ }
      log.info("sandbox", "drained cleanly");
      process.exit(0);
    },
  });
}

export async function probeSocketAlive(socketPath: string, timeoutMs = 250): Promise<boolean> {
  const net = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

async function listenOnSocket(socketPath: string): Promise<import("node:http").Server> {
  if (existsSync(socketPath)) {
    if (await probeSocketAlive(socketPath)) {
      log.fatal("sandbox", "another sandbox is already listening; refusing to clobber", { socket: socketPath });
      process.exit(1);
    }
    try { unlinkSync(socketPath); } catch { /* stale; ignore */ }
  }
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(socketPath), { recursive: true });

    const server = createSandboxServer();
    server.once("error", reject);
    server.listen(socketPath, () => {
      // 0660 + group=hoop (gid 1100): the dashboard's node user is
      // added to that group in its Dockerfile. The shared group is the
      // right cross-container handle; falling back to 0660 root-only is
      // useless, so we don't.
      try {
        chmodSync(socketPath, 0o660);
        chownSync(socketPath, -1, 1100);
      } catch { /* ignore — perms may not be settable in dev/test */ }
      log.info("sandbox", "listening", { socket: socketPath });
      resolve(server);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    log.fatal("sandbox", "main crashed", { err: String(err) });
    process.exit(1);
  });
}
