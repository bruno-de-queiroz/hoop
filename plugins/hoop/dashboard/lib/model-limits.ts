/**
 * Context-window sizes per Claude model.
 *
 * IMPORTANT: this table is intentionally 200k across the board. The goal is
 * to **match Claude Code's TUI exactly**, including its known staleness for
 * the 1M-context rollout. Claude Code's CLI hardcodes the denominator
 * (see `getContextWindowForModel()` upstream) and currently maps
 * opus-4-7 [1M] / sonnet-4-6 [1M] to 200k as well — issue #49931.
 *
 * Do NOT "fix" this to the real published context window for individual
 * models. If you do, the dashboard's "ctx N%" will silently disagree with
 * what the user sees in `claude`, and the 83% auto-compact line on the
 * bar will be off relative to what actually triggers compaction.
 *
 * When Anthropic patches Claude Code's table, mirror those changes here.
 *
 * Match prefixes (longest first) so that fully qualified ids like
 * "claude-sonnet-4-6-20250101" still resolve cleanly.
 */
const TABLE: Array<[string, number]> = [
  ["claude-opus-4-7",   200_000],
  ["claude-opus-4-6",   200_000],
  ["claude-opus-4-5",   200_000],
  ["claude-sonnet-4-7", 200_000],
  ["claude-sonnet-4-6", 200_000],
  ["claude-sonnet-4-5", 200_000],
  ["claude-haiku-4-5",  200_000],
  ["claude-haiku-4-4",  200_000],
  ["claude-opus",       200_000],
  ["claude-sonnet",     200_000],
  ["claude-haiku",      200_000],
];

const DEFAULT_LIMIT = 200_000;

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
