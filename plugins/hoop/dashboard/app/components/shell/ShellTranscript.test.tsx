import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { EventRow } from "@/lib/sandbox-types";
import { ShellTranscript } from "./ShellTranscript";

// Regression: a host chat/prompt must render as the host (green `bubble-host`),
// never as a peer. The transcript used to hardcode Chat→peer and prompt→host,
// so a host chat surfaced as "HOST · peer" in a blue peer bubble.

function ev(partial: Partial<EventRow> & { id: number; hook_type: string }): EventRow {
  return {
    ts: "2026-07-15T16:33:00.000Z",
    session_id: "s1",
    tool_name: null,
    text: null,
    author: null,
    ...partial,
  } as EventRow;
}

function renderTranscript(events: EventRow[]) {
  return render(
    <ShellTranscript events={events} hasMore={false} onLoadMore={() => {}} isWaiting={false} />,
  );
}

function tool(id: number, hook: "PreToolUse" | "PostToolUse", name: string): EventRow {
  return ev({ id, hook_type: hook, tool_name: name });
}
function stopText(id: number, text: string): EventRow {
  return ev({ id, hook_type: "Stop", text: `[Stop] | last_assistant_message=${text}` });
}

describe("ShellTranscript author attribution", () => {
  it("renders a host chat as a host bubble, not a peer", () => {
    renderTranscript([ev({ id: 1, hook_type: "Chat", author: "host", text: "Hi Ralph" })]);
    const bubble = screen.getByText("Hi Ralph").closest(".bubble")!;
    expect(bubble.className).toMatch(/bubble-host/);
    expect(bubble.className).not.toMatch(/bubble-peer/);
  });

  it("renders a peer chat as a peer bubble with the guest's name", () => {
    renderTranscript([ev({ id: 2, hook_type: "Chat", author: "Ralph", text: "hi there" })]);
    const bubble = screen.getByText("hi there").closest(".bubble")!;
    expect(bubble.className).toMatch(/bubble-peer/);
    expect(screen.getByText("Ralph · peer")).toBeInTheDocument();
  });

  it("marks chat messages with a distinct chat glyph, but not prompts", () => {
    const { rerender } = renderTranscript([
      ev({ id: 6, hook_type: "Chat", author: "host", text: "aside" }),
    ]);
    expect(screen.getByLabelText("chat")).toBeInTheDocument();

    rerender(
      <ShellTranscript
        events={[ev({ id: 7, hook_type: "UserPromptSubmit", author: "host", text: "a prompt" })]}
        hasMore={false}
        onLoadMore={() => {}}
        isWaiting={false}
      />,
    );
    expect(screen.queryByLabelText("chat")).toBeNull();
  });

  it("attributes prompts by author too (host prompt → host, peer prompt → peer)", () => {
    renderTranscript([
      ev({ id: 3, hook_type: "UserPromptSubmit", author: null, text: "host prompt" }),
      ev({ id: 4, hook_type: "UserPromptSubmit", author: "Ralph", text: "peer prompt" }),
    ]);
    expect(screen.getByText("host prompt").closest(".bubble")!.className).toMatch(/bubble-host/);
    expect(screen.getByText("peer prompt").closest(".bubble")!.className).toMatch(/bubble-peer/);
  });

  it("renders attached image thumbnails in the message bubble", () => {
    const img = { media_type: "image/png", data: "AAAA" };
    renderTranscript([
      { ...ev({ id: 8, hook_type: "UserPromptSubmit", author: "host", text: "look" }), images: [img] },
    ]);
    const el = screen.getByAltText("attached image") as HTMLImageElement;
    expect(el.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("renders an image-only message (no text) with just the thumbnail", () => {
    renderTranscript([
      {
        ...ev({ id: 9, hook_type: "UserPromptSubmit", author: "host", text: "" }),
        images: [{ media_type: "image/jpeg", data: "BBBB" }],
      },
    ]);
    expect(screen.getByAltText("attached image")).toBeInTheDocument();
  });

  it("does not leak the bare wrapper as text for a stored image-only turn", () => {
    // An image-only turn is stored as just "[UserPromptSubmit]" (the sandbox's
    // deriveText drops the empty prompt). The bubble must render the image and
    // NOT the raw wrapper string. Same path covers a bare "[Chat]" message.
    renderTranscript([
      {
        ...ev({ id: 13, hook_type: "UserPromptSubmit", author: "host", text: "[UserPromptSubmit]" }),
        images: [{ media_type: "image/jpeg", data: "CCCC" }],
      },
    ]);
    expect(screen.getByAltText("attached image")).toBeInTheDocument();
    expect(screen.queryByText("[UserPromptSubmit]")).toBeNull();
  });

  it("renders a plan-approval turn as an approval notice, not a host bubble", () => {
    renderTranscript([
      ev({
        id: 10,
        hook_type: "UserPromptSubmit",
        author: "host",
        kind: "plan-approval",
        text: "The plan is approved — proceed with implementing it.",
      }),
    ]);
    // A distinct "Plan approved" notice — never the raw injected instruction,
    // and never a normal host chat bubble.
    expect(screen.getByText("Plan approved")).toBeInTheDocument();
    expect(screen.queryByText(/proceed with implementing it/)).toBeNull();
    expect(document.querySelector(".bubble-host")).toBeNull();
  });

  it("renders a plan-rejection turn as a changes-requested notice with the feedback", () => {
    renderTranscript([
      ev({
        id: 11,
        hook_type: "UserPromptSubmit",
        author: "host",
        kind: "plan-rejection",
        text: "The plan was rejected. Revise it based on this feedback:\n\nTighten step 2.",
      }),
    ]);
    expect(screen.getByText("Changes requested")).toBeInTheDocument();
    // The boilerplate prefix is stripped; only the human's feedback is shown.
    expect(screen.getByText("Tighten step 2.")).toBeInTheDocument();
    expect(screen.queryByText(/The plan was rejected/)).toBeNull();
  });

  it("renders a slash-command turn as a distinct command card, not a chat bubble", () => {
    renderTranscript([
      ev({
        id: 12,
        hook_type: "UserPromptSubmit",
        author: "host",
        kind: "command",
        text: "[UserPromptSubmit] | prompt=/plan add caching | kind=command",
      }),
    ]);
    // Distinct command styling — the slash token in its own accent badge, the
    // arguments beside it, and NOT an ordinary host chat bubble.
    expect(screen.getByTestId("command-turn")).toBeInTheDocument();
    expect(screen.getByText("/plan")).toBeInTheDocument();
    expect(screen.getByText("add caching")).toBeInTheDocument();
    expect(document.querySelector(".bubble-host")).toBeNull();
    expect(screen.queryByTestId("user-prompt")).toBeNull();
  });

  function bashEvent(
    id: number,
    o: { runId?: string; status?: "running" | "done"; exitCode?: number | null; stdout?: string; command?: string },
  ): EventRow {
    const resp = {
      run_id: o.runId ?? null,
      status: o.status ?? null,
      exit_code: o.exitCode ?? null,
      signal: null,
      duration_ms: 1,
      timed_out: false,
      stdout: o.stdout ?? "",
      stderr: "",
    };
    const cmd = o.command ?? "echo hi";
    return ev({
      id,
      hook_type: "BashShortcut",
      text: `[BashShortcut] | tool=BashShortcut | tool_input=${cmd} | tool_response=${JSON.stringify(resp)}`,
    });
  }

  it("coalesces streaming BashShortcut snapshots (same run_id) into ONE card showing the latest", () => {
    renderTranscript([
      bashEvent(1, { runId: "R1", status: "running", stdout: "early-chunk" }),
      bashEvent(2, { runId: "R1", status: "running", stdout: "early-chunk more" }),
      bashEvent(3, { runId: "R1", status: "done", exitCode: 0, stdout: "early-chunk more final" }),
    ]);
    // Exactly one card for the run (not one per snapshot).
    expect(screen.getAllByText("echo hi")).toHaveLength(1);
    // Latest (done) snapshot's data wins.
    expect(screen.getByText("exit 0")).toBeInTheDocument();
    expect(screen.getByText("early-chunk more final")).toBeInTheDocument();
    expect(screen.queryByText("running")).toBeNull();
  });

  it("shows a running indicator while a bash run is still streaming", () => {
    renderTranscript([bashEvent(1, { runId: "R2", status: "running", stdout: "" })]);
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.queryByText(/exit/)).toBeNull();
  });

  it("renders a legacy (no run_id) BashShortcut as a single card", () => {
    renderTranscript([bashEvent(1, { exitCode: 0, stdout: "hi", command: "echo legacy" })]);
    expect(screen.getAllByText("echo legacy")).toHaveLength(1);
    expect(screen.getByText("exit 0")).toBeInTheDocument();
  });

  it("renders an API failure (kind=error) as a failure notice, not an assistant reply", () => {
    renderTranscript([
      ev({
        id: 20,
        hook_type: "Stop",
        kind: "error",
        text: "[Stop] | last_assistant_message=You've hit your session limit · resets 11:10pm (UTC) | kind=error",
      }),
    ]);
    expect(screen.getByText("turn failed")).toBeInTheDocument();
    expect(screen.getByText(/hit your session limit/)).toBeInTheDocument();
    // Not styled as something the model said.
    expect(document.querySelector(".bubble-assistant")).toBeNull();
  });

  it("still renders a benign synthetic notice (kind=info, e.g. /cost) as an assistant bubble", () => {
    renderTranscript([
      ev({
        id: 21,
        hook_type: "Stop",
        kind: "info",
        text: "[Stop] | last_assistant_message=Total cost: $0.42 | kind=info",
      }),
    ]);
    expect(screen.queryByText("turn failed")).toBeNull();
    expect(document.querySelector(".bubble-assistant")).not.toBeNull();
  });

  it("names the joined peer in the resolve breaker via the event message", () => {
    // The sandbox emits `message=<name> joined` on PeerJoinResolved; the divider
    // surfaces it (lowercased; CSS upcases) instead of a bare hook name.
    renderTranscript([
      ev({ id: 5, hook_type: "PeerJoinResolved", text: "[PeerJoinResolved] | message=Ralph joined" }),
    ]);
    expect(screen.getByText("ralph joined")).toBeInTheDocument();
    expect(screen.queryByText("peerjoinresolved")).toBeNull();
  });

  it("renders a returning peer as 'rejoined' (same PeerJoinResolved hook, different message)", () => {
    // A rejoin reuses PeerJoinResolved (so the host's admission toast still
    // clears); only the message differs, and the divider surfaces it verbatim.
    renderTranscript([
      ev({ id: 8, hook_type: "PeerJoinResolved", text: "[PeerJoinResolved] | message=Ralph rejoined" }),
    ]);
    expect(screen.getByText("ralph rejoined")).toBeInTheDocument();
  });

  it("renders a PeerLeft marker as a '<name> left' divider", () => {
    renderTranscript([
      ev({ id: 9, hook_type: "PeerLeft", text: "[PeerLeft] | message=Ralph left" }),
    ]);
    expect(screen.getByText("ralph left")).toBeInTheDocument();
    expect(screen.queryByText("peerleft")).toBeNull();
  });
});

describe("ShellTranscript tool clustering", () => {
  it("clusters consecutive tool calls under ONE avatar", () => {
    renderTranscript([
      tool(1, "PreToolUse", "Read"),
      tool(2, "PostToolUse", "Read"),
      tool(3, "PreToolUse", "Grep"),
      tool(4, "PostToolUse", "Grep"),
    ]);
    expect(screen.getAllByTestId("tool-cluster")).toHaveLength(1);
  });

  it("splits into a new cluster when the model emits a visible text turn between tools", () => {
    renderTranscript([
      tool(1, "PreToolUse", "Read"),
      tool(2, "PostToolUse", "Read"),
      stopText(3, "here is what I found"),
      tool(4, "PreToolUse", "Grep"),
      tool(5, "PostToolUse", "Grep"),
    ]);
    // Cluster → assistant text → cluster.
    expect(screen.getAllByTestId("tool-cluster")).toHaveLength(2);
    expect(screen.getByText("here is what I found")).toBeInTheDocument();
  });

  it("does NOT split a cluster on an empty Stop (invisible turn boundary)", () => {
    renderTranscript([
      tool(1, "PreToolUse", "Read"),
      tool(2, "PostToolUse", "Read"),
      ev({ id: 3, hook_type: "Stop", text: "" }),
      tool(4, "PreToolUse", "Grep"),
      tool(5, "PostToolUse", "Grep"),
    ]);
    expect(screen.getAllByTestId("tool-cluster")).toHaveLength(1);
  });

  it("keeps a 2-call cluster fully expanded (no collapse summary)", () => {
    renderTranscript([
      tool(1, "PreToolUse", "Read"),
      tool(2, "PostToolUse", "Read"),
      tool(3, "PreToolUse", "Grep"),
      tool(4, "PostToolUse", "Grep"),
    ]);
    expect(screen.queryByTestId("tool-cluster-collapsed")).toBeNull();
    // Two cards → two "tool" chips.
    expect(screen.getAllByText("tool")).toHaveLength(2);
  });

  it("auto-collapses a cluster with more than 2 calls into a count + token summary", () => {
    renderTranscript([
      tool(1, "PreToolUse", "Read"),
      tool(2, "PostToolUse", "Read"),
      tool(3, "PreToolUse", "Grep"),
      tool(4, "PostToolUse", "Grep"),
      tool(5, "PreToolUse", "Bash"),
      tool(6, "PostToolUse", "Bash"),
    ]);
    expect(screen.getByTestId("tool-cluster-collapsed")).toBeInTheDocument();
    expect(screen.getByText(/3 tool calls/)).toBeInTheDocument();
    expect(screen.getByText(/tokens/)).toBeInTheDocument();
    // Cards are hidden until expanded — no "tool" chips visible.
    expect(screen.queryAllByText("tool")).toHaveLength(0);
  });

  it("expands the collapsed cluster on 'show all' and can collapse again", () => {
    renderTranscript([
      tool(1, "PreToolUse", "Read"),
      tool(2, "PostToolUse", "Read"),
      tool(3, "PreToolUse", "Grep"),
      tool(4, "PostToolUse", "Grep"),
      tool(5, "PreToolUse", "Bash"),
      tool(6, "PostToolUse", "Bash"),
    ]);
    fireEvent.click(screen.getByText("show all"));
    // Three cards now visible.
    expect(screen.getAllByText("tool")).toHaveLength(3);
    expect(screen.queryByTestId("tool-cluster-collapsed")).toBeNull();

    // And it collapses back.
    fireEvent.click(screen.getByText("show less"));
    expect(screen.getByTestId("tool-cluster-collapsed")).toBeInTheDocument();
  });
});

describe("ShellTranscript viewer-relative bubble color", () => {
  function renderAs(viewer: { kind: "host" | "peer"; name: string }, events: EventRow[]) {
    return render(
      <ShellTranscript
        events={events}
        hasMore={false}
        onLoadMore={() => {}}
        isWaiting={false}
        viewerKind={viewer.kind}
        viewerName={viewer.name}
      />,
    );
  }

  it("as a PEER viewer: my own turn is green (host bubble), the host is blue (peer bubble)", () => {
    renderAs({ kind: "peer", name: "Ralph" }, [
      ev({ id: 1, hook_type: "UserPromptSubmit", author: null, text: "from the host" }),
      ev({ id: 2, hook_type: "UserPromptSubmit", author: "Ralph", text: "from me" }),
    ]);
    // My own (Ralph) message → green host bubble.
    expect(screen.getByText("from me").closest(".bubble")!.className).toMatch(/bubble-host/);
    // The host, from my peer perspective → blue peer bubble.
    expect(screen.getByText("from the host").closest(".bubble")!.className).toMatch(/bubble-peer/);
  });

  it("another peer's turn is blue for a peer viewer (everyone-but-me is blue)", () => {
    renderAs({ kind: "peer", name: "Ralph" }, [
      ev({ id: 1, hook_type: "UserPromptSubmit", author: "Sam", text: "from sam" }),
    ]);
    expect(screen.getByText("from sam").closest(".bubble")!.className).toMatch(/bubble-peer/);
  });
});

describe("ShellTranscript horizontal overflow (mobile wrap)", () => {
  // A long unbroken token (no spaces) — the shape that fails to wrap under a
  // bare `whitespace-pre-wrap` and pushes the card wider than the viewport.
  const LONG = "x".repeat(400);

  function bashWithStdout(id: number, stdout: string): EventRow {
    const resp = {
      run_id: null, status: null, exit_code: 0, signal: null,
      duration_ms: 1, timed_out: false, stdout, stderr: "",
    };
    return ev({
      id,
      hook_type: "BashShortcut",
      text: `[BashShortcut] | tool=BashShortcut | tool_input=echo x | tool_response=${JSON.stringify(resp)}`,
    });
  }

  it("clips the transcript's x-axis so stray overflow can't create a horizontal bar", () => {
    renderTranscript([ev({ id: 1, hook_type: "UserPromptSubmit", author: "host", text: "hi" })]);
    expect(screen.getByTestId("shell-transcript").className).toContain("overflow-x-hidden");
  });

  it("wraps long unbroken bash output instead of overflowing", () => {
    renderTranscript([bashWithStdout(1, LONG)]);
    const out = screen.getByText(LONG);
    expect(out.className).toContain("[overflow-wrap:anywhere]");
  });
});

describe("ShellTranscript peer typing bubble", () => {
  it("renders a blue peer typing bubble with the name when typingLabel is set", () => {
    render(
      <ShellTranscript
        events={[]}
        hasMore={false}
        onLoadMore={() => {}}
        isWaiting={false}
        typingLabel="Ralph"
      />,
    );
    const bubble = screen.getByTestId("peer-typing");
    expect(bubble.querySelector(".bubble-peer")).not.toBeNull();
    expect(screen.getByText("Ralph")).toBeInTheDocument();
  });

  it("renders no typing bubble when typingLabel is empty (e.g. only self is typing)", () => {
    render(
      <ShellTranscript events={[]} hasMore={false} onLoadMore={() => {}} isWaiting={false} typingLabel="" />,
    );
    expect(screen.queryByTestId("peer-typing")).toBeNull();
  });
});
