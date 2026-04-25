#!/usr/bin/env bash
# PreToolUse hook: inject pending peer file changes into Claude's context.
# Reads the pending-updates registry (written by the MCP server's
# PendingUpdatesWriter) and outputs a concise summary of peer file
# changes as additionalContext so the agent sees the latest state.
#
# Fires on every tool call (*). Must be fast (<100ms).

set -euo pipefail

source "$(dirname "$0")/_format-peer-changes.sh"

REGISTRY_FILE="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-pending-updates.json"

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
