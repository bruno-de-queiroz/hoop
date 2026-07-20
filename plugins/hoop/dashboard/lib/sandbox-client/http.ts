import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { log } from "@shared/logger";
import { openSseConnection } from "./sse";

import type {
  ActiveSessionMeta,
  RunMeta,
  AgentRun,
  SearchType,
  SearchResponse,
  McpsResponse,
  StackResponse,
  IdentityResponse,
  EventsQuery,
  EventRowFull,
  FileEntry,
  FilesQuery,
  FilesResponse,
  SessionInfo,
  SessionSummary,
  ShareRecord,
  Skill,
  SlashCommand,
} from "@/lib/sandbox-types";

export interface SandboxError extends Error {
  status?: number;
}

/** A shared inline comment on a plan review (see the sandbox store). */
export interface PlanReviewComment {
  id: string;
  author: string | null;
  quote: string;
  offset: number;
  length: number;
  body: string;
  replies: { id: string; author: string | null; body: string; at: number }[];
  at: number;
}

/** A base64 image attached to a user turn (vision). `data` is the full image
 * sent to the model; `thumb` is an optional ≤512px JPEG persisted in the event
 * stream and shown in the transcript (kept small for the peer broadcast). */
export interface TurnImage {
  media_type: string;
  data: string;
  thumb?: string;
}

export interface SandboxClient {
  boot(): void;
  /**
   * Stop the SSE reconnect loop and abort the active long-lived connection.
   * Idempotent. Wired from instrumentation-node.ts SIGTERM so the dashboard
   * releases its sandbox connection cleanly when the container stops.
   */
  shutdown(): void;

  startNewConversation(opts: {
    // Optional git URL to clone into the sandbox workspace on start; the session
    // cwd becomes that clone (or the default workspace when omitted). Replaces
    // the old free-text cwd — the dashboard no longer picks a folder directly.
    gitRepo?: string | null;
    label?: string;
    name?: string | null;
    model?: string | null;
    runId?: string | null;
    via?: "new-conversation" | "skill";
  }, participant?: string): Promise<{ sessionId: string; meta: ActiveSessionMeta }>;
  listSessions(): Promise<SessionInfo[]>;
  writeUserTurn(sessionId: string, text: string, participant?: string, images?: TurnImage[]): Promise<{ sessionId: string }>;
  /** Participant-to-participant chat — persisted + broadcast, never sent to the
   * model. `images` are ≤512 thumbnails (base64). */
  sendChat(sessionId: string, text: string, images?: TurnImage[], participant?: string): Promise<{ ok: boolean }>;
  /** Interrupt the model's in-flight turn (`/stop`). */
  interruptSession(sessionId: string, participant?: string): Promise<{ ok: boolean }>;
  /** Switch the session's model (`/model <alias>`); restarts the child on the
   * new model, aborting any in-flight turn. */
  setSessionModel(sessionId: string, model: string, participant?: string): Promise<{ ok: boolean; sessionId: string; model: string | null }>;
  /**
   * Direct bash execution in the session's cwd. Bypasses the model and
   * synthesizes a `BashShortcut` event so the transcript still shows it.
   */
  // The bash shortcut now streams: the sandbox emits a "running" BashShortcut
  // snapshot and returns immediately, then streams throttled snapshots + a
  // final "done" snapshot over SSE (all keyed by runId). The response no longer
  // carries the result — the transcript assembles it from the events.
  runBashShortcut(sessionId: string, command: string, participant?: string): Promise<{
    ok: boolean;
    runId: string;
    eventId: number | null;
  }>;
  /**
   * Open permission asks the model emitted via `control_request` and is
   * still waiting on. The dashboard hydrates its card stack from this on
   * page reload (SSE only delivers live).
   */
  listPendingRequests(sessionId: string): Promise<{
    requests: Array<{
      requestId: string;
      toolUseId: string | null;
      toolName: string;
      input: unknown;
      decisionReason: string | null;
      receivedAt: number;
      /** "host" or a peer's name — who drove the turn this ask came from. */
      author?: string | null;
    }>;
  }>;
  /** Answer a pending permission ask. `scope:"always"` additionally grants the
   * driving peer session-scoped auto-approve ("allow all from $peer"). `feedback`
   * is relayed to the model as the decision reason — used by a plan rejection so
   * the agent revises against the host's notes. */
  respondToPermission(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
    participant?: string,
    scope?: "once" | "always",
    feedback?: string,
  ): Promise<{ ok: boolean }>;
  /** Shared plan-review comments (host + peers). */
  listPlanComments(sessionId: string, requestId: string, participant?: string): Promise<{ comments: PlanReviewComment[]; you: string | null }>;
  addPlanComment(sessionId: string, input: { requestId: string; quote: string; offset: number; length: number; body: string }, participant?: string): Promise<{ comment: PlanReviewComment }>;
  addPlanReply(sessionId: string, input: { requestId: string; commentId: string; body: string }, participant?: string): Promise<{ ok: boolean }>;
  editPlanComment(sessionId: string, input: { requestId: string; commentId: string; body: string }, participant?: string): Promise<{ ok: boolean }>;
  removePlanComment(sessionId: string, input: { requestId: string; commentId: string }, participant?: string): Promise<{ ok: boolean }>;
  endSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<{ deleted: boolean }>;
  renameSession(sessionId: string, name: string): Promise<ActiveSessionMeta | null>;
  getSessionModel(sessionId: string): Promise<{ model: string | null }>;
  getSessionSummary(sessionId: string): Promise<{ summary: SessionSummary | null }>;

