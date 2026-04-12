# CRE-136: Hoop in Claude Code — Integration Evaluation

## TL;DR

**The hunch is correct.** Hoop is not just a set of skills — it's a **plugin** that requires an MCP server (for the long-running P2P node and state), hooks (for intercepting file changes and injecting peer updates), and skills (as user-facing entry points). The recommended path is a **claude-code plugin** with an MCP server at its core, hooks as its nervous system, and optionally an **Agent SDK wrapper** for full control over the interaction loop.

---

## 1. What Hoop Needs from a Host Environment

| Requirement | Description |
|---|---|
| **Long-running P2P node** | The libp2p node (TCP/WebRTC, noise, yamux) must persist for the entire session duration |
| **Session lifecycle** | Create session (host) / join session (peer) with interactive prompts |
| **Admission gate** | Host must approve/deny incoming peers in real-time |
| **File change broadcast** | Detect when files are written/edited, compute unified diff, broadcast to peers |
| **Receive peer changes** | Apply incoming diffs from peers to local filesystem |
| **State persistence** | StateTree, HostStateAccumulator, ReplayBuffer must survive across conversation turns |
| **Git worktree management** | Create worktree per session (host), checkout session branch (peer) |
| **Proponent-side execution** | Route tool calls to the peer's machine instead of executing locally |

## 2. Claude Code Extension Points

### 2.1 Hooks

Hooks are shell commands that fire on lifecycle events. They communicate via stdin (JSON event data), stdout (context injection), and exit codes (0=allow, 2=block).

**Available events:**

