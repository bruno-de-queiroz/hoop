"use client";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Maximize2, Minimize2, MoreHorizontal, Share2 } from "lucide-react";
import type { SessionInfo } from "@/lib/types/session";
import type { SessionMeta } from "@/app/context/hooks/useSessionMeta";
import type { PresenceParticipant } from "@/app/context/hooks/usePresence";
import { useSessions } from "@/app/context/SessionsProvider";
import { useSharingLive } from "@/app/context/hooks/useSharingLive";
import { useCenterFullscreen } from "./ShellChrome";
import { sessionDisplayLabel } from "../lib/format";
import { isHostClient, isPeerClient, canAdmitPeers, useMounted } from "../lib/participant";
import { cn } from "../ui/cn";

// Center-pane header (Phase 3): lifecycle dot, session name (click to rename),
// host-only session switcher, presence stack + typing, cwd chip, live pill, and
// share / ⋯ actions. Reads sessions from the provider; rename/remove/share are
// handed down from the provider via props.

function lifecycleDot(lc: string | null): { cls: string; title: string } {
  switch (lc) {
    case "alive": return { cls: "bg-wrap", title: "alive" };
    case "error": return { cls: "bg-fail", title: "error" };
    case "dormant":
    case "ended": return { cls: "bg-ink-hush", title: lc };
    default: return { cls: "bg-ink-hush", title: lc ?? "—" };
  }
}

