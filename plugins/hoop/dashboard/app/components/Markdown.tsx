"use client";
import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import hljs from "highlight.js/lib/common";

/**
 * Markdown renderer for assistant transcripts, peer/host chat, and plan
 * content. Backed by react-markdown + remark-gfm so we get a real, spec-tested
 * CommonMark/GFM parser (tables, task lists, strikethrough, escapes, nested
 * lists) instead of a hand-rolled one that trips over corner cases.
 *
 * Safety: react-markdown builds React nodes — no dangerouslySetInnerHTML for
 * input — and we do NOT enable rehype-raw, so embedded HTML is shown as text.
 * URLs are sanitised by react-markdown's defaultUrlTransform (javascript:,
 * data:, etc. are stripped); we additionally drop anchors whose href didn't
 * survive that transform.
 *
 * remark-breaks maps single newlines to <br>, matching how chat/assistant
 * messages are authored (a newline is a line break, not a paragraph join).
 */
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1 break-words [overflow-wrap:anywhere]">{children}</p>,
  h1: ({ children }) => <div className="text-[15px] font-semibold text-ink mt-2 mb-1">{children}</div>,
  h2: ({ children }) => <div className="text-[14px] font-semibold text-ink mt-2 mb-1">{children}</div>,
  h3: ({ children }) => <div className="text-[13px] font-semibold text-ink-soft mt-2 mb-1">{children}</div>,
  h4: ({ children }) => <div className="text-[12px] font-semibold text-ink-soft mt-2 mb-1">{children}</div>,
  h5: ({ children }) => <div className="text-[12px] font-semibold text-ink-soft mt-2 mb-1">{children}</div>,
  h6: ({ children }) => <div className="text-[12px] font-semibold text-ink-soft mt-2 mb-1">{children}</div>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through text-ink-mute">{children}</del>,
  hr: () => <hr className="border-divider my-2" />,
  ul: ({ children }) => (
    <ul className="list-disc pl-4 my-1 space-y-0.5 marker:text-ink-hush">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-4 my-1 space-y-0.5 marker:text-ink-hush">{children}</ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-divider pl-2 my-1 text-ink-mute italic">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => {
    // react-markdown already sanitised href; an empty string means the URL was
    // rejected (e.g. javascript:). Render the label as text, not a dead link.
    if (!href) return <>{children}</>;
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-sdk hover:brightness-110 underline decoration-sdk/40 hover:decoration-sdk/70"
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt }) =>
    src ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={alt ?? ""} className="max-h-64 max-w-full rounded-lg my-1" />
    ) : null,
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="border-collapse text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children, style }) => (
    <th className={`border border-divider px-2 py-1 font-semibold text-ink ${alignClass(style?.textAlign)}`}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className={`border border-divider px-2 py-1 align-top text-ink-soft ${alignClass(style?.textAlign)}`}>
      {children}
    </td>
  ),
  // Block code is wrapped in <pre><code>; unwrap the <pre> so the fenced block
  // renders through our highlight.js CodeBlock (which brings its own chrome).
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const match = /language-([\w-]+)/.exec(className || "");
    const isBlock = Boolean(match) || text.includes("\n");
    if (isBlock) {
      return <CodeBlock lang={match?.[1] ?? ""} body={text.replace(/\n$/, "")} />;
    }
    return (
      <code className="px-1 py-0.5 rounded bg-sunken text-ink font-mono text-[11px]">{children}</code>
    );
  },
};

export function Markdown({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
      {source}
    </ReactMarkdown>
  );
}

function alignClass(align: string | undefined): string {
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
}

function CodeBlock({ lang, body }: { lang: string; body: string }) {
  // Highlight the body. If the fence specifies a known language, use it;
  // otherwise fall back to auto-detection. highlight.js escapes input, so
  // the resulting HTML is safe to dangerouslySet.
  const highlighted = useMemo(() => {
    try {
      const normalised = normaliseLang(lang);
      if (normalised && hljs.getLanguage(normalised)) {
        return hljs.highlight(body, { language: normalised, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(body).value;
    } catch {
      // Highlighting is best-effort; fall back to escaped plain text.
      return escapeHtml(body);
    }
  }, [body, lang]);

  return (
    <div className="hoop-code my-1.5 rounded overflow-hidden">
      {lang && (
        <div className="hoop-code-lang px-2 py-0.5 text-[9px] uppercase tracking-wider font-mono">
          {lang}
        </div>
      )}
      <pre className="px-2 py-1.5 text-[11px] leading-relaxed overflow-x-auto whitespace-pre hljs">
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

function normaliseLang(lang: string): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase().trim();
  // Common aliases highlight.js doesn't accept by default.
  const aliases: Record<string, string> = {
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    yml: "yaml",
    md: "markdown",
    py: "python",
    rb: "ruby",
    rs: "rust",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    h: "c",
    "c++": "cpp",
    cs: "csharp",
    text: "plaintext",
    txt: "plaintext",
  };
  return aliases[l] ?? l;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