| Event | Fires When | Matcher | Can Inject Context to Claude? |
|---|---|---|---|
| `SessionStart` | Session begins | No | Yes (stdout → context) |
| `SessionEnd` | Session ends | No | No |
| `UserPromptSubmit` | User sends a message | No | Yes (stdout → context) |
| `PreToolUse` | Before tool execution | Tool name | Yes (stdout → system-reminder) |
| `PostToolUse` | After tool execution | Tool name | **Disputed** — Issue [#18427](https://github.com/anthropics/claude-code/issues/18427) reports stdout is NOT visible to Claude |
| `Notification` | On notification events | No | Unknown |
| `Stop` | Agent stops | No | No |

**Stdin payload** (common fields): `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`. Event-specific: `tool_name`, `tool_input` (PreToolUse/PostToolUse), `user_prompt` (UserPromptSubmit).

**Key limitations:**
- Hooks are fire-and-forget shell commands — no persistent state.
- Cannot execute tools or trigger slash commands.
- Cannot push notifications to an idle Claude (only fires during active events).
- PostToolUse context injection to Claude may not work (open issue).

### 2.2 MCP Servers

MCP servers provide tools that Claude can call. They run as child processes (stdio) or connect via SSE/HTTP/WebSocket.

**Key capabilities:**
- **Persistent process**: An MCP server lives for the duration of the claude-code session.
- **Custom tools**: Expose any tool Claude can call (e.g., `create-session`, `check-updates`).
- **In-process state**: The server can hold the libp2p node, session state, broadcast hub, etc.
- **Transport options**: stdio (local child process), SSE, HTTP, WebSocket.

**Key limitations:**
- MCP servers are **reactive** — they respond to tool calls, they cannot proactively send messages to Claude.
- Tool calls require Claude to decide to call them (unless prompted via hooks or CLAUDE.md).

### 2.3 Skills (Slash Commands)

Skills are SKILL.md files that inject prompt instructions when invoked via `/skill-name`.

**Key capabilities:**
- Guide Claude through multi-step workflows with user interaction.
- Can reference source files and instruct Claude to import and execute code.
- Can accept arguments.

**Key limitations:**
- No persistent state between invocations.
- They're prompt templates — Claude interprets and executes them, not a runtime.
- Cannot maintain background processes.

### 2.4 Plugins

Plugins are the **bundling mechanism** that combines hooks, skills, MCP servers, commands, and agents into a single installable unit.

**Plugin structure:**
```
.claude-plugin/
  plugin.json          # Metadata (name, description)
.mcp.json              # MCP server configuration
hooks/                  # Hook scripts
skills/                 # SKILL.md files
commands/               # Slash commands
agents/                 # Specialized agents
```

**Key insight**: A plugin IS the right abstraction for hoop — it bundles all extension types.

### 2.5 Agent SDK

The Agent SDK (`@anthropic-ai/claude-code`) provides programmatic control over Claude sessions.

**Key capabilities:**
- **Custom tools**: Define in-process MCP tools with Zod schemas and handlers — Claude calls them like built-in tools.
- **Session management**: Create, continue, resume sessions programmatically.
- **System prompt modification**: Inject custom system prompts and instructions.
- **Hook registration**: Register hooks programmatically (same events as settings.json).
- **Permission control**: Allow/deny tools programmatically.
- **Subagents**: Spawn sub-agents with full lifecycle control.

**Key advantage over plugin approach**: Full control over the interaction loop. Can build a custom TUI, push notifications, and intercept tool execution programmatically.

### 2.6 TUI

- The TUI is **not pluggable** — there's no extension API for custom UI elements.
- **Status line** can be customized (agent type `statusline-setup` exists).
- The Agent SDK allows building entirely custom interfaces on top of Claude.

## 3. Capability Mapping

| Hoop Requirement | Extension Point | Feasibility | Notes |
|---|---|---|---|
| Long-running P2P node | **MCP Server** (stdio) | ✅ Full | MCP server persists for session; hosts libp2p node in-process |
| Session create/join | **Skills** → **MCP Tools** | ✅ Full | Skills orchestrate conversation; MCP tools do the work |
| Admission gate | **MCP Tool** (polling) | ⚠️ Partial | Claude must actively call `check-admission-requests`; no push when idle |
| File change broadcast | **PostToolUse hook** → MCP | ⚠️ Partial | Hook fires on Edit/Write, calls MCP to broadcast. But see Issue #18427 |
| Receive peer changes | **PreToolUse hook** → inject | ⚠️ Partial | Injects pending changes as context before each tool call. Only works during active tool use |
| State persistence | **MCP Server** (in-process) | ✅ Full | All state lives in the MCP server process |
| Git worktree management | **MCP Tool** or **Bash** | ✅ Full | Straightforward shell commands |
| Proponent-side execution | **Agent SDK custom tools** | ⚠️ Hard | Requires wrapping standard tools with remote execution; hooks alone can't redirect |
| Session status display | **Status line** or **PreToolUse** | ⚠️ Limited | Can show info, but no rich UI |

## 4. Critical Gaps

### Gap 1: No Push Mechanism (Admission + Incoming Changes)

**Problem**: When the host's Claude is idle (between conversation turns), there's no way to:
- Deliver admission requests to the user
- Notify Claude about incoming file changes from peers

**Impact**: Admission only works during active tool use. Peer changes accumulate and are only discovered on the next tool call.

**Workarounds**:
- PreToolUse hook on `*` injects pending items as context on every tool call
- UserPromptSubmit hook injects pending items when the user sends a message
- Agent SDK: full control — can implement a polling loop or event-driven UI

### Gap 2: PostToolUse Cannot Inject Context to Claude (Issue #18427)

**Problem**: The PostToolUse hook's stdout may not be visible to Claude's context. This is critical because the file change broadcast loop depends on PostToolUse detecting edits and informing Claude about the broadcast result.

**Impact**: Claude won't know if a file change was successfully broadcast, can't retry on failure.

**Workarounds**:
- Use PostToolUse hook purely as a side-effect (fire-and-forget broadcast) — don't rely on Claude seeing the result
- Move broadcast logic into a custom MCP tool that Claude calls explicitly after editing
- Agent SDK: custom Edit/Write tools that include broadcast as part of their handler

### Gap 3: Proponent-Side Execution

**Problem**: When `executionTarget = "proponent-side"`, tool calls should execute on the peer's machine, not the host's. Hooks can block tool execution (exit 2) but cannot redirect it to a remote machine and return the result.

**Impact**: The proponent-side execution model cannot be implemented with hooks alone.

**Workarounds**:
- Agent SDK: Define custom tools (e.g., `remote-bash`, `remote-edit`) that serialize the tool call, send it to the peer via P2P, wait for the result, and return it.
- Two-phase approach: PreToolUse blocks → MCP tool sends to peer → peer executes → result injected on next turn. Clunky but possible.

### Gap 4: Hook Reliability

**Problem**: Multiple open GitHub issues report hooks not firing correctly:
- [#6305](https://github.com/anthropics/claude-code/issues/6305): Hooks not executing
- [#3179](https://github.com/anthropics/claude-code/issues/3179): WSL2 hooks broken
- [#16564](https://github.com/anthropics/claude-code/issues/16564): Missing env vars on Windows

**Impact**: Hooks are load-bearing in the plugin approach. If they don't fire reliably, file change detection fails silently.

**Mitigation**: Test thoroughly on target platforms. Have MCP tool fallbacks for critical paths.

## 5. Recommended Architecture

### Option A: Claude Code Plugin (Pragmatic MVP)

```
hoop/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json                          # → starts hoop MCP server (stdio)
├── hooks/
│   ├── post-tool-use-broadcast.sh     # Edit|Write → compute diff → send to MCP
│   ├── pre-tool-use-inject.sh         # * → check MCP for pending changes → inject
│   ├── session-start.sh               # Resume active session if any
│   └── user-prompt-submit.sh          # Inject pending admission requests
├── skills/
│   ├── hoop-new/SKILL.md              # Create session (calls MCP tools)
│   └── hoop-join/SKILL.md             # Join session (calls MCP tools)
└── src/                               # Hoop core (current codebase)
```

**MCP Server exposes tools:**
- `hoop_create_session` — Start P2P node, create worktree, return session code
- `hoop_join_session` — Connect to host, authenticate, sync state
- `hoop_check_updates` — Return pending incoming changes from peers
- `hoop_check_admissions` — Return pending admission requests
- `hoop_admit_peer` / `hoop_deny_peer` — Respond to admission request
- `hoop_send_update` — Send a state update (file change, cursor, metadata)
- `hoop_get_status` — Session status, connected peers, branch name
- `hoop_leave_session` — Disconnect and clean up

**Hooks flow:**
```
[Claude edits file]
  → PostToolUse fires
    → hook reads tool_input (file path)
    → hook computes diff
    → hook calls MCP server to broadcast

[Claude is about to use any tool]
  → PreToolUse fires
    → hook calls MCP server for pending changes
    → hook returns pending changes as stdout (injected as context)
    → Claude sees: "Peer X changed file Y. Here's the diff: ..."

[User sends a message]
  → UserPromptSubmit fires
    → hook checks for pending admission requests
    → hook returns: "Peer alice@example.com wants to join. Use hoop_admit_peer or hoop_deny_peer."
```

**Pros:**
- Works with standard claude-code CLI (no custom wrapper needed)
- Users install it as a plugin — standard distribution
- Leverages existing extension points
- Can iterate quickly

**Cons:**
- Polling-based (no push notifications when idle)
- PostToolUse context injection may not work (Gap 2)
- No proponent-side execution
- Hook reliability concerns

### Option B: Agent SDK Wrapper (Full Control)

```typescript
import { query } from "@anthropic-ai/claude-code";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-code/sdk";

// Hoop tools as in-process MCP
const hoopServer = createSdkMcpServer({
  tools: [
    tool("create_session", "Create a new hoop P2P session", schema, handler),
    tool("join_session", "Join an existing hoop session", schema, handler),
    tool("remote_edit", "Edit a file (with P2P broadcast)", schema, handler),
    tool("remote_bash", "Execute command (routed by execution target)", schema, handler),
    // ... all hoop tools
  ],
});

// Custom interaction loop with push notifications
const result = await query({
  prompt: userInput,
  mcpServers: { hoop: hoopServer },
  allowedTools: ["mcp__hoop__*"],
  hooks: {
    postToolUse: [{ matcher: "Edit|Write", callback: broadcastFileChange }],
  },
  systemPrompt: "You are in a hoop collaborative session. ...",
});
```

**Pros:**
- Full control over the interaction loop
- Can implement push notifications (admission requests interrupt idle state)
- Custom tools wrap standard tools with P2P broadcast built-in
- Proponent-side execution via custom tool routing
- Can build a custom TUI showing peer status, session info
- In-process MCP means zero-latency tool calls

**Cons:**
- Requires users to install a custom CLI (`hoop` instead of `claude`)
- More complex to build and maintain
- Loses some claude-code ecosystem benefits (other plugins may not compose)
- Heavier distribution burden

### Option C: Hybrid (Recommended)

**Phase 1 — Plugin (validate the model)**:
- Build as a claude-code plugin (Option A)
- Skills + MCP server + hooks
- Accept polling limitations
- Ship `host-only` execution target only
- Validate that collaborative sessions work end-to-end

**Phase 2 — Agent SDK layer (unlock full power)**:
- Build `hoop` CLI as an Agent SDK wrapper
- Embed the libp2p node in-process
- Custom tools with built-in broadcast
- Push notifications for admission
- Proponent-side execution via remote tool routing
- Custom TUI with peer status panel

**Phase 3 — Plugin delegates to SDK**:
- The plugin's MCP server becomes a thin client to the SDK-based hoop daemon
- Best of both worlds: works in standard claude-code AND as standalone CLI

## 6. What the Plugin Overrides

To answer the core question — "hoop is more than skills, it's a plugin that will override the hooks":

**Yes, but it doesn't "override" hooks — it USES them.** Specifically:

| Hook Event | What Hoop Does |
|---|---|
| `SessionStart` | Checks for active session, resumes MCP connection |
| `SessionEnd` | Graceful P2P shutdown |
| `UserPromptSubmit` | Injects pending admission requests + peer changes |
| `PreToolUse (*)` | Injects pending peer changes before every tool call |
| `PostToolUse (Edit\|Write)` | Captures file changes, computes diff, broadcasts to peers |

The plugin doesn't override existing hooks — it adds its own. But it does fundamentally change the workflow by:
1. Making Claude aware it's in a collaborative session (via CLAUDE.md / system prompt)
2. Intercepting every file write to broadcast changes
3. Injecting peer context on every tool call
4. Adding admission management to the user's interaction flow

This is a **workflow-level integration**, not just a tool addition.

## 7. Open Questions

1. **Hook composition**: If the user has other plugins with PreToolUse hooks, do they compose correctly? What's the execution order?
2. **MCP server lifecycle**: Does the MCP server restart when claude-code restarts? How does session resumption work?
3. **Performance**: PreToolUse hook on every tool call adds latency. Is the MCP roundtrip fast enough?
4. **Large diffs**: Injecting large file diffs as PreToolUse context could blow up the context window. Need a summarization strategy.
5. **Multiple peers**: With N peers all sending changes, the PreToolUse injection could become overwhelming. Need batching/prioritization.
6. **PostToolUse Issue #18427**: This is a blocker if confirmed. Need to validate on current claude-code version.

## 8. Immediate Next Steps

1. **Validate PostToolUse context injection** — Write a minimal PostToolUse hook and check if stdout appears in Claude's context. If not, the fallback is MCP-tool-based broadcast.
2. **Build MCP server prototype** — Wrap the existing hoop core as an MCP server with stdio transport. Expose `create_session` and `get_status` as tools.
3. **Build PostToolUse hook prototype** — Capture Edit/Write events, compute diff, send to MCP server.
4. **Test PreToolUse injection** — Verify that PreToolUse stdout appears as a system-reminder in Claude's context.
5. **Scaffold the plugin structure** — `.claude-plugin/`, `.mcp.json`, `hooks/`, updated `skills/`.
