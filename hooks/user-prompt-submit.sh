#!/usr/bin/env bash
# UserPromptSubmit hook:
#   1. Route hoop slash-commands that should bypass the model entirely
#      (e.g. /hoop:leave) directly to the MCP server via signal. The
#      harness owns these commands; the model never sees them.
#   2. For everything else, surface pending admissions / prompt requests /
#      peer file changes / captain mode patch reviews as additionalContext
#      so the model can act on them.

set -euo pipefail

source "$(dirname "$0")/_format-peer-changes.sh"

STATUS_FILE="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-session-status.json"
ADMISSIONS_FILE="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-pending-admissions.json"
UPDATES_FILE="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-pending-updates.json"
PROMPT_REQUESTS_FILE="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-pending-prompt-requests.json"
PATCH_REVIEWS_FILE="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-pending-patch-reviews.json"
MAX_PATCH_LINES=20
MAX_FILES=5

# Read the hook input JSON from stdin once. Claude Code provides it as
# {"prompt": "...", "session_id": "...", ...}. We only need .prompt for
# command routing.
HOOK_INPUT=$(cat || echo "{}")
USER_PROMPT=$(echo "$HOOK_INPUT" | jq -r '.prompt // empty' 2>/dev/null || echo "")

# ── /hoop:leave routing ─────────────────────────────────────────────
# Trim leading whitespace; tolerant match against the slash-command. If the
# user types `/hoop:leave` (with optional surrounding whitespace), we
# intercept it before the model sees anything.
TRIMMED=$(printf '%s' "$USER_PROMPT" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
if [[ "$TRIMMED" == "/hoop:leave" ]]; then
  # Output channel choice: we use {"continue": false, "stopReason": ...}
  # rather than {"decision": "block", "reason": ...} for status-style
  # messages. Both prevent the prompt from reaching the model, but
  # `continue: false` renders the stopReason as a plain notification
  # without the "UserPromptSubmit operation blocked by hook:" prefix
  # and "Original prompt: ..." suffix that `decision: block` produces.
  # The leave succeeded; this is a status update, not an error/policy
  # block.
  if [ ! -f "$STATUS_FILE" ]; then
    jq -n '{ continue: false, stopReason: "You are not currently in a Hoop session." }'
    exit 0
  fi
  LEAVE_PID=$(jq -r '.pid // empty' "$STATUS_FILE" 2>/dev/null) || LEAVE_PID=""
  if [ -z "$LEAVE_PID" ] || ! kill -0 "$LEAVE_PID" 2>/dev/null; then
    rm -f "$STATUS_FILE" "$ADMISSIONS_FILE" "$UPDATES_FILE" "$PROMPT_REQUESTS_FILE" "$PATCH_REVIEWS_FILE"
    jq -n '{ continue: false, stopReason: "You are not currently in a Hoop session (stale state cleaned up)." }'
    exit 0
  fi
  LEAVE_ROLE=$(jq -r '.role // empty' "$STATUS_FILE" 2>/dev/null) || LEAVE_ROLE="unknown"
  LEAVE_CODE=$(jq -r '.sessionCode // empty' "$STATUS_FILE" 2>/dev/null) || LEAVE_CODE=""

  # Send SIGUSR2 to MCP server: handler calls leaveSession() which tears
  # down the libp2p node + writers and clears the session-status file.
  # MCP process stays alive; user can /hoop:new again.
  kill -USR2 "$LEAVE_PID" 2>/dev/null || true

  # Wait briefly for the leave to settle. Watch for the status file to
  # disappear (clearSessionStatus inside leaveSession unlinks it).
  for _ in $(seq 1 50); do
    if [ ! -f "$STATUS_FILE" ]; then
      break
    fi
    sleep 0.1
  done

  if [ -f "$STATUS_FILE" ]; then
    jq -n --arg role "$LEAVE_ROLE" --arg code "$LEAVE_CODE" '{
      continue: false,
      stopReason: ("The leave signal was sent but the MCP server has not finished tearing down within 5s. Try `hoop_get_status` next; the teardown may still complete. (role=" + $role + ", code=" + $code + ")")
    }'
    exit 0
  fi

  CODE_SUFFIX=""
  if [ -n "$LEAVE_CODE" ]; then
    CODE_SUFFIX=" (code $LEAVE_CODE)"
  fi
  # Tailor the next-step hint to the role you just left.
  case "$LEAVE_ROLE" in
    host)
      NEXT_STEP="Type /hoop:new to host again, or /hoop:join <code> <addr> to connect to a session." ;;
    peer)
      NEXT_STEP="Type /hoop:join <code> <addr> to connect to another session, or /hoop:new to host one." ;;
    *)
      NEXT_STEP="Type /hoop:new to host or /hoop:join <code> <addr> to connect." ;;
  esac
  jq -n --arg msg "You are back to your regular Claude Code session — no longer connected to the Hoop session you just left as $LEAVE_ROLE$CODE_SUFFIX. $NEXT_STEP" '{
    continue: false,
    stopReason: $msg
  }'
  exit 0
