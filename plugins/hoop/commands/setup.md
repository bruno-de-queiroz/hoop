---
description: Set up the hoop stack. The interactive wizard now lives in the hoop CLI (`hoop setup`) so it works with or without Claude Code on the host; this command points you to it.
allowed-tools: ["Bash"]
---

# /hoop:setup

The hoop setup wizard has moved into the **hoop CLI** as `hoop setup`. It's a
single source of truth: it configures the sandbox stack (memory, code-graph RAG,
automation, platform MCPs, docs RAG, semantic search, observability, design,
second-brain, telemetry isolation) whether or not the host has Claude Code
installed. It has three modes:

- `hoop setup` — installs the **non-interactive default stack** (claude-mem,
  Serena, Context7, semantic search, GitHub, telemetry isolation).
- `hoop setup --wizard` — the **full interactive wizard** (menus, secret prompts).
- `hoop setup <section>…` — runs just the named layers, e.g.
  `hoop setup automation mcps`. Sections: `code-graph`, `automation`, `mcps`,
  `rag`, `model-runner`, `telemetry`, `observability`, `design`,
  `second-brain`, `memory`.

`hoop install` already chains into `hoop setup` (default mode), so a fresh
standalone install is a single command — see the README. The `--wizard` and
`<section>` modes have **interactive menus / secret prompts**, and every mode's
sign-ins (Claude `/login`, `gh`) need a real terminal. Claude's Bash tool is not
an interactive TTY, so it can't drive those for you — the user runs them in their
own terminal. Your job here is only to point them to the right command.

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

2. Tell the user to run setup **in their terminal** (not via you). Pick the form
   that matches their intent:

- Default stack:  `hoop setup`  (or `"$HOOP_CLI" setup`)
- Full menus:     `hoop setup --wizard`
- Just some layers: `hoop setup <section>…`
- Never installed yet? `"$HOOP_CLI" install` is the one-liner (wires the CLI onto
  PATH, then runs `hoop setup` for them).

3. Briefly explain what it does: it configures the sandbox stack and, when run in
   a terminal, completes the sign-ins (Claude `/login`, `gh`) and starts the
   dashboard at http://localhost:7842/. If they skipped the sign-ins, they finish
   with `hoop login` (one-time).

Do **not** try to run these yourself — the `--wizard` / `<section>` menus and
every mode's sign-ins need a real interactive TTY, which Claude's Bash tool is
not. Just surface the right command for the user.
