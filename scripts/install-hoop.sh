#!/usr/bin/env bash
# Installs hoop as a Claude Code plugin and registers it in the user's
# settings.json so skills, hooks, and the MCP server are activated.
#
# Env vars (all optional):
#   HOOP_SRC           — source checkout directory (default: $PWD)
#                        Must already contain dist/mcp/main.js (run `npm run build` first).
#   HOOP_DEST          — plugin install directory (default: $HOME/.claude/plugins/hoop)
#   HOOP_INSTALL_MODE  — "copy" (default) or "symlink". Symlink is useful for dev
#                        and for containers where the source tree is bind-mounted.
#
# Usage:
#   bash scripts/install-hoop.sh
#   HOOP_INSTALL_MODE=symlink HOOP_SRC=/build bash /usr/local/bin/install-hoop
set -euo pipefail

HOOP_SRC="${HOOP_SRC:-$PWD}"
HOOP_DEST="${HOOP_DEST:-$HOME/.claude/plugins/hoop}"
HOOP_INSTALL_MODE="${HOOP_INSTALL_MODE:-copy}"

# Marketplace identifier matches `name` in .claude-plugin/marketplace.json.
# Plugin identifier is "<plugin-name>@<marketplace-name>" — both are "hoop"
# in this single-plugin marketplace.
HOOP_MARKETPLACE_NAME="hoop"
HOOP_PLUGIN_NAME="hoop"

# ── Prerequisites ─────────────────────────────────────────────────────
for bin in node git jq bash; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "install-hoop: missing required tool: $bin" >&2
    exit 1
  }
done

# Symlink mode tolerates a source tree that isn't populated yet (it will be
# mounted in later). Copy mode requires the MCP server to be built.
if [ "$HOOP_INSTALL_MODE" = "copy" ] && [ ! -f "$HOOP_SRC/dist/mcp/main.js" ]; then
  echo "install-hoop: missing $HOOP_SRC/dist/mcp/main.js — run 'npm run build' first" >&2
  exit 1
fi

case "$HOOP_INSTALL_MODE" in
  copy|symlink) ;;
  *) echo "install-hoop: HOOP_INSTALL_MODE must be 'copy' or 'symlink' (got: $HOOP_INSTALL_MODE)" >&2; exit 1 ;;
esac

# ── Install ───────────────────────────────────────────────────────────
rm -rf "$HOOP_DEST"
mkdir -p "$HOOP_DEST"

ASSETS=(".claude-plugin" "skills" "hooks" "dist" "node_modules")

for a in "${ASSETS[@]}"; do
  src="$HOOP_SRC/$a"
  dst="$HOOP_DEST/$a"
  if [ "$HOOP_INSTALL_MODE" = "symlink" ]; then
    # Symlink mode: target may not exist yet (mount-later scenario) — that's OK.
    ln -sfn "$src" "$dst"
  else
    [ -e "$src" ] || { echo "install-hoop: missing source $src" >&2; exit 1; }
    cp -r "$src" "$dst"
  fi
done

# ── Register marketplace and install plugin via the claude CLI ────────
# Writing to settings.json alone isn't enough — Claude Code only honors
# enabledPlugins for plugins that have been added through its plugin
# registry.  Use the official commands so the registry state is correct.
PLUGIN_KEY="${HOOP_PLUGIN_NAME}@${HOOP_MARKETPLACE_NAME}"
if command -v claude >/dev/null 2>&1; then
  # Idempotent: removing first prevents conflicts on re-run.
  claude plugin uninstall "$PLUGIN_KEY" >/dev/null 2>&1 || true
  claude plugin marketplace remove "$HOOP_MARKETPLACE_NAME" >/dev/null 2>&1 || true
  claude plugin marketplace add "$HOOP_DEST" >/dev/null
  claude plugin install "$PLUGIN_KEY" >/dev/null
  echo "install-hoop: registered marketplace + installed $PLUGIN_KEY"
else
  echo "install-hoop: claude CLI not on PATH — skipping marketplace registration" >&2
  echo "install-hoop: run manually: claude plugin marketplace add $HOOP_DEST && claude plugin install $PLUGIN_KEY" >&2
fi

echo "install-hoop: installed hoop → $HOOP_DEST (mode: $HOOP_INSTALL_MODE)"