fi
# ── end /hoop:leave routing ─────────────────────────────────────────

if [ ! -f "$STATUS_FILE" ]; then
  exit 0
fi

PID=$(jq -r '.pid // empty' "$STATUS_FILE" 2>/dev/null) || exit 0
if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$STATUS_FILE" "$ADMISSIONS_FILE" "$UPDATES_FILE" "$PROMPT_REQUESTS_FILE" "$PATCH_REVIEWS_FILE"
  exit 0
fi

ROLE=$(jq -r '.role // empty' "$STATUS_FILE" 2>/dev/null) || exit 0

ADMISSIONS_CONTEXT=""
# Default admission flow is MCP elicitation (server pushes Ask UI to client),
# so we only inject pending-admissions context here when explicitly opted into
# the tool-based fallback (used by docker E2E and headless --print runs).
if [ "$ROLE" = "host" ] && [ "${HOOP_ADMISSION_MODE:-elicit}" = "tool" ] && [ -f "$ADMISSIONS_FILE" ]; then
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

PROMPT_REQUESTS_CONTEXT=""
if [ "$ROLE" = "host" ] && [ -f "$PROMPT_REQUESTS_FILE" ]; then
  PROMPT_REQUESTS_CONTEXT=$(jq -r '
    (.requests // []) as $requests |
    ($requests | map(select(.status == "pending-approval"))) as $pending |
    if ($pending | length) == 0 then empty
    else
      ($pending | map(
        "Peer " + .requestedBy + " wants to run:\n\n  " + .prompt +
        (if .model then "\n  (model: " + .model + ")" else "" end) +
        "\n\nApprove, Reject, or chat about it.\nUse hoop_approve_prompt_request(\"" + .id + "\") or hoop_deny_prompt_request(\"" + .id + "\", reason)."
      ) | join("\n\n---\n\n"))
    end
  ' "$PROMPT_REQUESTS_FILE" 2> >(cat >&2)) || PROMPT_REQUESTS_CONTEXT=""
fi

PATCH_REVIEWS_CONTEXT=""
if [ "$ROLE" = "host" ] && [ -f "$PATCH_REVIEWS_FILE" ]; then
  PATCH_REVIEWS_CONTEXT=$(jq -r '
    (.reviews // []) as $reviews |
    ($reviews | map(select(.status == "pending-review"))) as $pending |
    if ($pending | length) == 0 then empty
    else
      ($pending | map(
        "Peer " + .peerId + " proposed changes:\n" +
        (.files | map(
          "\n  " + .filePath + ":\n" +
          (.patchPreview | split("\n") | map("    " + .) | join("\n"))
        ) | join("\n")) +
        "\n\nApprove, Reject, or chat about it.\nUse hoop_approve_patches(\"" + .peerId + "\") or hoop_reject_patches(\"" + .peerId + "\", reason)."
      ) | join("\n\n---\n\n"))
    end
  ' "$PATCH_REVIEWS_FILE" 2> >(cat >&2)) || PATCH_REVIEWS_CONTEXT=""
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

if [ -n "$PROMPT_REQUESTS_CONTEXT" ]; then
  if [ -n "$CONTEXT" ]; then
    CONTEXT+=$'\n\n'
  fi
  CONTEXT="$CONTEXT$PROMPT_REQUESTS_CONTEXT"
fi

if [ -n "$PATCH_REVIEWS_CONTEXT" ]; then
  if [ -n "$CONTEXT" ]; then
    CONTEXT+=$'\n\n'
  fi
  CONTEXT="$CONTEXT$PATCH_REVIEWS_CONTEXT"
fi

if [ -n "$UPDATES_CONTEXT" ]; then
  if [ -n "$CONTEXT" ]; then
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
