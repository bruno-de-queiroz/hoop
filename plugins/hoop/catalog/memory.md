# Catalog: memory backend

Read by `/hoop:setup` to populate the memory menu.

Menu items: claude-mem, Mem0, mcp-memory-service, MemPalace, Skip.

---

## Option: claude-mem (recommended default)

**One-line pitch:** Local, automatic session capture with AI compression. Most popular Claude Code memory plugin in 2026.

**When to pick:** Want local-only memory, no cloud dependencies, semantic search across past sessions. Solo or small-team use.

**Prereqs:** Node.js / npm available.

**Install (auto-runnable):**
```bash
npx claude-mem install
```

**Alternative install (user-typed slash commands):**
```
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem@claude-mem
```

**Verify:**
```bash
cat ~/.claude/installed_plugins.json 2>/dev/null | grep claude-mem
```

**Notes:** The `npx claude-mem install` path is preferred because it registers plugin hooks AND sets up the background worker service. The marketplace plugin path registers the plugin but the worker setup is separate.

---

## Option: Mem0

**One-line pitch:** Cloud memory shared across tools and teams. Cross-platform.

**When to pick:** Want memory that follows you across Claude Code, Cursor, ChatGPT, and other tools. OK with cloud storage and a paid tier above the free quota.

**Prereqs:** Account at https://app.mem0.ai. API key (starts with `m0-`).

**Install (auto-runnable):**
```bash
export MEM0_API_KEY="m0-<YOUR_KEY>"
```

Then user-typed slash commands:
```
/plugin marketplace add mem0ai/mem0
/plugin install mem0@mem0-plugins
```

**MCP-only alternative (no plugin lifecycle):**
```bash
npx mcp-add --name mem0-mcp --type http --url "https://mcp.mem0.ai/mcp" --clients "claude code"
```

**Verify:**
```bash
cat ~/.claude/installed_plugins.json 2>/dev/null | grep mem0
```

**Notes:** Setup must ask the user for their Mem0 API key. Free tier has scale limits.

---

## Option: mcp-memory-service

**One-line pitch:** Open-source persistent memory with REST API and knowledge graph backend. Self-hostable.

**When to pick:** Want self-hosted memory you control. Comfortable installing Python tooling. Like knowledge-graph features.

**Prereqs:** Python 3.10+. Install the `memory` CLI tool first:
```bash
pip install mcp-memory-service
```

**Install (auto-runnable):**
```bash
claude mcp add --scope user memory -- memory server
```

**Verify:**
```bash
claude mcp list | grep memory
```

**Notes:** Provides autonomous memory consolidation. Has a REST API for other clients beyond Claude Code.

---

## Option: MemPalace

**One-line pitch:** Local-first AI memory using a memory-palace metaphor (Wings, Rooms, Halls). Pure MCP.

**When to pick:** Want strictly local memory with no cloud calls. Like the spatial organization metaphor. Python is your comfort zone.

**Prereqs:** Python 3.9+, chromadb 0.4.0+, pyyaml 6.0+. The only legitimate sources are the official GitHub repo `mempalace/mempalace`, the PyPI `mempalace` package, and `mempalaceofficial.com`. Other domains may distribute malware; verify the source before installing.

**Install (auto-runnable):**
```bash
pip install mempalace
claude mcp add --scope user mempalace -- python -m mempalace.mcp_server
```

**Verify:**
```bash
mempalace --version
claude mcp list | grep mempalace
```

**Notes:** Should print "3.0.0" or higher after the version check. All data stays local.

---

## Option: Skip

No memory backend installed. The routing layer will note "memory: none". Strongly discouraged: most downstream hoop patterns assume some form of cross-session memory.
