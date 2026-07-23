export type SessionLifecycle = "alive" | "dormant" | "ended" | "expired" | "error";

export interface SessionInfo {
  // fs cache fields
  id: string;
  path: string;
  mtime: string;
  size: number;

  // parsed from JSON body
  sessionId?: string;
  pid?: number;
  cwd?: string;
  entrypoint?: string;
  kind?: string;
  version?: string;
  status?: string;
  startedAt?: number;
  updatedAt?: number;

  // spawn decoration (skill run metadata)
  skill?: string;
  skillArgs?: string;
  runId?: string;

  // registry decoration (active-sessions metadata)
  controllable?: boolean;
  lifecycle?: SessionLifecycle;
  // True while a model turn is in flight. Broadcast to all viewers so the
  // "model is thinking" indicator shows for every peer — including late
  // joiners, who pick it up from this row rather than the live event stream.
  turnActive?: boolean;
  displayName?: string | null;
  // Historical session_ids this conversation is also known by — populated
  // by the sandbox after `claude --resume` minted a new internal id, or
  // after a pending-X spawn id swap. ActiveSessionPanel reads this on
  // load so events arriving under any prior id still match the transcript.
  aliases?: string[];
  // Per-turn telemetry from the last result frame. The dashboard's
  // SessionStatsHeader renders model / mode / context fill / time / tokens
  // from this. Versioned (`v: 1`) so future schema changes can fall back.
  lastStats?: {
    v: 1;
    model?: string | null;
    mode?: string | null;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
    turnDurationMs?: number;
    turnEndedAt?: number;
    // Context window (denominator for "ctx %") this session's model runs
    // against, and the percentage at which auto-compaction is configured to
    // fire. Reported by the sandbox at spawn; the dashboard prefers these over
    // its own model-limits table so the meter agrees with the real config.
    contextWindow?: number;
    autoCompactPct?: number;
    // Cumulative tokens across the whole session. Computed sandbox-side
    // at end-of-turn; absent until the first turn completes.
    totals?: {
      input_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      output_tokens: number;
      turns: number;
    };
  };
}
