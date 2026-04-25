#!/usr/bin/env bash
# PreToolUse hook: block conflicting file edits.
# Reads the active-edits registry (written by the MCP server) to check
# if a peer is currently editing the file that Claude is about to modify.
#
# For dirty-buffer conflicts: soft warning via additionalContext
# For file-change conflicts: hard block via deny
#
# Only applies to Edit and Write tools. Read is always safe.

set -euo pipefail

REGISTRY_FILE="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-active-edits.json"

# Read hook input from stdin
INPUT=$(cat)

# Extract tool name from the hook input
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Edit and Write tools
case "$TOOL_NAME" in
  Edit|Write) ;;
  *) exit 0 ;;
esac

# No registry file means no active session or no peer edits
if [ ! -f "$REGISTRY_FILE" ]; then
  exit 0
fi

# Extract the file_path from tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Look up the file in the registry
CONFLICT=$(jq -r --arg fp "$FILE_PATH" '.activeEdits[$fp] // empty' "$REGISTRY_FILE")
if [ -z "$CONFLICT" ] || [ "$CONFLICT" = "null" ]; then
  exit 0
fi

PEER_ID=$(echo "$CONFLICT" | jq -r '.peerId')
CONFLICT_TYPE=$(echo "$CONFLICT" | jq -r '.type')

if [ "$CONFLICT_TYPE" = "file-change" ]; then
  # Hard block: peer has an unsynced file change
  jq -n \
    --arg peer "$PEER_ID" \
    --arg file "$FILE_PATH" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: ("Peer " + $peer + " recently changed " + $file + ". Wait for their changes to sync before editing.")
      }
    }'
else
  # Soft warning: peer has unsaved changes (dirty buffer)
  jq -n \
    --arg peer "$PEER_ID" \
    --arg file "$FILE_PATH" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: ("Warning: Peer " + $peer + " is currently editing " + $file + ". Consider coordinating before making changes to avoid conflicts.")
      }
    }'
fi
