#!/usr/bin/env bash
# PreToolUse hook: inject pending peer file changes into Claude's context.
# Reads the pending-updates registry (written by the MCP server's
# PendingUpdatesWriter) and outputs a concise summary of peer file
# changes as additionalContext so the agent sees the latest state.
#
# Fires on every tool call (*). Must be fast (<100ms).

set -euo pipefail

source "$(dirname "$0")/_format-peer-changes.sh"

# Resolve PID-suffixed path from STATUS_FILE (matches the MCP writer's
# default <base>-<PID>.json convention). Falls back to the unsuffixed
# variant for fixture-driven tests.
REG_DIR="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}"
STATUS_FILE="$REG_DIR/hoop-session-status.json"
MCP_PID=""
if [ -f "$STATUS_FILE" ]; then
  MCP_PID=$(jq -r '.pid // empty' "$STATUS_FILE" 2>/dev/null) || MCP_PID=""
fi
if [ -n "$MCP_PID" ]; then
  # PID known → always use the suffixed path so a stale unsuffixed file from
  # a prior session can never be misread as the current session's state.
  REGISTRY_FILE="$REG_DIR/hoop-pending-updates-${MCP_PID}.json"
else
  # No STATUS_FILE → fixture-driven test setup writes to the unsuffixed name.
  REGISTRY_FILE="$REG_DIR/hoop-pending-updates.json"
fi

# No registry file means no active session or no peer changes
if [ ! -f "$REGISTRY_FILE" ]; then
  exit 0
fi

MAX_PATCH_LINES=20
MAX_FILES=5

PEER_CHANGES_CONTEXT=$(format_peer_changes_context "$REGISTRY_FILE" "$MAX_PATCH_LINES" "$MAX_FILES")
if [ -z "$PEER_CHANGES_CONTEXT" ]; then
  exit 0
fi

OUTPUT=$(jq -n --arg context "$PEER_CHANGES_CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $context
  }
}')

if [ -z "$OUTPUT" ]; then
  exit 0
fi

# Note: user-prompt-submit.sh also drains this file. Both hooks are valid
# consumers — one surfaces changes on user messages, the other on tool calls.
drain_peer_changes_registry "$REGISTRY_FILE"

printf '%s\n' "$OUTPUT"