  listEvents(query: EventsQuery): Promise<import("@/lib/sandbox-types").EventRow[]>;
  getEvent(id: number, opts?: { session?: string }): Promise<EventRowFull | null>;

  listFiles(query: FilesQuery): Promise<FileEntry[]>;

  isValidSkillName(name: string): boolean;
  startSkillRun(skill: string, args?: string, participant?: string): Promise<{ runId: string }>;
  listRuns(): Promise<RunMeta[]>;
  getRun(runId: string): Promise<RunMeta | undefined>;

  listSkills(opts?: { cwd?: string }): Promise<Skill[]>;
  listSlashCommands(opts?: { cwd?: string }): Promise<SlashCommand[]>;
  listMcps(): Promise<McpsResponse>;
  getStack(): Promise<StackResponse>;
  getIdentity(): Promise<IdentityResponse>;

  listAgentRuns(limit?: number): Promise<AgentRun[]>;
  getAgentDetail(id: number): Promise<AgentRun | null>;

  search(q: string, type: SearchType, limit: number, session?: string): Promise<SearchResponse>;

  // ── Session sharing (peer co-drive) ──────────────────────────────────────
  /** Register a share grant. The sandbox stores metadata only; the dashboard
   * signs the peer token. Returns the grant record. */
  createShare(opts: {
    sessionId: string;
    publicHost: string;
    capability?: "full" | "drive" | "spectate";
    expiresInMs?: number | null;
    peerName?: string | null;
  }): Promise<ShareRecord>;
  revokeShare(shareId: string): Promise<{ ok: boolean }>;
  listShares(): Promise<{ shares: ShareRecord[] }>;
  /** Authoritative revocation/scope check (used to gate peer-context calls). */
  validateShare(shareId: string, opts: { host?: string; sessionId?: string }): Promise<ShareRecord | null>;

  // Host-admits-each-join gate.
  /** Register a pending join for a redeemed share. `name` is the peer's chosen
   * nickname (overrides any host-suggested default). */
  createJoinTicket(shareId: string, name?: string | null): Promise<{ ticketId: string; secret: string }>;
  /** Poll a ticket's admission status. */
  joinStatus(ticketId: string): Promise<{ status: "pending" | "admitted" | "denied" | "expired" }>;
  /** Host: admit a pending join. */
  admitJoin(ticketId: string): Promise<{ ok: boolean }>;
  /** Host: deny a pending join (revokes the share sandbox-side). */
  denyJoin(ticketId: string): Promise<{ ok: boolean }>;
  /** Claim an admitted ticket (one-time); returns the grant to issue a cookie. */
  claimJoin(ticketId: string, secret: string): Promise<{ shareId: string; sessionId: string; peerName: string | null } | null>;
  /** Host: list pending joins for the Admit/Deny UI. */
  listPendingJoins(): Promise<{ joins: Array<{ ticketId: string; shareId: string; sessionId: string; peerName: string | null; createdAt: number }> }>;
  /** Record that a peer left a session (emits a `PeerLeft` transcript divider).
   * `name` is a cosmetic label for the marker. */
  peerLeave(sessionId: string, name?: string | null): Promise<{ ok: boolean }>;

