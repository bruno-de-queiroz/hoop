"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSSE } from "@/app/components/useSSE";
import type { SessionInfo } from "@/lib/types/session";
import { useSelectedSession } from "./SelectedSessionProvider";

export interface SessionsValue {
  sessions: SessionInfo[];
  loading: boolean;
  refresh: () => Promise<void>;
  /**
   * Optimistically removes the row and POSTs DELETE. When the deleted
   * session is currently selected, clears the URL so the active-session
   * frame returns to its empty state in the same render.
   */
  deleteSession: (sessionId: string) => Promise<void>;
  /**
   * POSTs the new session, refreshes the list, and selects the new
   * session id so the active-session frame snaps to it immediately.
   * Returns just the sessionId — callers that need the full row should
   * read it from `sessions` after the next render, which `refresh` has
   * already triggered. (Returning a SessionInfo here would expose a
   * stale read because the `setSessions` from refresh hasn't flushed
   * into `sessions` yet at the moment `createSession` resolves.)
   * Throws on policy / cap errors so callers can surface them inline.
   */
  createSession: (opts: { name?: string; model?: string; gitRepo?: string }) => Promise<{ sessionId: string }>;
  /**
   * PATCHes a new name onto the session. Optimistic local update; if
   * the server rejects, the optimistic value is rolled back and the
   * error is rethrown for the caller to surface.
   */
  renameSession: (sessionId: string, name: string) => Promise<void>;
}

const SessionsContext = createContext<SessionsValue | null>(null);

// Collapse a burst of `sessions` SSE pings during a single turn into one
// refetch. 150ms is below the human flicker threshold; matches the value
// the previous build settled on.
const SSE_DEBOUNCE_MS = 150;

// Identity-relevant signature for `lastStats`. Bare-minimum fields the
// stats strip + model badge react to. Without these in the diff,
// shallowEqual eats every end-of-turn update and the strip stops moving.
function statsSignature(ls: SessionInfo["lastStats"] | undefined): string {
  if (!ls) return "";
  const t = ls.totals;
  return [
    ls.model ?? "",
    ls.mode ?? "",
    ls.turnEndedAt ?? 0,
    t?.input_tokens ?? 0,
    t?.output_tokens ?? 0,
    t?.cache_read_input_tokens ?? 0,
    t?.cache_creation_input_tokens ?? 0,
    t?.turns ?? 0,
  ].join("|");
}

function shallowEqual(a: SessionInfo[], b: SessionInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.sessionId !== y.sessionId ||
      x.lifecycle !== y.lifecycle ||
      x.displayName !== y.displayName ||
      x.skill !== y.skill ||
      x.status !== y.status ||
      x.entrypoint !== y.entrypoint ||
      x.cwd !== y.cwd ||
      statsSignature(x.lastStats) !== statsSignature(y.lastStats)
    ) {
      return false;
    }
    const ax = x.aliases ?? [];
    const ay = y.aliases ?? [];
    if (ax.length !== ay.length) return false;
    for (let j = 0; j < ax.length; j++) if (ax[j] !== ay[j]) return false;
  }
  return true;
}

// How long after selecting a dormant session we guard its label against
// regressing to a null-displayName transient during the resume id-swap.
const WAKE_SETTLE_MS = 1500;

