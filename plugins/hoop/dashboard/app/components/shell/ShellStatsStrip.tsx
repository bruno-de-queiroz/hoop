"use client";
import type { SessionStats } from "@/app/context/hooks/useSessionStats";
import { formatTokens, formatDuration, prettyModel } from "../lib/format";
import { cn } from "../ui/cn";

// Center-pane stats sub-bar (Phase 3), matching the mockup's mono strip:
// `model X · time Y · tokens A in / B out · turns N` with a right-aligned ctx
// figure + fill bar (amber past 70%, rose past the 83% auto-compact line).

function ctxTone(pct: number): { text: string; bar: string } {
  if (pct >= 83) return { text: "text-fail", bar: "bg-fail" };
  if (pct >= 70) return { text: "text-live", bar: "bg-live" };
  return { text: "text-ink-soft", bar: "bg-ink-mute" };
}

export function ShellStatsStrip({
  stats,
  model,
}: {
  stats: SessionStats;
  model: string | null;
}) {
  const tone = ctxTone(stats.contextPct);
  const sep = <span className="text-ink-hush">·</span>;
  return (
    <div className="px-3 sm:px-5 py-2 shrink-0 flex items-center gap-x-3 gap-y-1 flex-wrap border-b border-divider font-mono text-[11px] text-ink-faint tabular-nums">
      <span>
        model <span className="text-ink-soft">{prettyModel(model) ?? "—"}</span>
      </span>
      {/* time / tokens / turns are secondary — hide them on phones (with their
        * leading separators) so the strip reads cleanly as `model … ctx`. */}
      <span className="hidden sm:inline-flex items-center gap-x-3">
        {sep}
        <span>
          time <span className="text-ink-soft">{formatDuration(stats.timeMs)}</span>
        </span>
        {sep}
        <span>
          tokens <span className="text-ink-soft">{formatTokens(stats.inputTokens)}</span> in /{" "}
          <span className="text-ink-soft">{formatTokens(stats.outputTokens)}</span> out
        </span>
        {sep}
        <span>
          turns <span className="text-ink-soft">{stats.turns}</span>
        </span>
      </span>
      <span className="ml-auto flex items-center gap-2">
        <span>
          ctx <span className={tone.text}>{stats.contextLimit > 0 ? `${stats.contextPct}%` : "—"}</span>
        </span>
        <span className="relative h-1.5 w-20 sm:w-28 rounded-full overflow-hidden bg-sunken">
          <span
            className={cn(
              "absolute inset-y-0 left-0 motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-smooth",
              tone.bar,
            )}
            style={{ width: `${Math.min(100, stats.contextPct)}%` }}
          />
          {/* auto-compact line at 83% */}
          <span className="absolute inset-y-0 w-px bg-ink-hush" style={{ left: "83%" }} />
        </span>
      </span>
    </div>
  );
}
