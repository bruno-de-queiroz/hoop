"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePendingPermissions } from "@/app/context/hooks/usePendingPermissions";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { useSessions } from "@/app/context/SessionsProvider";
import PlanPanel from "../PlanPanel";
import { sessionDisplayLabel } from "../lib/format";
import { canDecidePlans, canCommentOnPlans } from "../lib/participant";

// Shared shell-chrome state that spans the rails, the center header, and
// overlays — kept in context so those distant components stay in sync.
//
//  · CenterFullscreen — "expand the main frame": collapse both rails so the
//    center chat pane goes full-width (mockup's session-header maximize-2). Not
//    a window-level fullscreen.
//  · PlanReview — pending plans surface in the left rail's "Needs review"
//    section (mockup); clicking one opens the shared PlanPanel slide-over,
//    which this provider renders. A plan for the current session auto-opens.

// ── Center fullscreen ────────────────────────────────────────────────────────
interface CenterFullscreenValue {
  fullscreen: boolean;
  toggle: () => void;
}
export const CenterFullscreenContext = createContext<CenterFullscreenValue>({
  fullscreen: false,
  toggle: () => {},
});
export const useCenterFullscreen = () => useContext(CenterFullscreenContext);

// ── Plan review ──────────────────────────────────────────────────────────────
export interface PlanEntry {
  sessionId: string;
  requestId: string;
  title: string;
  label: string;
}
interface PlanReviewValue {
  plans: PlanEntry[];
  open: (requestId: string) => void;
}
const PlanReviewContext = createContext<PlanReviewValue | null>(null);
export function usePlanReview(): PlanReviewValue {
  const c = useContext(PlanReviewContext);
  if (!c) throw new Error("usePlanReview must be used within PlanReviewProvider");
  return c;
}

function planText(input: unknown): string {
  if (input && typeof input === "object" && "plan" in input) {
    const p = (input as { plan?: unknown }).plan;
    if (typeof p === "string") return p;
  }
  return "";
}

/** A short title for a plan: its first markdown heading, else its first line. */
function planTitle(plan: string): string {
  const lines = plan.split("\n").map((l) => l.trim());
  const heading = lines.find((l) => /^#{1,6}\s+/.test(l));
  const raw = (heading ?? lines.find((l) => l.length > 0) ?? "").replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "");
  const t = raw.trim();
  if (!t) return "Untitled plan";
  return t.length > 48 ? t.slice(0, 47) + "…" : t;
}

export function PlanReviewProvider({ children }: { children: React.ReactNode }) {
  const { pending, decide, errors } = usePendingPermissions();
  const { sessions } = useSessions();
  const { selectedId } = useSelectedSession();
  const canDecide = canDecidePlans();
  const canComment = canCommentOnPlans();
  const [openId, setOpenId] = useState<string | null>(null);
  // Plans closed without deciding — collapsed, won't auto-reopen.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const matches = (sid: string, sel: string | null) =>
    !!sel && (sid === sel || (sessions.find((s) => s.sessionId === sid)?.aliases ?? []).includes(sel));
  const labelFor = (sid: string) => {
    const s = sessions.find((x) => x.sessionId === sid || (x.aliases ?? []).includes(sid));
    return s ? sessionDisplayLabel(s) : sid.slice(0, 8);
  };

  const rawPlans = pending.filter((p) => p.request.toolName === "ExitPlanMode");
  const planIds = rawPlans.map((p) => p.request.requestId);
  const planKey = planIds.join("|");

  // Auto-open a fresh plan, but only for the session you're viewing.
  useEffect(() => {
    if (openId) return;
    const next = rawPlans.find(
      (p) => !dismissed.has(p.request.requestId) && matches(p.sessionId, selectedId),
    );
    if (next) setOpenId(next.request.requestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, dismissed, openId, selectedId]);

  // Drop dismissed ids once their plan resolves.
  useEffect(() => {
    setDismissed((prev) => {
      const kept = new Set([...prev].filter((id) => planIds.includes(id)));
      return kept.size === prev.size ? prev : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  const plans = useMemo<PlanEntry[]>(
    () =>
      rawPlans.map((p) => ({
        sessionId: p.sessionId,
        requestId: p.request.requestId,
        title: planTitle(planText(p.request.input)),
        label: labelFor(p.sessionId),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planKey, sessions],
  );

  const open = useCallback((requestId: string) => setOpenId(requestId), []);
  const value = useMemo<PlanReviewValue>(() => ({ plans, open }), [plans, open]);

  const openPlan = openId ? rawPlans.find((p) => p.request.requestId === openId) : undefined;

  return (
    <PlanReviewContext.Provider value={value}>
      {children}
      {openPlan && (
        <PlanPanel
          key={openPlan.request.requestId}
          sessionId={openPlan.sessionId}
          requestId={openPlan.request.requestId}
          plan={planText(openPlan.request.input)}
          sessionLabel={labelFor(openPlan.sessionId)}
          canDecide={canDecide}
          canComment={canComment}
          error={errors[openPlan.request.requestId] ?? null}
          onApprove={async () => {
            await decide(openPlan.sessionId, openPlan.request.requestId, "allow");
            setOpenId(null);
          }}
          onReject={async (feedback) => {
            await decide(openPlan.sessionId, openPlan.request.requestId, "deny", "once", feedback);
            setOpenId(null);
          }}
          onClose={() => {
            setDismissed((prev) => new Set(prev).add(openPlan.request.requestId));
            setOpenId(null);
          }}
        />
      )}
    </PlanReviewContext.Provider>
  );
}