export function ShellSessionHeader({
  session,
  meta,
  selectedId,
  participants,
  onSelect,
  onRename,
  onShare,
  onDelete,
  onLeave,
}: {
  session: SessionInfo | null;
  meta: SessionMeta;
  selectedId: string | null;
  participants: PresenceParticipant[];
  onSelect: (id: string) => void;
  onRename: (name: string) => Promise<void>;
  onShare: () => void;
  onDelete: () => Promise<void>;
  /** Peer-only: leave the shared session (drops access, needs a fresh admit to
   * return). Undefined for the host, who deletes rather than leaves. */
  onLeave?: () => Promise<void>;
}) {
  const { sessions } = useSessions();
  // Mount-gated: the server always reads as host, so default to host until
  // mounted to keep hydration stable (see participant.ts).
  const mounted = useMounted();
  const isHost = mounted ? isHostClient() : true;
  const isPeer = mounted && isPeerClient();
  // Host OR a full-capability peer (co-host) may open the Share dialog to
  // mint/manage links. Defaults to true pre-mount (server renders as host).
  const canShare = mounted ? canAdmitPeers() : true;
  // For a peer, name the host from the presence roster ("shared by X").
  const hostName = participants.find((p) => p.kind === "host")?.name ?? null;
  const { fullscreen, toggle: toggleFullscreen } = useCenterFullscreen();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The ⋯ menu lives in the right-side actions cluster, OUTSIDE wrapRef, so it
  // needs its own ref: without it a `mousedown` on a menu item counts as an
  // "outside" click and tears the menu down before the item's `click` fires —
  // i.e. Delete session silently no-ops for real (mousedown-first) clicks.
  const menuRef = useRef<HTMLDivElement>(null);

  const label = session ? sessionDisplayLabel(session) : "session";
  const lc = meta.lifecycle ?? session?.lifecycle ?? null;
  const dot = lifecycleDot(lc);
  // The "live" pill means broadcasting (tunnel up + a share exists), NOT the
  // session's own lifecycle — see useSharingLive.
  const live = useSharingLive();

  useEffect(() => {
    if (!switcherOpen && !menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      const inWrap = wrapRef.current?.contains(target);
      const inMenu = menuRef.current?.contains(target);
      if (!inWrap && !inMenu) {
        setSwitcherOpen(false);
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [switcherOpen, menuOpen]);

  const alives = sessions.filter((s) => (s.lifecycle ?? "alive") === "alive" && s.sessionId);
  const inactives = sessions.filter(
    (s) => s.sessionId && ["dormant", "ended"].includes(s.lifecycle ?? "alive"),
  );

  function commitRename() {
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== label) void onRename(name);
  }

  return (
    <div className="px-3 sm:px-5 h-14 shrink-0 flex items-center gap-2 sm:gap-3 border-b border-divider">
      <div ref={wrapRef} className="relative flex items-center gap-1.5 min-w-0">
        <span className={cn("w-2 h-2 rounded-full shrink-0", dot.cls)} title={dot.title} />
        {renaming ? (
          <input
            autoFocus
            aria-label="Rename session"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setRenaming(false);
            }}
            className="field text-[15px] font-semibold px-2 py-0.5 max-w-[16rem]"
          />
        ) : (
          <button
            className="truncate text-[15px] font-semibold text-ink"
            title="Rename"
            onClick={() => {
              if (!session) return;
              setDraft(label);
              setRenaming(true);
            }}
          >
            {label}
          </button>
        )}
        {isHost && session && (
          <button
            className="icon-btn w-6 h-6"
            title="Switch session"
            onClick={() => setSwitcherOpen((v) => !v)}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        )}
        {isPeer && (
          <span
            className="chip text-[10px] px-2 py-0.5 ml-0.5 shrink-0"
            style={{
              background: "color-mix(in oklab, rgb(var(--sdk)) 16%, transparent)",
              color: "rgb(var(--sdk))",
            }}
          >
            shared{hostName ? ` by ${hostName}` : ""}
          </span>
        )}

        {switcherOpen && (
          <div className="absolute left-0 top-full mt-1.5 z-30 w-64 rounded-xl p-1.5 bg-elevated border border-divider shadow-card">
            <div className="section-title px-2 pt-1 pb-1">Active</div>
            {alives.length === 0 && <div className="px-2 py-1 text-[11px] text-ink-faint">none</div>}
            {alives.map((s) => (
              <button
                key={s.sessionId}
                onClick={() => {
                  onSelect(s.sessionId!);
                  setSwitcherOpen(false);
                }}
                className={cn(
                  "list-row w-full text-left flex items-center gap-2 px-2 py-1.5",
                  s.sessionId === selectedId && "is-active",
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", s.turnActive ? "bg-live" : "bg-wrap")} />
                <span className="flex-1 truncate text-[12.5px] text-ink-soft">
                  {sessionDisplayLabel(s)}
                </span>
                {s.sessionId === selectedId && <Check className="w-3.5 h-3.5 shrink-0 text-accent" />}
              </button>
            ))}
            {inactives.length > 0 && <div className="section-title px-2 pt-2 pb-1">Inactive</div>}
            {inactives.map((s) => (
              <button
                key={s.sessionId}
                onClick={() => {
                  onSelect(s.sessionId!);
                  setSwitcherOpen(false);
                }}
                className="list-row w-full text-left flex items-center gap-2 px-2 py-1.5"
              >
                <span className="flex-1 truncate text-[12.5px] italic text-ink-mute">
                  {sessionDisplayLabel(s)}
                </span>
                <span className="font-mono text-[10px] text-ink-faint shrink-0">
                  {s.lifecycle ?? "dormant"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* presence */}
      {participants.length > 0 && (
        <div className="flex items-center gap-1.5 pl-1 shrink-0">
          <div className="flex -space-x-2">
            {participants.slice(0, 4).map((p) => (
              <span
                key={p.participantId}
                className={cn(
                  "avatar w-6 h-6 text-[9px] ring-2 ring-center transition-opacity",
                  p.kind === "peer" && "avatar-sdk",
                  // Dimmed = backgrounded/idle but still connected (NOT left).
                  p.away && "opacity-40",
                )}
                title={p.away ? `${p.name} (away)` : p.name}
              >
                {p.name.slice(0, 2).toUpperCase()}
              </span>
            ))}
          </div>
        </div>
      )}

      {meta.cwd && (
        // `!hidden` (important) because the unlayered `.chip { display:inline-flex }`
        // component rule outranks Tailwind's layered `hidden` — a plain `hidden`
        // here is silently ignored. Hidden below md to declutter the phone header.
        <span className="chip font-mono text-[10px] px-2 py-1 text-ink-faint max-md:!hidden ml-1 max-w-[18rem] truncate">
          {meta.cwd}
        </span>
      )}

      <div className="ml-auto shrink-0 flex items-center gap-1 sm:gap-1.5">
        {live && (
          <span className="pill-btn text-[10px] uppercase tracking-wide px-2 sm:px-2.5 py-1.5 text-wrap">
            <span className="w-1.5 h-1.5 rounded-full bg-wrap motion-safe:animate-pulse" /> live
          </span>
        )}
        {canShare && session && (
          <button className="icon-btn w-8 h-8" title="Share" onClick={onShare}>
            <Share2 className="w-4 h-4" />
          </button>
        )}
        {/* Expand/restore the main frame (collapse the desktop rails). A no-op
          * on phones — the rails are already hidden there — so hide it below lg.
          * `!hidden` (important) is required: the unlayered `.icon-btn`
          * `display:inline-flex` outranks Tailwind's layered `hidden`, so a plain
          * `hidden` would be silently ignored and the button would still show. */}
        <button
          className="icon-btn w-8 h-8 max-lg:!hidden"
          title={fullscreen ? "Restore rails" : "Expand chat"}
          aria-label={fullscreen ? "Restore rails" : "Expand chat"}
          aria-pressed={fullscreen}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
        {isHost && session && (
          <div ref={menuRef} className="relative">
            <button className="icon-btn w-8 h-8" title="More" onClick={() => setMenuOpen((v) => !v)}>
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1.5 z-30 w-40 rounded-xl p-1.5 bg-elevated border border-divider shadow-card">
                <button
                  className="list-row w-full text-left px-2 py-1.5 text-[12px] text-fail"
                  onClick={() => {
                    setMenuOpen(false);
                    if (confirm(`Delete session "${label}"?`)) void onDelete();
                  }}
                >
                  Delete session
                </button>
              </div>
            )}
          </div>
        )}
        {/* Peer counterpart: a guest can LEAVE (relinquish access) but never
          * delete/rename — those are host-only and refused server-side. */}
        {isPeer && onLeave && (
          <div ref={menuRef} className="relative">
            <button className="icon-btn w-8 h-8" title="More" onClick={() => setMenuOpen((v) => !v)}>
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1.5 z-30 w-40 rounded-xl p-1.5 bg-elevated border border-divider shadow-card">
                <button
                  className="list-row w-full text-left px-2 py-1.5 text-[12px] text-fail"
                  onClick={() => {
                    setMenuOpen(false);
                    if (confirm("Leave this session? You'll need the host to admit you again to return.")) void onLeave();
                  }}
                >
                  Leave session
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
