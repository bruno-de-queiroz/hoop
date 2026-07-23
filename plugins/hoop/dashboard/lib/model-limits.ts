/**
 * Context-window sizes per Claude model, used as the denominator for the
 * dashboard's "ctx N%" indicator.
 *
 * These are the REAL published windows (Claude docs, as of 2026-07): the
 * current 1M-context tier (Opus 4.6+, Sonnet 5 / Sonnet 4.6, Fable 5,
 * Mythos 5) vs. the 200k tier (Sonnet 4.5, Haiku, older models).
 *
 * History: this table used to hardcode 200k across the board to mirror an
 * old Claude Code TUI bug that computed every model against 200k. Anthropic
 * fixed that upstream in Claude Code v2.1.126 ("Opus 4.7 sessions showing
 * inflated /context percentages ... computing against 200K instead of Opus
 * 4.7's native 1M"), so mirroring it here just pinned 1M sessions at a fake
 * 100%. We now track the real windows.
 *
 * NOTE: the sandbox has its own copy of this mapping in
 * plugins/hoop/sandbox/lib/active-sessions.ts (windowForModel) because the
 * two packages don't share imports. Keep them in sync.
 *
 * Match prefixes (longest first) so fully qualified ids like
 * "claude-sonnet-4-6-20250101" still resolve cleanly.
 */
const M = 1_000_000;
const K200 = 200_000;

const TABLE: Array<[string, number]> = [
  // 1M-context tier
  ["claude-opus-4-8",   M],
  ["claude-opus-4-7",   M],
  ["claude-opus-4-6",   M],
  ["claude-sonnet-4-6", M],
  ["claude-sonnet-5",   M],
  ["claude-fable-5",    M],
  ["claude-mythos-5",   M],
  // 200k-context tier
  ["claude-opus-4-5",   K200],
  ["claude-sonnet-4-5", K200],
  ["claude-haiku-4-5",  K200],
  ["claude-haiku-4-4",  K200],
  // Generic family fallbacks. Opus is 1M across the current lineup; haiku is
  // 200k. Sonnet is mixed (5/4.6 are 1M, 4.5 is 200k) so the bare "claude-sonnet"
  // fallback stays conservative at 200k — a fully-qualified id above wins first.
  ["claude-opus",       M],
  ["claude-haiku",      K200],
  ["claude-sonnet",     K200],
];

const DEFAULT_LIMIT = K200;

/**
 * Percentage of the context window at which auto-compaction is configured to
 * trigger (see the sandbox spawn env). Used to place the marker line and the
 * "rose" warning tone on the stats strip. The sandbox reports the effective
 * value per session in `lastStats.autoCompactPct`; this is the fallback.
 */
export const AUTO_COMPACT_PCT = 85;

export function contextWindowFor(model?: string | null): number {
  if (!model) return DEFAULT_LIMIT;
  const lower = model.toLowerCase();
  for (const [prefix, size] of TABLE) {
    if (lower.startsWith(prefix)) return size;
  }
  return DEFAULT_LIMIT;
}

/**
 * Total tokens consumed by the most recent turn's INPUT side (regular +
 * cache creation + cache read). This is the figure to compare against the
 * model's context window for the "ctx %" indicator; output_tokens doesn't
 * count toward the limit.
 */
export function totalInputTokens(usage?: {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
}