export function SessionsProvider({ children }: { children: React.ReactNode }) {
  const { selectedId, setSelected } = useSelectedSession();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const sessionsRef = useRef<SessionInfo[]>([]);
  sessionsRef.current = sessions;
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Wake-settle: when the user selects a dormant session, `claude --resume`
  // mints a new id and there's a brief window where the sessions payload can
  // carry an undecorated (null displayName) row for that conversation. The
  // server already suppresses the orphan row; this is the client-side
  // belt-and-suspenders so the selected session's NAME never regresses to a
  // cwd-basename / id-slice fallback mid-wake. We keep the single sessions
  // array as the one source both the sidebar and the frame read.
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const wakeSettleUntilRef = useRef(0);

  const matchesSelected = useCallback((s: SessionInfo, sel: string): boolean => {
    return s.sessionId === sel || (s.aliases ?? []).includes(sel);
  }, []);

  // Arm the settle window when the selection moves to a dormant row.
  useEffect(() => {
    if (!selectedId) return;
    const cur = sessionsRef.current.find((s) => matchesSelected(s, selectedId));
    if (cur?.lifecycle === "dormant") {
      wakeSettleUntilRef.current = Date.now() + WAKE_SETTLE_MS;
    }
  }, [selectedId, matchesSelected]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/sessions");
      if (!r.ok) {
        setLoading(false);
        return;
      }
      let next = (await r.json()) as SessionInfo[];

      // During the wake-settle window, don't let the selected session's label
      // regress: if the incoming row lost its displayName but the row we're
      // already showing has one, carry the name forward (lifecycle/other
      // fresh fields still update). Only patches the selected conversation.
      const sel = selectedIdRef.current;
      if (sel && Date.now() < wakeSettleUntilRef.current) {
        const prev = sessionsRef.current.find((s) => matchesSelected(s, sel));
        if (prev?.displayName) {
          next = next.map((s) =>
            matchesSelected(s, sel) && !s.displayName
              ? { ...s, displayName: prev.displayName }
              : s,
          );
        }
      }

      // Skip the state update if nothing visible changed. This kills the
      // sidebar re-render on the every-turn mtime tick — without this
      // the row hover/selection state strobes whenever an event lands.
      if (!shallowEqual(sessionsRef.current, next)) {
        setSessions(next);
      }
    } finally {
      setLoading(false);
    }
  }, [matchesSelected]);

  // Initial fetch — one concern per effect so refactors don't accidentally
  // unmount the debounce timer when refresh's identity changes.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Debounce-timer lifecycle. Lives on its own so callers can rely on
  // the timer being cleared exactly when the provider unmounts.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const refreshDebounced = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      refresh();
    }, SSE_DEBOUNCE_MS);
  }, [refresh]);

  useSSE({
    sessions: () => refreshDebounced(),
  });

  const deleteSession = useCallback(
    async (sessionId: string) => {
      // Optimistic local remove. The /sessions SSE will reconcile if
      // anything went wrong server-side.
      setSessions((prev) =>
        prev.filter(
          (s) => s.sessionId !== sessionId && !(s.aliases ?? []).includes(sessionId),
        ),
      );
      // If we just deleted the active selection, clear the URL in the
      // same transition — no broken-selection flash.
      if (sessionId === selectedId) {
        setSelected(null);
      }
      try {
        await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
        });
      } catch {
        // ignore; server is the source of truth, next refresh reconciles
      }
    },
    [selectedId, setSelected],
  );

  const createSession = useCallback(
    async (opts: { name?: string; model?: string; gitRepo?: string }): Promise<{ sessionId: string }> => {
      const r = await fetch("/api/sessions/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: opts.name, model: opts.model, gitRepo: opts.gitRepo }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      const body = (await r.json()) as { sessionId: string };
      // Refresh so the new row lands in `sessions` on the next render,
      // then snap selection to it. We don't return the SessionInfo —
      // sessionsRef.current is still the pre-refresh value at this
      // point (React commits setState on the next render), so any
      // synthetic we built here would mislead the caller.
      await refresh();
      setSelected(body.sessionId);
      return { sessionId: body.sessionId };
    },
    [refresh, setSelected],
  );

  const renameSession = useCallback(
    async (sessionId: string, name: string) => {
      const trimmed = name.trim();
      // Snapshot the previous displayName for rollback. We rollback on
      // both network failure and 4xx so optimistic UI doesn't lie.
      const prevName = sessionsRef.current.find(
        (s) => s.sessionId === sessionId || (s.aliases ?? []).includes(sessionId),
      )?.displayName;
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === sessionId || (s.aliases ?? []).includes(sessionId)
            ? { ...s, displayName: trimmed || null }
            : s,
        ),
      );
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!r.ok) {
          // Rollback.
          setSessions((prev) =>
            prev.map((s) =>
              s.sessionId === sessionId || (s.aliases ?? []).includes(sessionId)
                ? { ...s, displayName: prevName ?? null }
                : s,
            ),
          );
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
      } catch (e) {
        // Network failure: rollback + rethrow so callers can surface.
        setSessions((prev) =>
          prev.map((s) =>
            s.sessionId === sessionId || (s.aliases ?? []).includes(sessionId)
              ? { ...s, displayName: prevName ?? null }
              : s,
          ),
        );
        throw e;
      }
    },
    [],
  );

  const value = useMemo<SessionsValue>(
    () => ({ sessions, loading, refresh, deleteSession, createSession, renameSession }),
    [sessions, loading, refresh, deleteSession, createSession, renameSession],
  );

  return (
    <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>
  );
}

export function useSessions(): SessionsValue {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error("useSessions must be used inside <SessionsProvider>");
  return ctx;
}
