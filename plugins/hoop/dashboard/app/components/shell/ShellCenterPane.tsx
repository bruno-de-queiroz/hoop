"use client";
import { useCallback, useState } from "react";
import { useActiveSession } from "@/app/context/ActiveSessionProvider";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { usePresence } from "@/app/context/hooks/usePresence";
import { ShellSessionHeader } from "./ShellSessionHeader";
import { ShellStatsStrip } from "./ShellStatsStrip";
import { ShellTranscript } from "./ShellTranscript";
import { ShellComposer } from "./ShellComposer";
import { ShellPermissions } from "./ShellPermissions";
import { ShellPlanReviewCard } from "./ShellPlanReviewCard";
import { ShellAskQuestion } from "./ShellAskQuestion";
import { ShellShareModal } from "./ShellShareModal";
import { ShellNewSession } from "./ShellNewSession";
import { myDisplayName } from "../lib/participant";

// Center pane (Phase 3): the active session rendered as a chat thread + composer
// (mockup's center). Reads everything from the providers — header, stats,
// transcript, and composer are all shell components. No selection → the "start a
// session" empty state (shell-native new-session form).

export function ShellCenterPane() {
  const active = useActiveSession();
  const { selectedId, setSelected } = useSelectedSession();
  const { participants, setTyping } = usePresence(selectedId);
  const [shareOpen, setShareOpen] = useState(false);
  // Stable so the memoized transcript isn't re-rendered by every presence beat.
  const onLoadMore = useCallback(() => void active.loadMore(), [active]);

  // Peer "Leave session": relinquish access. The route emits the leave marker,
  // drops presence, and clears the peer cookie — so returning needs a fresh
  // admit. Navigate away (replace, so Back can't re-open the now-cookieless
  // session). Host has no leave (they delete instead), so only wire it for peers.
  const onLeave = useCallback(async () => {
    try {
      await fetch("/api/share/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: myDisplayName() }),
      });
    } catch { /* leave anyway — the cookie clear is best-effort UX */ }
    window.location.replace("/");
  }, []);

  // Gate on selection ONLY (matching the legacy panel). A freshly-created
  // session is selected by its `pending-<id>` before it lands in the fs-backed
  // session list, so `active.session` is briefly null — we must still render the
  // session view (header + "waiting for first turn" + composer) rather than
  // bounce back to the create form. The composer can already write to the
  // pending id; the real session resolves moments later.
  if (!selectedId) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center p-8">
        <ShellNewSession onCreated={(sid) => setSelected(sid)} />
      </div>
    );
  }

  return (
    <div className="relative z-[1] flex flex-col min-h-0 flex-1">
      <ShellSessionHeader
        session={active.session}
        meta={active.meta}
        selectedId={selectedId}
        participants={participants}
        onSelect={setSelected}
        onRename={active.rename}
        onShare={() => setShareOpen(true)}
        onDelete={active.remove}
        onLeave={onLeave}
      />
      <ShellStatsStrip stats={active.stats} model={active.meta.model} />
      <ShellTranscript
        events={active.events}
        hasMore={active.hasMore}
        onLoadMore={onLoadMore}
        isWaiting={active.isWaiting}
      />
      <ShellPlanReviewCard />
      <ShellPermissions />
      <ShellAskQuestion />
      <ShellComposer setTyping={setTyping} />

      <ShellShareModal open={shareOpen} sessionId={selectedId} onClose={() => setShareOpen(false)} />
    </div>
  );
}
