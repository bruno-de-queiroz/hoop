"use client";
import { memo, useEffect, useRef, useState } from "react";
import { Sparkles, Terminal, ArrowUp, MessageCircle, CheckCircle2, PencilLine, AlertTriangle } from "lucide-react";
import type { EventRow } from "@/lib/sandbox-client";
import {
  userPromptText,
  assistantText,
  toolArgsText,
  toolResultText,
  bashShortcutData,
  systemText,
} from "../active-session/eventText";
import { Markdown } from "../Markdown";
import { cn } from "../ui/cn";

// Center-pane transcript (Phase 3) — the signature surface. Mirrors the legacy
// Transcript's event classification (PreToolUse/PostToolUse pairing, dedup of
// resume-boundary Session events) but renders each item as the mockup's chat
// thread: host/peer bubbles right, assistant bubbles + sparkles avatar left,
// tool-call cards, bash-shortcut cards, and centered system notices. Reads the
// same event stream as the legacy panel via the provider — no data changes.

function clockTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Host vs peer from the event's attribution, matching the legacy AuthorChip
// convention: `author` is the literal "host", a named guest, or null/absent —
// anything that isn't a named guest is the host. A host chat/prompt must render
// as host (green bubble, "host" label), never as a peer.
function authorTone(row: EventRow): "host" | "peer" {
  return row.author && row.author !== "host" ? "peer" : "host";
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="flex-1 h-px bg-divider" />
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">{label}</span>
      <span className="flex-1 h-px bg-divider" />
    </div>
  );
}

// accent → the model (Sparkles); fail → a `!bash` command (Terminal `>_`);
// error → a failed turn / API error (AlertTriangle). `fail` is specifically the
// terminal glyph, so it must NOT be reused for non-bash failures.
function AssistantAvatar({ tone = "accent" }: { tone?: "accent" | "fail" | "error" }) {
  const Icon = tone === "error" ? AlertTriangle : tone === "fail" ? Terminal : Sparkles;
  return (
    <span
      className={cn(
        "avatar w-7 h-7 shrink-0 mt-0.5",
        tone === "accent" ? "avatar-accent" : "avatar-fail",
      )}
    >
      <Icon className="w-3.5 h-3.5" />
    </span>
  );
}

