"use client";
import { useMemo, useRef, useState } from "react";
import { useCommands, type AutocompleteEntry } from "@/app/context/CommandsProvider";
import { useFiles } from "@/app/context/useFiles";

export interface ComposerTrigger {
  type: "slash" | "file";
  /** Index into the text where the trigger character ("/" or "@") sits. */
  start: number;
  /** Text typed after the trigger character, up to the caret. */
  query: string;
}

/**
 * Resolves the active `/` or `@` trigger (if any) given the composer's
 * text and caret offset. `/` only fires when it's the very first
 * character and no space has been typed yet — a slash command is the
 * whole message, mirroring how `!bash` / `>chat` mode-detection already
 * works. `@` fires at the start of the current whitespace-delimited
 * word, anywhere in the text — an inline file mention.
 */
export function detectTrigger(text: string, cursor: number): ComposerTrigger | null {
  const before = text.slice(0, cursor);

  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { type: "slash", start: 0, query: slash[1] };

  const at = /(?:^|\s)@(\S*)$/.exec(before);
  if (at) {
    const start = before[at.index] === "@" ? at.index : at.index + 1;
    return { type: "file", start, query: at[1] };
  }

  return null;
}

/** Splices `insert + " "` into `text` at the trigger's token, replacing
 * everything from the trigger character through the caret. Pure so the
 * splice math is testable without rendering the stateful hook below. */
export function spliceTrigger(
  text: string,
  cursor: number,
  trigger: ComposerTrigger,
  insert: string,
): { text: string; cursor: number } {
  const insertion = `${insert} `;
  const nextText = text.slice(0, trigger.start) + insertion + text.slice(cursor);
  return { text: nextText, cursor: trigger.start + insertion.length };
}

export type ComposerAutocompleteAction = "navigated" | "select" | "close" | null;

export interface UseComposerAutocompleteResult {
  open: boolean;
  entries: AutocompleteEntry[];
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  /** Call from the textarea's onChange with the new value + caret offset. */
  onTextChange: (text: string, cursor: number) => void;
  /**
   * Call from the textarea's onKeyDown BEFORE any other handling. A
   * non-null return means the key was consumed — the caller should
   * preventDefault and skip its own handling. `"select"` means the
   * caller should now call `select(text, cursor)` and apply the result.
   */
  onKeyDown: (e: { key: string; shiftKey?: boolean }) => ComposerAutocompleteAction;
  /**
   * Splices the active (or given) entry into `text` at the trigger
   * position, returning the new text + caret offset. Null if there's no
   * active trigger or no entry to insert.
   */
  select: (text: string, cursor: number, entry?: AutocompleteEntry) => { text: string; cursor: number } | null;
  close: () => void;
}

export function useComposerAutocomplete(): UseComposerAutocompleteResult {
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const { entries: commandEntries } = useCommands();
  const { entries: fileEntries } = useFiles(trigger?.type === "file" ? trigger.query : null);

  const entries = useMemo<AutocompleteEntry[]>(() => {
    if (!trigger) return [];
    if (trigger.type === "file") return fileEntries;
    const q = trigger.query.toLowerCase();
    return commandEntries.filter((e) => e.label.toLowerCase().includes(q)).slice(0, 20);
  }, [trigger, commandEntries, fileEntries]);

  // A fresh trigger (new token, or the query within it changed) always
  // restarts the highlight at the top of the list. Adjusted during render
  // (comparing against the previous render's key) rather than in an effect,
  // so the reset is visible in the same render as the new entries.
  const triggerKey = trigger ? `${trigger.type}:${trigger.query}` : null;
  const prevTriggerKeyRef = useRef(triggerKey);
  if (prevTriggerKeyRef.current !== triggerKey) {
    prevTriggerKeyRef.current = triggerKey;
    if (activeIndex !== 0) setActiveIndex(0);
  }

  const clampedActiveIndex = Math.min(activeIndex, Math.max(entries.length - 1, 0));

  function close() {
    setTrigger(null);
    setActiveIndex(0);
  }

  function onTextChange(text: string, cursor: number) {
    setTrigger(detectTrigger(text, cursor));
  }

  function onKeyDown(e: { key: string; shiftKey?: boolean }): ComposerAutocompleteAction {
    if (!trigger || entries.length === 0) return null;
    switch (e.key) {
      case "ArrowDown":
        setActiveIndex((i) => Math.min(i + 1, entries.length - 1));
        return "navigated";
      case "ArrowUp":
        setActiveIndex((i) => Math.max(i - 1, 0));
        return "navigated";
      case "Escape":
        close();
        return "close";
      case "Tab":
        return "select";
      case "Enter":
        return e.shiftKey ? null : "select";
      default:
        return null;
    }
  }

  function select(
    text: string,
    cursor: number,
    entry?: AutocompleteEntry,
  ): { text: string; cursor: number } | null {
    if (!trigger) return null;
    const chosen = entry ?? entries[clampedActiveIndex];
    if (!chosen) return null;
    const result = spliceTrigger(text, cursor, trigger, chosen.insert);
    close();
    return result;
  }

  return {
    open: trigger !== null,
    entries,
    activeIndex: clampedActiveIndex,
    setActiveIndex,
    onTextChange,
    onKeyDown,
    select,
    close,
  };
}
