#!/usr/bin/env bash
# PreToolUse hook: gate file writes behind the Hot Seat lock.
# Reads the lock-status registry (written by the MCP server's
# LockStatusWriter) to check whether the lock is held by another peer.
#
# If the lock is busy and held by someone else → deny the tool call.
# If the lock is free or held by self → allow.
#
# Only applies to Edit and Write tools.

set -euo pipefail

LOCK_FILE="${TMPDIR:-/tmp}/hoop-lock-status.json"

# Read hook input from stdin
INPUT=$(cat)

# Extract tool name from the hook input
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Edit and Write tools
case "$TOOL_NAME" in
  Edit|Write) ;;
  *) exit 0 ;;
esac

# No lock file means no active session — allow
if [ ! -f "$LOCK_FILE" ]; then
  exit 0
fi

STATUS=$(jq -r '.status // empty' "$LOCK_FILE" 2>/dev/null) || exit 0

# Lock is free — allow
if [ "$STATUS" != "busy" ]; then
  exit 0
fi

HOLDER=$(jq -r '.holderPeerId // empty' "$LOCK_FILE" 2>/dev/null) || exit 0
SELF=$(jq -r '.selfPeerId // empty' "$LOCK_FILE" 2>/dev/null) || exit 0

# Lock is held by self — allow
if [ "$HOLDER" = "$SELF" ]; then
  exit 0
fi

# Lock is held by another peer — deny
jq -n \
  --arg holder "$HOLDER" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("Hot seat lock is held by peer " + $holder + ". You must acquire the lock (hoop_acquire_lock) before writing files, or wait for it to be released.")
    }
  }'
