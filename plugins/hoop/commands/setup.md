---
description: Set up the hoop stack. The interactive wizard now lives in the hoop CLI (`hoop install setup`) so it works with or without Claude Code on the host; this command points you to it.
allowed-tools: ["Bash"]
---

# /hoop:setup

The hoop setup wizard has moved into the **hoop CLI** as `hoop install setup`. It's a
single source of truth: the same wizard configures the sandbox stack (memory,
code-graph RAG, automation, platform MCPs, docs RAG, semantic search,
observability, design, second-brain, telemetry isolation) whether or not the
host has Claude Code installed.

It is an **interactive terminal wizard** (menus, secret prompts). Claude's Bash
tool is not an interactive TTY, so it cannot drive the menus for you — the user
runs it in their own terminal. Your job here is only to point them to the right
command.

## What to do

1. Resolve the hoop CLI path and check whether `hoop` is already on the user's PATH:

```bash
# Prefer the installed plugin's CLI; fall back to the highest-semver cache dir.
INSTALLED="$HOME/.claude/plugins/installed_plugins.json"
PLUGIN_ROOT=$(jq -r '(.plugins | to_entries[] | select(.key|startswith("hoop@")) | .value[0].installPath) // empty' "$INSTALLED" 2>/dev/null | head -1)
if [ -z "$PLUGIN_ROOT" ] || [ ! -f "$PLUGIN_ROOT/.claude-plugin/plugin.json" ]; then
  PLUGIN_ROOT=$(ls -d "$HOME"/.claude/plugins/cache/*/hoop/*/ 2>/dev/null | sort -V | tail -1)
  PLUGIN_ROOT="${PLUGIN_ROOT%/}"
fi
HOOP_CLI="$PLUGIN_ROOT/cli/hoop.sh"
command -v hoop >/dev/null 2>&1 && echo "hoop is on PATH" || echo "hoop not on PATH — use: $HOOP_CLI"
```

2. Tell the user to run the wizard **in their terminal** (not via you):

- If `hoop` is on PATH:  `hoop install setup`
- Otherwise:            `"$HOOP_CLI" install setup`   (or run `"$HOOP_CLI" install` first to put `hoop` on PATH)

3. Briefly explain what it does and that it runs before `hoop login` (configuring
   MCPs needs no auth). Point out that after it finishes they should run
   `hoop login` (one-time) and `hoop start` to open the dashboard.

Do **not** try to run `hoop install setup` yourself — it will detect the
non-interactive shell and refuse. Just surface the command for the user.
