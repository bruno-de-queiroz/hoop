#!/usr/bin/env bash
# UserPromptSubmit hook: surface pending admissions and peer changes.
#
# Runs on every user message so Claude can notice:
# 1. peers waiting for admission approval, and
# 2. incoming peer file changes that arrived between tool calls.

set -euo pipefail

source "$(dirname "$0")/_format-peer-changes.sh"

STATUS_FILE="${TMPDIR:-/tmp}/hoop-session-status.json"
ADMISSIONS_FILE="${TMPDIR:-/tmp}/hoop-pending-admissions.json"
UPDATES_FILE="${TMPDIR:-/tmp}/hoop-pending-updates.json"
MAX_PATCH_LINES=20
MAX_FILES=5

if [ ! -f "$STATUS_FILE" ]; then
  exit 0
fi

PID=$(jq -r '.pid // empty' "$STATUS_FILE" 2>/dev/null) || exit 0
if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$STATUS_FILE" "$ADMISSIONS_FILE" "$UPDATES_FILE"
  exit 0
fi

ROLE=$(jq -r '.role // empty' "$STATUS_FILE" 2>/dev/null) || exit 0

ADMISSIONS_CONTEXT=""
if [ "$ROLE" = "host" ] && [ -f "$ADMISSIONS_FILE" ]; then
  ADMISSIONS_CONTEXT=$(jq -r '
    (.requests // []) as $requests |
    if ($requests | length) == 0 then empty
    else
      (
        if ($requests | length) == 1 then
          "Pending admission request:\n"
        else
          "Pending admission requests:\n"
        end
      ) + (
        $requests | map(
          "- Peer " + (.email // .peerId) + " wants to join (peerId: " + .peerId + "). Ask whether to admit or deny, then use hoop_admit_peer or hoop_deny_peer."
        ) | join("\n")
      )
    end
  ' "$ADMISSIONS_FILE" 2>/dev/null) || ADMISSIONS_CONTEXT=""
fi

UPDATES_CONTEXT=$(format_peer_changes_context "$UPDATES_FILE" "$MAX_PATCH_LINES" "$MAX_FILES")

if [ -n "$UPDATES_CONTEXT" ]; then
  # Note: pre-tool-use-inject.sh also drains this file. Both hooks are valid
  # consumers — one surfaces changes on user messages, the other on tool calls.
  drain_peer_changes_registry "$UPDATES_FILE"
fi

CONTEXT=""
if [ -n "$ADMISSIONS_CONTEXT" ]; then
  CONTEXT="$ADMISSIONS_CONTEXT"
fi

if [ -n "$UPDATES_CONTEXT" ]; then
  if [ -n "$CONTEXT" ]; then
    CONTEXT="$CONTEXT"
    CONTEXT+=$'\n\n'
  fi
  CONTEXT="$CONTEXT$UPDATES_CONTEXT"
fi

if [ -z "$CONTEXT" ]; then
  exit 0
fi

jq -n --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $context
  }
}'
