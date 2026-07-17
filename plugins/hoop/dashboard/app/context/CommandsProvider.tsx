"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Skill, SlashCommand } from "@/lib/sandbox-client";
import { useSelectedSession } from "./SelectedSessionProvider";
import { useSessions } from "./SessionsProvider";
import { useSSE } from "@/app/components/useSSE";

export interface AutocompleteEntry {
  /** Visible insertion text, including leading "/". e.g. "/hoop:setup". */
  insert: string;
  /** Short label for the popover; usually identical to insert minus the slash. */
  label: string;
  /** One-line subtext. */
  description: string | null;
  /** "command" or "skill" — used to colour the chip in the popover. */
  kind: "command" | "skill" | "builtin";
  /** Source plugin/owner for the row, when meaningful. */
  source?: string | null;
}

export interface CommandsValue {
  entries: AutocompleteEntry[];
  loading: boolean;
}

const CommandsContext = createContext<CommandsValue | null>(null);

/**
 * Loads `/api/commands` and `/api/skills` once at mount and merges them
 * into a single autocomplete corpus. Shared by every `CommandAutocomplete`
 * instance, so the corpus is fetched exactly once per dashboard load.
 *
 * Refetches on the `skills` SSE event so a skill the agent authors inside the
 * sandbox (a SKILL.md written under a watched tree) shows up in autocomplete
 * without a reload. The event is a notification edge only — we always re-pull
 * both endpoints for the canonical corpus.
 */
export function CommandsProvider({ children }: { children: React.ReactNode }) {
  const { selectedId } = useSelectedSession();
  const { sessions } = useSessions();
  // Per Claude Code's discovery rule, skills + commands come from either
  // `~/.claude` (global) or `<cwd>/.claude` (project). Scope this corpus to
  // the active session's cwd so a project's bundled commands show up in
  // autocomplete when that session is selected.
  const selectedCwd = selectedId
    ? sessions.find((s) => s.sessionId === selectedId)?.cwd ?? null
    : null;

  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  // Monotonic request id: a slow in-flight load (e.g. fired on cwd change)
  // must not overwrite a newer one (e.g. a subsequent skills-changed refetch).
  const reqSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      const qs = selectedCwd ? `?cwd=${encodeURIComponent(selectedCwd)}` : "";
      const [cRes, sRes] = await Promise.all([
        fetch(`/api/commands${qs}`),
        fetch(`/api/skills${qs}`),
      ]);
      const c = cRes.ok ? ((await cRes.json()) as SlashCommand[]) : [];
      const s = sRes.ok ? ((await sRes.json()) as Skill[]) : [];
      if (seq !== reqSeq.current) return; // a newer reload superseded this one
      setCommands(c);
      setSkills(s);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [selectedCwd]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useSSE({ skills: () => void reload() });

  const entries = useMemo<AutocompleteEntry[]>(() => {
    const cmdEntries: AutocompleteEntry[] = commands.map((c) => ({
      insert: c.name.startsWith("/") ? c.name : `/${c.name}`,
      label: c.name.replace(/^\//, ""),
      description: c.description,
      kind: c.kind,
      source: c.plugin || null,
    }));
    // Skills not already in the command list (sandbox sometimes merges
    // them in /api/commands as kind="skill"; de-dupe by insert key).
    const seenInsert = new Set(cmdEntries.map((e) => e.insert));
    const skillEntries: AutocompleteEntry[] = skills
      .map((s): AutocompleteEntry => ({
        insert: `/${s.name}`,
        label: s.name,
        description: s.description,
        kind: "skill",
        source: s.plugin ?? (s.source === "user" ? "user" : null),
      }))
      .filter((e) => !seenInsert.has(e.insert));

    return [...cmdEntries, ...skillEntries].sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [commands, skills]);

  const value = useMemo<CommandsValue>(() => ({ entries, loading }), [entries, loading]);

  return <CommandsContext.Provider value={value}>{children}</CommandsContext.Provider>;
}

export function useCommands(): CommandsValue {
  const ctx = useContext(CommandsContext);
  if (!ctx) throw new Error("useCommands must be used inside <CommandsProvider>");
  return ctx;
}
