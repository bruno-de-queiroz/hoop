#!/usr/bin/env bash
# UserPromptSubmit hook: surface pending admissions and peer changes.
#
# Runs on every user message so Claude can notice:
# 1. peers waiting for admission approval, and
# 2. incoming peer file changes that arrived between tool calls.

set -euo pipefail

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

UPDATES_CONTEXT=$(jq -r --argjson maxLines "$MAX_PATCH_LINES" --argjson maxFiles "$MAX_FILES" '
  if (.updates // [] | length) == 0 then empty
  else
    [(.updates // []) | group_by(.filePath)[] | sort_by(.timestamp) | last] |
    .[:$maxFiles] |
    length as $count |
    (map(
      "Peer " + .peerId + " changed " + .filePath + ":\n```diff\n" +
      ((.patch | split("\n")) as $lines |
        if ($lines | length) > $maxLines then
          ($lines[:$maxLines] | join("\n")) + "\n... (" + ($lines | length | tostring) + " total lines, truncated)"
        else
          .patch
        end
      ) + "\n```"
    ) | join("\n\n")) as $summary |
    (($count | tostring) + " pending peer change(s):\n\n" + $summary)
  end
' "$UPDATES_FILE" 2>/dev/null) || UPDATES_CONTEXT=""

if [ -n "$UPDATES_CONTEXT" ]; then
  echo '{"updates":[],"updatedAt":'"$(date +%s000)"'}' > "$UPDATES_FILE"
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