// Every row renderer is memoized on its (stable) EventRow. When a new event
// arrives the parent rebuilds the item list, but React reuses each prior item's
// element by key — memo keeps those from re-rendering, so old bubbles never
// re-parse Markdown just because a newer message came in.
const HostBubble = memo(function HostBubble({
  row,
  tone,
  chat = false,
}: {
  row: EventRow;
  tone: "host" | "peer";
  // A `chat` message (`>`) is broadcast to participants but never sent to the
  // model — a side conversation. Marked with a subtle chat glyph + a softer
  // bubble so it reads as aside chatter, not a turn the agent acts on.
  chat?: boolean;
}) {
  const text = userPromptText(row);
  const images = Array.isArray(row.images) ? row.images : [];
  const author = tone === "peer" ? `${row.author ?? "peer"} · peer` : "host";
  return (
    <div className="flex flex-col items-end gap-1" data-testid={chat ? undefined : "user-prompt"}>
      <div className="flex items-center gap-1.5 pr-1">
        {chat && (
          <MessageCircle
            className={cn("w-3 h-3 shrink-0", tone === "peer" ? "text-sdk" : "text-ink-faint")}
            aria-label="chat"
          />
        )}
        <span
          className={cn(
            "text-[10px] uppercase tracking-wide",
            tone === "peer" ? "text-sdk" : "text-ink-faint",
          )}
        >
          {author}
        </span>
        <span className="font-mono text-[10px] text-ink-faint">{clockTime(row.ts)}</span>
      </div>
      <div
        className={cn(
          "bubble px-3.5 py-2.5 text-[13px] leading-relaxed",
          tone === "peer" ? "bubble-peer" : "bubble-host",
          // Subtle aside treatment for chat: a hairline inset ring + a touch of
          // transparency, distinct from a solid prompt bubble without shouting.
          chat && "ring-1 ring-inset ring-white/15 opacity-95",
        )}
      >
        {text && (
          <div className="break-words">
            <Markdown source={text} fileChips />
          </div>
        )}
        {images.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", text && "mt-2")}>
            {images.map((img, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={`data:${img.media_type};base64,${img.data}`}
                alt="attached image"
                className="max-h-48 max-w-[14rem] rounded-lg object-contain border border-white/20"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

// The host's plan-review decision (approve / request-changes) is injected into
// the conversation as a user turn so the model acts on it — but in the
// transcript it isn't ordinary chat, it's a lifecycle event. The sandbox tags
// it via `kind` ("plan-approval" / "plan-rejection"); we render a centered
// notice instead of a host bubble so the history reads clearly. Approval shows
// just who approved; rejection also surfaces the feedback the model was given.
const REJECT_PREFIX = /^The plan was rejected\. Revise it based on this feedback:\s*/;

const PlanDecisionNotice = memo(function PlanDecisionNotice({
  row,
  variant,
}: {
  row: EventRow;
  variant: "approval" | "rejection";
}) {
  const approved = variant === "approval";
  const who = row.author && row.author !== "host" ? row.author : "host";
  const feedback = approved ? "" : userPromptText(row).replace(REJECT_PREFIX, "").trim();
  const Icon = approved ? CheckCircle2 : PencilLine;
  return (
    <div className="flex justify-center">
      <div
        className={cn(
          "inline-flex max-w-[85%] flex-col gap-1 rounded-xl px-3.5 py-2 text-[12px] ring-1 ring-inset",
          approved
            ? "bg-wrap/10 ring-wrap/30 text-wrap"
            : "bg-live/10 ring-live/30 text-live",
        )}
      >
        <div className="flex items-center gap-1.5 font-medium">
          <Icon className="w-3.5 h-3.5 shrink-0" />
          <span>{approved ? "Plan approved" : "Changes requested"}</span>
          <span className="text-ink-faint font-normal">· {who}</span>
          <span className="font-mono text-[10px] text-ink-faint font-normal">{clockTime(row.ts)}</span>
        </div>
        {!approved && feedback && (
          <div className="whitespace-pre-wrap break-words text-ink-soft">{feedback}</div>
        )}
      </div>
    </div>
  );
});

// A slash-command turn (`/plan`, `/cost`, a plugin command, …). It IS a host
// action, so it stays right-aligned with the host label — but it's an
// instruction to the tooling, not conversational prose, so it renders as a
// compact accent-tinted monospace command line (slash glyph + command text)
// rather than an ordinary chat bubble. The sandbox tags these `kind="command"` and
// restores the original typed text (see writeUserTurn), so `/plan add caching`
// shows verbatim here even though the model only received "add caching".
const CommandCard = memo(function CommandCard({
  row,
  tone,
}: {
  row: EventRow;
  tone: "host" | "peer";
}) {
  const text = userPromptText(row);
  // Split the command token (`/plan`) from its arguments so the token sits in
  // the accent badge and the args read as ordinary text beside it.
  const match = /^(\/\S+)\s*([\s\S]*)$/.exec(text.trim());
  const command = match ? match[1] : text.trim();
  const args = match ? match[2].trim() : "";
  const author = tone === "peer" ? `${row.author ?? "peer"} · peer` : "host";
  return (
    <div className="flex flex-col items-end gap-1" data-testid="command-turn">
      <div className="flex items-center gap-1.5 pr-1">
        <span
          className={cn(
            "text-[10px] uppercase tracking-wide",
            tone === "peer" ? "text-sdk" : "text-ink-faint",
          )}
        >
          {author}
        </span>
        <span className="font-mono text-[10px] text-ink-faint">{clockTime(row.ts)}</span>
      </div>
      <div className="flex items-center gap-2 rounded-xl px-3 py-2 font-mono text-[12px] ring-1 ring-inset ring-accent/30 bg-accent/[0.08] text-ink max-w-full">
        <span className="flex h-5 p-1 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent font-semibold leading-none">
          {command}
        </span>
        {args && <span className="break-all text-ink">{args}</span>}
      </div>
    </div>
  );
});

const AssistantBubble = memo(function AssistantBubble({ row }: { row: EventRow }) {
  const text = assistantText(row);
  return (
    <div className="flex items-start gap-2.5">
      <AssistantAvatar />
      <div className="min-w-0 flex flex-col gap-1.5">
        <div className="bubble bubble-assistant msg-wide px-3.5 py-3 text-[13px] leading-relaxed">
          <Markdown source={text} />
        </div>
        <span className="font-mono text-[10px] text-ink-faint pl-1">{clockTime(row.ts)}</span>
      </div>
    </div>
  );
});

// An API failure surfaced by claude as a synthetic frame — a usage/rate limit,
// an overload, an auth failure. The sandbox tags these kind=error (distinct from
// the kind=info catch-all, which also carries benign notices like /cost output).
// Rendering it as an assistant bubble implied the model had answered; this reads
// as what it is — the turn failed, nothing was produced.
const ErrorNotice = memo(function ErrorNotice({ row }: { row: EventRow }) {
  const text = assistantText(row);
  return (
    <div className="flex items-start gap-2.5">
      <AssistantAvatar tone="error" />
      <div
        className="min-w-0 msg-wide rounded-2xl px-3.5 py-3 ring-1 ring-inset ring-fail/30"
        style={{ background: "color-mix(in oklab, rgb(var(--fail)) 10%, rgb(var(--elevated)))" }}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-fail">
            turn failed
          </span>
          <span className="font-mono text-[10px] text-ink-faint">{clockTime(row.ts)}</span>
        </div>
        <p className="text-[13px] leading-relaxed text-ink-soft mt-1.5 whitespace-pre-wrap break-words">
          {text}
        </p>
      </div>
    </div>
  );
});

const ToolCard = memo(function ToolCard({ pre, post }: { pre: EventRow; post?: EventRow }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = pre.tool_name ?? "tool";
  const args = toolArgsText(pre);
  const result = post ? toolResultText(post) : null;
  const hasResult = result != null && result.length > 0;
  const LIMIT = 300;
  const long = hasResult && result!.length > LIMIT;
  const shown = long && !expanded ? result!.slice(0, LIMIT) : result;
  return (
    <div className="flex items-start gap-2.5">
      <AssistantAvatar />
      <div className="min-w-0 flex flex-col gap-1.5">
        <div className="tool-card px-3 py-2 msg-wide">
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className="shrink-0 text-wrap">●</span>
            <span className="text-ink-soft">{toolName}</span>
            {args && <span className="truncate text-ink-faint">{args}</span>}
            <span className="ml-auto shrink-0 chip text-[9px] px-1.5 py-0.5 text-ink-faint">tool</span>
          </div>
          {hasResult && (
            <div className="mt-1.5 flex items-start gap-1.5 font-mono text-[11px] text-ink-faint">
              <span className="text-ink-hush">⎿</span>
              <div className="min-w-0 flex-1">
                <pre className="m-0 whitespace-pre-wrap break-words text-ink-faint">{shown}</pre>
                {long && (
                  <button
                    onClick={() => setExpanded((v) => !v)}
                    className="mt-0.5 text-[10px] text-ink-faint hover:text-ink-mute"
                  >
                    {expanded ? "show less" : `show ${result!.length - LIMIT} more chars`}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

const BashCard = memo(function BashCard({ row }: { row: EventRow }) {
  const data = bashShortcutData(row);
  const command = data?.command ?? "";
  const running = data?.status === "running";
  const exitCode = data?.exitCode;
  const timedOut = data?.timedOut ?? false;
  const stdout = data?.stdout ?? "";
  const stderr = data?.stderr ?? "";
  const hasOutput = stdout.length > 0 || stderr.length > 0;
  const exitLabel = timedOut
    ? "timed out"
    : exitCode == null ? "" : exitCode === 0 ? "exit 0" : `exit ${exitCode}`;
  return (
    <div className="flex items-start gap-2.5">
      <AssistantAvatar tone="fail" />
      <div className="min-w-0 font-mono text-[11px] msg-wide rounded-xl px-3 py-2.5 bg-sunken border border-divider">
        <div className="flex items-baseline gap-1.5">
          <span aria-hidden className="text-fail">$</span>
          <span className="chip text-[9px] uppercase tracking-wide px-1.5 py-px shrink-0 text-ink-faint">
            host
          </span>
          <span className="truncate text-ink-soft">{command}</span>
          {running ? (
            <span className="ml-auto flex items-center gap-1 whitespace-nowrap text-[10px] text-live">
              <span className="w-1.5 h-1.5 rounded-full bg-live motion-safe:animate-pulse" />
              running
            </span>
          ) : (
            exitLabel && (
              <span
                className={cn(
                  "ml-auto whitespace-nowrap text-[10px]",
                  !timedOut && exitCode === 0 ? "text-wrap" : "text-fail",
                )}
              >
                {exitLabel}
              </span>
            )
          )}
        </div>
        {hasOutput ? (
          <div className="mt-2 pt-2 border-t border-divider">
            {stdout && <div className="whitespace-pre-wrap text-ink-soft">{stdout}</div>}
            {stderr && <div className="whitespace-pre-wrap text-fail">{stderr}</div>}
          </div>
        ) : (
          running && <div className="mt-2 pt-2 border-t border-divider text-ink-faint">waiting for output…</div>
        )}
      </div>
    </div>
  );
});

function Waiting() {
  return (
    <div className="flex items-end gap-2.5" data-testid="waiting-indicator">
      <AssistantAvatar />
      <div className="bubble bubble-assistant px-4 py-3 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-live motion-safe:animate-pulse" />
        <span className="w-1.5 h-1.5 rounded-full bg-live motion-safe:animate-pulse [animation-delay:200ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-live motion-safe:animate-pulse [animation-delay:400ms]" />
      </div>
    </div>
  );
}

export const ShellTranscript = memo(function ShellTranscript({
  events,
  hasMore,
  onLoadMore,
  isWaiting,
}: {
  events: EventRow[];
  hasMore: boolean;
  onLoadMore: () => void;
  isWaiting: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const prevLenRef = useRef(0);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  }

  const lastEventId = events.length > 0 ? events[events.length - 1].id : 0;
  useEffect(() => {
    if (events.length === 0) wasAtBottomRef.current = true;
    const justLoaded = prevLenRef.current === 0 && events.length > 0;
    prevLenRef.current = events.length;
    if (!wasAtBottomRef.current && !justLoaded) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, lastEventId, isWaiting]);

  // Mirror the legacy dedup: only the FIRST SessionStart and a TERMINAL
  // SessionEnd are genuine boundaries (every /stop + /model churns a pair).
  let firstStartIdx = -1;
  let lastStartIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].hook_type === "SessionStart") {
      if (firstStartIdx === -1) firstStartIdx = i;
      lastStartIdx = i;
    }
  }

  // Coalesce streaming BashShortcut snapshots: a `!bash` emits many events that
  // share a run_id (start → throttled progress → done). Render ONE card, anchored
  // at the FIRST snapshot's position (so it doesn't jump to the bottom as updates
  // arrive) but showing the LATEST snapshot's data. Legacy single-shot events
  // (no run_id) fall back to one-card-per-event.
  const bashByRun = new Map<string, { firstId: number; latest: EventRow }>();
  for (const e of events) {
    if (e.hook_type !== "BashShortcut") continue;
    const rid = bashShortcutData(e)?.runId;
    if (!rid) continue;
    const cur = bashByRun.get(rid);
    if (!cur) bashByRun.set(rid, { firstId: e.id, latest: e });
    else cur.latest = e; // events are oldest→newest here, so the last one wins
  }

  const items: { key: string; node: React.ReactNode }[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    switch (e.hook_type) {
      case "SessionStart":
        if (i === firstStartIdx) items.push({ key: `s-${e.id}`, node: <Divider label="session start" /> });
        break;
      case "SessionEnd":
        if (i > lastStartIdx) items.push({ key: `e-${e.id}`, node: <Divider label="session end" /> });
        break;
      case "UserPromptSubmit":
        if (e.kind === "plan-approval" || e.kind === "plan-rejection") {
          items.push({
            key: `u-${e.id}`,
            node: <PlanDecisionNotice row={e} variant={e.kind === "plan-approval" ? "approval" : "rejection"} />,
          });
        } else if (e.kind === "command") {
          items.push({ key: `u-${e.id}`, node: <CommandCard row={e} tone={authorTone(e)} /> });
        } else {
          items.push({ key: `u-${e.id}`, node: <HostBubble row={e} tone={authorTone(e)} /> });
        }
        break;
      case "Stop":
      case "SubagentStop":
        if ((e.text ?? "").trim().length > 0) {
          // An API failure (usage/rate limit, overload) is NOT the model talking
          // — the sandbox tags it kind=error. Show it as a failure rather than as
          // an assistant reply, which is what it used to look like.
          items.push({
            key: `a-${e.id}`,
            node: e.kind === "error" ? <ErrorNotice row={e} /> : <AssistantBubble row={e} />,
          });
        }
        break;
      case "PreToolUse": {
        const next = events[i + 1];
        if (next && next.hook_type === "PostToolUse" && e.tool_name != null && next.tool_name === e.tool_name) {
          items.push({ key: `t-${e.id}-${next.id}`, node: <ToolCard pre={e} post={next} /> });
          i += 1;
        } else {
          items.push({ key: `t-${e.id}`, node: <ToolCard pre={e} /> });
        }
        break;
      }
      case "PostToolUse":
        items.push({ key: `to-${e.id}`, node: <ToolCard pre={e} post={e} /> });
        break;
      case "BashShortcut": {
        const rid = bashShortcutData(e)?.runId;
        if (rid) {
          const grp = bashByRun.get(rid);
          // Only the first snapshot anchors the card; later snapshots for the
          // same run are absorbed (the anchor renders the latest data). Stable
          // key by run id so React updates the card in place.
          if (grp && e.id === grp.firstId) {
            items.push({ key: `b-${rid}`, node: <BashCard row={grp.latest} /> });
          }
        } else {
          items.push({ key: `b-${e.id}`, node: <BashCard row={e} /> });
        }
        break;
      }
      case "Chat":
        items.push({ key: `c-${e.id}`, node: <HostBubble row={e} tone={authorTone(e)} chat /> });
        break;
      case "PermissionRequest":
      case "PermissionResponse":
        break;
      default: {
        const t = systemText(e);
        items.push({
          key: `n-${e.id}`,
          node: <Divider label={(t || e.hook_type || "event").toLowerCase()} />,
        });
        break;
      }
    }
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      data-testid="shell-transcript"
      className="flex-1 min-h-0 overflow-y-auto px-5 py-5 flex flex-col gap-4"
    >
      {hasMore && (
        <div className="flex justify-center pb-1">
          <button onClick={onLoadMore} className="pill-btn text-[11px] px-3 py-1.5">
            <ArrowUp className="w-3.5 h-3.5" /> load earlier
          </button>
        </div>
      )}
      {items.length === 0 && !isWaiting ? (
        <p className="font-mono text-[11px] text-ink-faint">waiting for first turn…</p>
      ) : (
        <>
          {items.map((it) => (
            <div key={it.key} className="motion-safe:animate-msg-in">
              {it.node}
            </div>
          ))}
          {isWaiting && <Waiting />}
        </>
      )}
    </div>
  );
});
