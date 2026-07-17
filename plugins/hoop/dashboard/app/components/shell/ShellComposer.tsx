"use client";
import { memo, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowUp, Eye, Image as ImageIcon, MessageCircle, Terminal, X } from "lucide-react";
import { useActiveSession } from "@/app/context/ActiveSessionProvider";
import { userPromptText, extractEventField } from "../active-session/eventText";
import { isPeerClient, peerCapability, myDisplayName, useMounted } from "../lib/participant";
import {
  readImages,
  toSendImages,
  toChatImages,
  previewUrl,
  MAX_ATTACHMENTS,
  type AttachedImage,
} from "../lib/imageAttach";
import { cn } from "../ui/cn";

// Center-pane composer (Phase 3). Matches the mockup's field (avatar + input +
// image attach + round accent send) and hint bar, wired to the provider: plain
// text → send, `!cmd` → runBash, `>msg` → participant chat, and image
// attachments (button or paste) that ride along on send/chat. Typing broadcasts
// via presence. A spectate peer gets the read-only note. The slash / @file
// affordances (the complex, still-moving features) stay deferred — noted in the
// hint, not stubbed as dead buttons.

function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Memoized: presence heartbeats re-render the center pane ~every 10s (plus on
// every SSE/typing change). With a stable `setTyping` (useCallback in
// usePresence) the composer's own local state is all that should drive its
// re-renders — not presence churn.
export const ShellComposer = memo(function ShellComposer({
  setTyping,
}: {
  setTyping: (t: boolean) => void;
}) {
  const active = useActiveSession();
  const [text, setText] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Shell-style prompt history (newest-first): ArrowUp/ArrowDown recall past
  // user messages (and `!bash` shortcuts). histIdx is -1 when not browsing;
  // draftRef stashes the in-progress text so ArrowDown past the newest restores it.
  const histIdxRef = useRef(-1);
  const draftRef = useRef("");

  // Browser-only identity (meta tag / sessionStorage) — gate on mount so the
  // first client render matches the server's, which always sees "host"/"Host".
  // Without this the avatar hydrated as "H" (server) vs "B" (client) and took
  // the whole session view's hydration down with it.
  const mounted = useMounted();
  const spectator = mounted && isPeerClient() && peerCapability() === "spectate";
  const me = initials(mounted ? myDisplayName() : "Host");

  const history = useMemo<string[]>(() => {
    const out: string[] = [];
    const evs = active.events;
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      let t: string | null = null;
      if (ev.hook_type === "UserPromptSubmit") t = userPromptText(ev);
      else if (ev.hook_type === "BashShortcut") {
        const cmd = extractEventField(ev.text, "tool_input");
        if (cmd) t = `!${cmd}`;
      }
      if (!t) continue;
      if (out.length > 0 && out[out.length - 1] === t) continue; // drop consecutive dupes
      out.push(t);
    }
    return out;
  }, [active.events]);

  // Set the recalled value, resize the textarea, and drop the caret at the end.
  // Sets el.value directly (in sync with setText) so height + caret are correct
  // this frame; a programmatic value set does not fire onChange.
  function applyValue(t: string) {
    setText(t);
    setTyping(t.trim().length > 0);
    const el = taRef.current;
    if (el) {
      el.value = t;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      el.selectionStart = el.selectionEnd = t.length;
    }
  }

  async function submit() {
    const raw = text.trim();
    const attached = images;
    const hasImages = attached.length > 0;
    if ((!raw && !hasImages) || busy) return;
    // Bash is text-only; images force the send/chat path.
    const bash = raw.startsWith("!") && !hasImages;
    const chat = !bash && raw.startsWith(">");
    setBusy(true);
    setTyping(false);
    histIdxRef.current = -1;
    draftRef.current = "";
    // Clear immediately — the send is a network round-trip; leaving the draft in
    // place until it resolves reads as lag. On failure we restore text + images.
    setText("");
    setImages([]);
    if (taRef.current) taRef.current.style.height = "auto";
    try {
      if (bash) {
        await active.runBash(raw.slice(1).trim());
      } else if (chat) {
        await active.chat(raw.slice(1).trim(), hasImages ? toChatImages(attached) : undefined);
      } else {
        await active.send(raw, hasImages ? toSendImages(attached) : undefined);
      }
    } catch {
      setText(raw);
      setImages(attached);
    } finally {
      setBusy(false);
    }
  }

  async function addFiles(files: File[]) {
    const added = await readImages(files, images.length);
    if (added.length) setImages((cur) => [...cur, ...added].slice(0, MAX_ATTACHMENTS));
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    void addFiles(Array.from(e.target.files ?? []));
    e.target.value = ""; // let the same file be re-picked
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && history.length > 0) {
      const el = taRef.current;
      if (!el) return;
      const cursor = el.selectionStart ?? el.value.length;

      if (e.key === "ArrowUp") {
        // Only hijack when the cursor is on the first line — otherwise the user
        // is navigating within a multi-line draft.
        if (el.value.slice(0, cursor).includes("\n")) return;
        const next = Math.min(history.length - 1, histIdxRef.current + 1);
        e.preventDefault();
        if (next !== histIdxRef.current) {
          if (histIdxRef.current === -1) draftRef.current = el.value;
          histIdxRef.current = next;
          applyValue(history[next]);
        }
        return;
      }

      // ArrowDown: only act while browsing history, and only from the last line.
      if (histIdxRef.current < 0) return;
      if (el.value.slice(cursor).includes("\n")) return;
      e.preventDefault();
      const next = histIdxRef.current - 1;
      if (next < 0) {
        histIdxRef.current = -1;
        const restored = draftRef.current;
        draftRef.current = "";
        applyValue(restored);
      } else {
        histIdxRef.current = next;
        applyValue(history[next]);
      }
    }
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    // A real edit exits history browsing.
    histIdxRef.current = -1;
    setText(e.target.value);
    setTyping(e.target.value.trim().length > 0);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  if (spectator) {
    return (
      <div className="px-3 sm:px-5 pt-1 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-5">
        <div className="flex items-center gap-2 rounded-xl px-3.5 py-3 text-[12px] text-ink-mute bg-sunken border border-divider">
          <Eye className="w-4 h-4 shrink-0 text-sdk" />
          <span>Spectating — read only. Ask the host for drive access to participate.</span>
        </div>
      </div>
    );
  }

  const hasImages = images.length > 0;
  // `>` chat wins (chat carries images); `!` bash only when nothing is attached.
  const mode = text.startsWith(">") ? "chat" : !hasImages && text.startsWith("!") ? "bash" : null;
  const canSend = (text.trim().length > 0 || hasImages) && !busy;

  return (
    <div className="px-3 sm:px-5 pt-1 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-5">
      {active.sendError && (
        <div className="mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] bg-fail/[0.14] border border-fail/30 text-fail">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="font-medium">{active.sendError}</span>
        </div>
      )}

      <div
        className={cn(
          "field flex flex-col gap-2 px-2 py-2",
          mode === "chat" && "is-chat",
          mode === "bash" && "is-bash",
        )}
      >
        {/* Attached thumbnails live inside the field, above the input row. */}
        {hasImages && (
          <div className="flex flex-wrap gap-2 px-1 pt-0.5">
            {images.map((a) => (
              <div key={a.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewUrl(a)}
                  alt={a.name}
                  className="h-14 w-14 rounded-lg object-cover border border-divider"
                />
                <button
                  type="button"
                  onClick={() => setImages((cur) => cur.filter((i) => i.id !== a.id))}
                  title="Remove"
                  aria-label={`Remove ${a.name}`}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-elevated border border-divider flex items-center justify-center text-ink-mute hover:text-fail transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* items-center keeps a single-line draft vertically centered in the
          * field (the mockup's composer). */}
        <div className="flex items-center gap-2">
          {/* Avatar doubles as the mode indicator: your initials normally, the
            * op glyph (tinted red/green) while typing a `!` bash or `>` chat. */}
          <span
            className={cn(
              "avatar w-7 h-7 text-[10px] shrink-0 transition-colors",
              mode === "bash" ? "avatar-fail" : mode === "chat" ? "avatar-wrap" : "text-ink",
            )}
          >
            {mode === "bash" ? (
              <Terminal className="w-3.5 h-3.5" />
            ) : mode === "chat" ? (
              <MessageCircle className="w-3.5 h-3.5" />
            ) : (
              me
            )}
          </span>
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => setTyping(false)}
            placeholder={
              mode === "bash" ? "bash command…" : mode === "chat" ? "message to participants…" : "type a message…"
            }
            className="flex-1 bg-transparent border-0 outline-none resize-none text-[13px] text-ink placeholder:text-ink-hush leading-relaxed py-1"
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={onPickFiles}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={mode === "bash" || images.length >= MAX_ATTACHMENTS}
            title={
              mode === "bash"
                ? "Images aren't supported for bash commands"
                : images.length >= MAX_ATTACHMENTS
                  ? `Up to ${MAX_ATTACHMENTS} images`
                  : "Attach image"
            }
            aria-label="Attach image"
            className="icon-btn w-8 h-8 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            title="Send"
            aria-label="Send"
            className={cn(
              "accent-btn w-9 h-9 rounded-full shrink-0",
              mode === "chat" && "is-chat",
              mode === "bash" && "is-bash",
              !canSend && "opacity-50",
            )}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </div>
      <p className="font-mono text-[10px] text-ink-faint mt-2 px-1 text-center lg:text-left">
        enter to send · shift+enter for newline · ↑↓ history ·{" "}
        <span className={cn(mode === "bash" && "text-fail font-semibold")}>! bash</span> ·{" "}
        <span className={cn(mode === "chat" && "text-wrap font-semibold")}>&gt; chat</span>
      </p>
    </div>
  );
});
