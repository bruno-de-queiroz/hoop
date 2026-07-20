/**
 * Public type surface of the sandbox API, as consumed by the dashboard.
 *
 * These mirror the shapes the sandbox returns over the wire. Phase 3 deleted
 * the dashboard's copies of the source modules; the dashboard now talks to the
 * sandbox over a Unix socket and only needs these structural types to validate
 * the JSON it gets back.
 */

export type { SessionInfo, SessionLifecycle } from "./types/session";

export type LifecycleStatus = "alive" | "dormant" | "ended" | "expired" | "error";

export interface ActiveSessionMeta {
  sessionId: string;
  runId: string | null;
  label: string;
  displayName: string | null;
  cwd: string;
  via: "skill" | "new-conversation" | "resumed";
  startedAt: number;
  lastSeenAt: number;
  status: LifecycleStatus;
  pid?: number;
  exitCode?: number | null;
  errorMessage?: string;
}

export interface RunMeta {
  runId: string;
  skill: string;
  args: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  pid?: number;
  sessionId?: string;
  output: string;
  outputBytes: number;
}

export interface RunChunk {
  runId: string;
  skill: string;
  kind: "stdout" | "stderr";
  data: string;
}

export interface RunEnd {
  runId: string;
  skill: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface Skill {
  name: string;
  description: string | null;
  path: string;
  source: "user" | "plugin";
  plugin?: string;
}

export interface SlashCommand {
  name: string;
  description: string | null;
  plugin: string;
  kind: "command" | "skill" | "builtin";
}

export interface AgentRun {
  id: number;
  sessionId: string | null;
  subagentType: string | null;
  model: string | null;
  prompt: string | null;
  description: string | null;
  startTs: string;
  endTs: string | null;
  durationMs: number | null;
  toolUseCount: number | null;
  result: string | null;
  parentAgentId: number | null;
  status: "running" | "completed" | "interrupted";
}

export type SearchType = "bm25" | "semantic" | "hybrid";

export interface SearchResult {
  id: number;
  ts: string;
  session_id: string | null;
  hook_type: string | null;
  tool_name: string | null;
  text: string | null;
  score: number;
  rank: number;
  bm25_rank?: number;
  vec_distance?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  type: SearchType;
  total: number;
  meta: {
    bm25_used: boolean;
    semantic_used: boolean;
    semantic_unavailable?: string;
  };
}

export interface McpServer {
  name: string;
  scope: "user" | "project" | "plugin";
  type: string;
  target: string;
  envKeys: string[];
  project?: string;
  plugin?: string;
}

export interface McpsResponse {
  servers: McpServer[];
}

export interface InstalledPlugin {
  key: string;
  name: string;
  marketplace: string;
  version: string;
  installedAt: string;
}

export interface StackResponse {
  plugins: InstalledPlugin[];
  memory: { plugin: string; version: string } | null;
  installLog: { exists: boolean; lines: number; summary: Record<string, string> };
}

export interface IdentityResponse {
  authenticated: boolean;
  fullName?: string | null;
  displayName?: string | null;
  role?: string | null;
  company?: string | null;
  emailAddress?: string | null;
  organizationName?: string | null;
  organizationRole?: string | null;
  organizationType?: string | null;
  seatTier?: string | null;
  accountUuid?: string | null;
  profileMarkdown?: string | null;
  profileSource?: string | null;
}

export interface EventsQuery {
  limit?: number;
  before?: number;
  hook?: string;
  tool?: string;
  session?: string;
}

export interface EventRow {
  id: number;
  ts: string;
  session_id: string | null;
  hook_type: string | null;
  tool_name: string | null;
  text: string | null;
  // Shared-session attribution: "host", a guest's name, or null/absent.
  author?: string | null;
  // ≤512px base64 image thumbnails attached to a user turn, or null/absent.
  images?: { media_type: string; data: string }[] | null;
  // Lifecycle marker for a non-chat turn — e.g. "plan-approval" / "plan-rejection"
  // for the host's plan-review decision. Lets the transcript re-style the turn
  // instead of showing it as an ordinary host bubble. Null/absent for normal turns.
  kind?: string | null;
  // Set ONLY for events that fired inside a subagent (claude's ctx.agent_id on
  // sidechain PreToolUse/PostToolUse/SubagentStop). The main transcript hides
  // these — subagent activity belongs in the Agents rail. Null/absent otherwise.
  agent_id?: string | null;
}

export interface EventRowFull extends EventRow {
  payload: unknown;
}

export interface FilesQuery {
  cwd: string;
  q?: string;
  limit?: number;
}

export interface FileEntry {
  name: string;
  isDir: boolean;
}

export interface FilesResponse {
  entries: FileEntry[];
}

/**
 * Per-session structured summary, sourced from claude-mem's session_summaries
 * table. Each field can independently be null when claude-mem hasn't yet
 * produced that piece. The whole record is null when claude-mem isn't
 * installed or hasn't indexed the session at all.
 */
export interface SessionSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  nextSteps: string | null;
  createdAt: string;
}

export type ShareCapability = "full" | "drive" | "spectate";

/** A peer co-drive grant. Mirrors sandbox/lib/shares.ts ShareRecord. */
export interface ShareRecord {
  shareId: string;
  sessionId: string;
  capability: ShareCapability;
  publicHost: string;
  peerName: string | null;
  createdAt: number;
  expiresAt: number | null;
  revoked: boolean;
}