  eventBus: EventEmitter;
  sessionsBus: EventEmitter;
  runsBus: EventEmitter;
  activeSessionsBus: EventEmitter;
  skillsBus: EventEmitter;
}

// Concern C: four related mutable closure variables are grouped into one
// state object so their relationship is explicit. Exported so sse.ts can
// reference the type without a circular dependency.
export interface SseLoopState {
  timer: NodeJS.Timeout | null;
  resolve: (() => void) | null;
  stopped: boolean;
  started: boolean;
  activeSseReq: ReturnType<typeof httpRequest> | null;
}

const SANDBOX_TOKEN_HEADER = "x-sandbox-token";
const REQUEST_ID_HEADER = "x-request-id";
const DEFAULT_TIMEOUT_MS = 30_000;

// Pure regex; same shape the sandbox enforces server-side. Keeps the input
// validation in the route layer cheap (no round-trip for an obvious reject).
const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$/;

function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

function sandboxError(message: string, status?: number): SandboxError {
  const e: SandboxError = new Error(message);
  if (status != null) e.status = status;
  return e;
}

/** Forward the resolved participant to the sandbox so it can re-validate the
 * share (revocation/scope) + capability and attribute the action. */
function participantOpts(participant?: string): { headers?: Record<string, string> } {
  return participant ? { headers: { "x-hoop-participant": participant } } : {};
}

interface RawResponse {
  status: number;
  body: string;
  requestId: string;
}

