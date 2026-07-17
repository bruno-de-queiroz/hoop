"use client";
import { useEffect, useState } from "react";
import { NotebookText, Sparkles, Workflow } from "lucide-react";
import { AppShell, TitleBar, Rail, CenterPane } from "@/app/components/ui/AppShell";
import { cn } from "@/app/components/ui/cn";
import { EventStatusBar } from "./EventStatusBar";
import { ShellEventsDrawer } from "./ShellEventsDrawer";
import { SkillsRail } from "./SkillsRail";
import { AgentsRail } from "./AgentsRail";
import { SummaryRail } from "./SummaryRail";
import { SessionsRail } from "./SessionsRail";
import { PeerSharedPanel } from "./PeerSharedPanel";
import { GuestFooter } from "./GuestFooter";
import { IdentityFooter } from "./IdentityFooter";
import { SettingsSheet } from "./SettingsSheet";
import { ShellSearch } from "./ShellSearch";
import { ShellThemeSwitcher } from "./ShellThemeSwitcher";
import { ShellCenterPane } from "./ShellCenterPane";
import { ShellAdmissionToast } from "./ShellAdmissionToast";
import { CenterFullscreenContext, PlanReviewProvider } from "./ShellChrome";
import { AuthBanner } from "../AuthBanner";

// The right-rail mini strip shown when collapsed (mockup's rail-mini): section
// shortcuts that expand the rail. (Settings lives in the left-rail footer, so
// it's not duplicated here.)
function RightRailMini({ onExpand }: { onExpand: () => void }) {
  return (
    <div className="flex flex-col items-center py-3 gap-1 w-12">
      <button className="icon-btn w-9 h-9" title="Summary" onClick={onExpand}>
        <NotebookText className="w-4 h-4" />
      </button>
      <button className="icon-btn w-9 h-9" title="Skills" onClick={onExpand}>
        <Sparkles className="w-4 h-4" />
      </button>
      <button className="icon-btn w-9 h-9" title="Sub-agents" onClick={onExpand}>
        <Workflow className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * Desktop-app shell — the only shell (the legacy panel dashboard was removed
 * at the Phase 4 cutover).
 * Composes the shell primitives — title bar, left rail, center pane, collapsible
 * right rail, bottom status bar — matching the mockup, wired to the same
 * providers as the default dashboard. At the Phase 4 cutover this becomes the
 * only shell.
 */

/**
 * Desktop-app shell — the only shell (the legacy panel dashboard was removed
 * at the Phase 4 cutover).
 * Composes the shell primitives — title bar, left rail, center pane, collapsible
 * right rail, bottom status bar — matching the mockup, wired to the same
 * providers as the default dashboard. Phase 3 ports each surface onto the shell
 * components; the center pane (transcript/composer — the hot files) is last.
 * At the Phase 4 cutover this becomes the only shell.
 */
export function DesktopShell({ isPeer, port }: { isPeer: boolean; port: string }) {
  // Right rail defaults collapsed to the mini strip (mockup), keeping the chat
  // pane as wide as possible; expanding animates the width open.
  const [railCollapsed, setRailCollapsed] = useState(true);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // "Expand the main frame": collapse both rails so the center chat pane goes
  // full-width (mockup's session-header maximize). Persisted after mount to
  // avoid an SSR/hydration mismatch. Shared with the header button via context.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    try {
      setFullscreen(localStorage.getItem("hoop-center-fullscreen") === "1");
    } catch {
      /* ignore */
    }
  }, []);
  const toggleFullscreen = () =>
    setFullscreen((v) => {
      const next = !v;
      try {
        localStorage.setItem("hoop-center-fullscreen", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  return (
    <CenterFullscreenContext.Provider value={{ fullscreen, toggle: toggleFullscreen }}>
      <PlanReviewProvider>
        <AppShell>
          {/* Expanding the main frame collapses ALL chrome — title bar, both
            * rails, and the event footer — with a quick transition, leaving just
            * the center pane (its own session header carries the restore button).
            * Kept mounted (not unmounted) so the collapse animates. */}
          <TitleBar
            className={cn(
              "overflow-hidden motion-safe:transition-[height,opacity] motion-safe:duration-200 motion-safe:ease-smooth",
              // Below `lg` the chat frame is always full-screen: drop the title
              // bar entirely (its search/theme controls live in settings).
              "max-lg:hidden",
              fullscreen && "h-0 opacity-0 border-b-0 pointer-events-none",
            )}
          >
            <span className="font-sans font-bold tracking-tight text-ink">hoop</span>
            <span className="font-sans font-bold text-accent">·</span>
            <div className="ml-auto flex items-center gap-2">
              <ShellSearch />
              <ShellThemeSwitcher />
            </div>
          </TitleBar>

          <div className="flex flex-1 min-h-0">
            {/* Left rail: "Needs review" plans + sessions list + identity footer.
              * A peer is a guest locked to one session — no session list; a
              * shared-session note instead. */}
            <Rail
              side="left"
              className={cn(
                "shrink-0 overflow-hidden motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-smooth",
                // Hidden on phones — the chat is full-screen there.
                "max-lg:hidden",
                fullscreen ? "w-0 border-r-0" : "w-[17rem]",
              )}
            >
              {isPeer ? (
                <PeerSharedPanel />
              ) : (
                <div className="flex-1 min-h-0 flex flex-col w-[17rem]">
                  <SessionsRail />
                </div>
              )}
              {isPeer ? (
                <GuestFooter />
              ) : (
                <IdentityFooter onOpenSettings={() => setSettingsOpen(true)} />
              )}
            </Rail>

            <CenterPane>
              <AuthBanner />
              <ShellCenterPane />
            </CenterPane>

            <Rail
              side="right"
              collapsible={!fullscreen}
              animateWidth
              collapsed={railCollapsed}
              onToggle={() => setRailCollapsed((v) => !v)}
              className={cn(
                "shrink-0",
                // Hidden on phones — the chat is full-screen there.
                "max-lg:hidden",
                fullscreen ? "w-0 border-l-0" : railCollapsed ? "w-12" : "w-[19rem]",
              )}
              collapsedContent={<RightRailMini onExpand={() => setRailCollapsed(false)} />}
            >
              {/* Fixed-width content so the aside's width animation reveals it
                * cleanly. Sections in the mockup's order. */}
              <div className="w-[19rem] flex-1 min-h-0 overflow-y-auto pt-1">
                <SummaryRail />
                <SkillsRail />
                <AgentsRail />
              </div>
            </Rail>
          </div>

          <div
            className={cn(
              "shrink-0 overflow-hidden motion-safe:transition-[height] motion-safe:duration-200 motion-safe:ease-smooth",
              // Hidden on phones — reclaim the row for the transcript/composer.
              "max-lg:hidden",
              fullscreen ? "h-0" : "h-8",
            )}
          >
            <EventStatusBar port={port} onOpen={() => setEventsOpen(true)} />
          </div>

          <ShellEventsDrawer open={eventsOpen} onClose={() => setEventsOpen(false)} />

          <SettingsSheet
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            isPeer={isPeer}
          />

          {!isPeer && <ShellAdmissionToast />}
        </AppShell>
      </PlanReviewProvider>
    </CenterFullscreenContext.Provider>
  );
}