function rawHttpRequest(
  socketPath: string,
  method: string,
  path: string,
  body: string | null,
  token: string,
  opts: { timeoutMs?: number; requestId: string; headers?: Record<string, string> },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      ...(opts.headers ?? {}),
      [SANDBOX_TOKEN_HEADER]: token,
      [REQUEST_ID_HEADER]: opts.requestId,
    };
    if (body != null) {
      headers["content-type"] = "application/json; charset=utf-8";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const req = httpRequest(
      { socketPath, method, path, headers, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            requestId: opts.requestId,
          });
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => {
      req.destroy(sandboxError(`sandbox request timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms (rid=${opts.requestId})`, 504));
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

export function createHttpClient(socketPath: string): SandboxClient {
  const tokenFile = process.env.HOOP_SANDBOX_TOKEN_FILE
    || "/var/run/hoop/sandbox.token";

  let cachedToken: string | null = null;

  function readToken(): string | null {
    if (cachedToken) return cachedToken;
    try {
      const t = readFileSync(tokenFile, "utf-8").trim();
      cachedToken = t || null;
      return cachedToken;
    } catch {
      return null;
    }
  }
  function invalidateToken() { cachedToken = null; }

  async function request<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<T> {
    const token = readToken();
    if (!token) throw sandboxError("sandbox token unavailable", 503);
    const payload = body == null ? null : JSON.stringify(body);
    const requestId = randomUUID();

    let res = await rawHttpRequest(socketPath, method, path, payload, token, { ...opts, requestId });
    if (res.status === 401) {
      invalidateToken();
      const fresh = readToken();
      if (fresh && fresh !== token) {
        res = await rawHttpRequest(socketPath, method, path, payload, fresh, { ...opts, requestId });
      }
    }
    if (res.status >= 400) {
      let msg: string = `sandbox ${res.status}`;
      try { const parsed = JSON.parse(res.body); if (parsed?.error) msg = parsed.error; } catch { /* ignore */ }
      throw sandboxError(`${msg} (rid=${requestId})`, res.status);
    }
    if (!res.body) return undefined as T;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw sandboxError(`invalid JSON from sandbox (rid=${requestId})`, 502);
    }
  }

  function encode(path: string, query?: Record<string, string | number | undefined>): string {
    if (!query) return path;
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v != null) sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `${path}?${qs}` : path;
  }

  // Locally-owned EventEmitters populated by a long-lived SSE subscription to
  // the sandbox's combined /events/stream feed. Routes subscribe to these
  // exactly as if the data lived in-process — they don't know there's a
  // network hop underneath.
  const localEventBus = new EventEmitter();
  const localSessionsBus = new EventEmitter();
  const localRunsBus = new EventEmitter();
  const localActiveSessionsBus = new EventEmitter();
  const localSkillsBus = new EventEmitter();
  for (const bus of [localEventBus, localSessionsBus, localRunsBus, localActiveSessionsBus, localSkillsBus]) {
    bus.setMaxListeners(100);
  }

  // Concern C: four related mutable closure variables are grouped into one
  // state object so their relationship is explicit. Behavior is unchanged.
  const state: SseLoopState = {
    timer: null,
    resolve: null,
    stopped: false,
    started: false,
    activeSseReq: null,
  };

  function ensureSse() {
    if (state.started) return;
    state.started = true;
    void runSseLoop();
  }

  function shutdown() {
    state.stopped = true;
    // Destroy any in-flight SSE request, whether it's still connecting or
    // already streaming. state.activeSseReq is assigned synchronously after
    // the httpRequest() call so this covers the connect/handshake window too.
    try { state.activeSseReq?.destroy(); } catch { /* ignore */ }
    // Cancel the reconnect-backoff sleep so the while-loop can break now.
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
      if (state.resolve) {
        const r = state.resolve;
        state.resolve = null;
        r();
      }
    }
  }

  async function runSseLoop() {
    let backoff = 250;
    while (!state.stopped) {
      try {
        await openSseConnection({
          socketPath,
          readToken,
          invalidateToken,
          sandboxError,
          state,
          buses: {
            eventBus: localEventBus,
            sessionsBus: localSessionsBus,
            runsBus: localRunsBus,
            activeSessionsBus: localActiveSessionsBus,
            skillsBus: localSkillsBus,
          },
        });
        backoff = 250;
      } catch (err: any) {
        if (state.stopped) break;
        if (err?.code !== "ECONNREFUSED" && err?.code !== "ENOENT") {
          log.error("sandbox-client", "sse loop error", { err });
        }
      }
      if (state.stopped) break;
      await new Promise<void>((resolve) => {
        state.resolve = resolve;
        state.timer = setTimeout(() => {
          state.timer = null;
          state.resolve = null;
          resolve();
        }, backoff);
      });
      backoff = Math.min(backoff * 2, 5000);
    }
  }

  return {
    boot() { ensureSse(); },
    shutdown,

    startNewConversation: (opts, participant) => request("POST", "/sessions", opts, participantOpts(participant)),
    listSessions: () => request("GET", "/sessions"),
    writeUserTurn: async (sessionId, text, participant, images) => {
      const res = await request<{ ok: boolean; sessionId: string }>(
        "POST",
        `/sessions/${encodeURIComponent(sessionId)}/message`,
        images && images.length ? { text, images } : { text },
        participantOpts(participant),
      );
      return { sessionId: res.sessionId };
    },
    interruptSession: (sessionId, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/interrupt`, {}, participantOpts(participant)),
    setSessionModel: (sessionId, model, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/model`, { model }, participantOpts(participant)),
    sendChat: (sessionId, text, images, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/chat`, images && images.length ? { text, images } : { text }, participantOpts(participant)),
    runBashShortcut: (sessionId, command, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/bash`, { command }, participantOpts(participant)),
    listPendingRequests: (sessionId) =>
      request("GET", `/sessions/${encodeURIComponent(sessionId)}/pending-requests`),
    respondToPermission: (sessionId, requestId, decision, participant, scope, feedback) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/permission`, { requestId, decision, ...(scope ? { scope } : {}), ...(feedback ? { feedback } : {}) }, participantOpts(participant)),
    listPlanComments: (sessionId, requestId, participant) =>
      request("GET", `/sessions/${encodeURIComponent(sessionId)}/plan-comments?requestId=${encodeURIComponent(requestId)}`, undefined, participantOpts(participant)),
    addPlanComment: (sessionId, input, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/plan-comments`, input, participantOpts(participant)),
    addPlanReply: (sessionId, input, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/plan-comments/reply`, input, participantOpts(participant)),
    editPlanComment: (sessionId, input, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/plan-comments/edit`, input, participantOpts(participant)),
    removePlanComment: (sessionId, input, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/plan-comments/remove`, input, participantOpts(participant)),
    endSession: async (sessionId) => {
      await request("POST", `/sessions/${encodeURIComponent(sessionId)}/end`);
    },
    deleteSession: async (sessionId) => {
      const res = await request<{ ok: boolean; deleted: boolean }>(
        "DELETE",
        `/sessions/${encodeURIComponent(sessionId)}`
      );
      return { deleted: res.deleted };
    },
    renameSession: async (sessionId, name) => {
      const res = await request<{ ok: boolean; meta: ActiveSessionMeta }>(
        "PATCH",
        `/sessions/${encodeURIComponent(sessionId)}`,
        { name }
      );
      return res.meta;
    },
    getSessionModel: (sessionId) =>
      request("GET", `/sessions/${encodeURIComponent(sessionId)}/model`),
    getSessionSummary: (sessionId) =>
      request("GET", `/sessions/${encodeURIComponent(sessionId)}/summary`),

    listEvents: (q) => request("GET", encode("/events", {
      limit: q.limit, before: q.before, hook: q.hook, tool: q.tool, session: q.session,
    })),
    getEvent: async (id, opts) => {
      const path = opts?.session
        ? `/events/${id}?session=${encodeURIComponent(opts.session)}`
        : `/events/${id}`;
      try {
        return await request<EventRowFull>("GET", path);
      } catch (e: any) {
        if (e?.status === 404) return null;
        throw e;
      }
    },

    listFiles: async (q) => {
      const res = await request<FilesResponse>(
        "GET",
        encode("/files", { cwd: q.cwd, q: q.q, limit: q.limit }),
      );
      return res.entries;
    },

    isValidSkillName,
    startSkillRun: async (skill, args, participant) => {
      const res = await request<{ runId: string }>(
        "POST",
        `/skill/${encodeURIComponent(skill)}/run`,
        { args },
        participantOpts(participant),
      );
      return { runId: res.runId };
    },
    listRuns: () => request<{ runs: RunMeta[] }>("GET", "/runs").then((r) => r.runs),
    getRun: async (id) => {
      try {
        return await request<RunMeta>("GET", `/runs/${encodeURIComponent(id)}`);
      } catch (e: any) {
        if (e?.status === 404) return undefined;
        throw e;
      }
    },

    listSkills: (opts?: { cwd?: string }) =>
      request("GET", opts?.cwd ? `/skills?cwd=${encodeURIComponent(opts.cwd)}` : "/skills"),
    listSlashCommands: (opts?: { cwd?: string }) =>
      request("GET", opts?.cwd ? `/commands?cwd=${encodeURIComponent(opts.cwd)}` : "/commands"),
    listMcps: () => request("GET", "/mcps"),
    getStack: () => request("GET", "/stack"),
    getIdentity: () => request("GET", "/identity"),

    listAgentRuns: (limit) =>
      request("GET", encode("/agents", { limit })),
    getAgentDetail: async (id) => {
      try {
        return await request<AgentRun>("GET", `/agents/${id}`);
      } catch (e: any) {
        if (e?.status === 404) return null;
        throw e;
      }
    },

    search: (q, type, limit, session) =>
      request("POST", "/search", { q, type, limit, ...(session ? { session } : {}) }),

    createShare: (opts) => request("POST", "/shares", opts),
    revokeShare: (shareId) =>
      request("POST", `/shares/${encodeURIComponent(shareId)}/revoke`, {}),
    listShares: () => request("GET", "/shares"),
    validateShare: async (shareId, opts) => {
      try {
        const qs = opts.host ? `?host=${encodeURIComponent(opts.host)}` : "";
        return await request<ShareRecord>("GET", `/shares/${encodeURIComponent(shareId)}${qs}`);
      } catch (e: any) {
        if (e?.status === 404) return null;
        throw e;
      }
    },

    createJoinTicket: (shareId, name) => request("POST", "/join-request", { shareId, name: name ?? null }),
    joinStatus: (ticketId) => request("GET", `/join-status?ticket=${encodeURIComponent(ticketId)}`),
    admitJoin: (ticketId) => request("POST", "/join-admit", { ticketId }),
    denyJoin: (ticketId) => request("POST", "/join-deny", { ticketId }),
    claimJoin: async (ticketId, secret) => {
      try {
        return await request("POST", "/join-claim", { ticketId, secret });
      } catch (e: any) {
        if (e?.status === 403) return null;
        throw e;
      }
    },
    listPendingJoins: () => request("GET", "/pending-joins"),
    peerLeave: (sessionId, name) => request("POST", "/peer-leave", { sessionId, name: name ?? null }),

    eventBus: localEventBus,
    sessionsBus: localSessionsBus,
    runsBus: localRunsBus,
    activeSessionsBus: localActiveSessionsBus,
    skillsBus: localSkillsBus,
  };
}
