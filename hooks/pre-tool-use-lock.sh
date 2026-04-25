#!/usr/bin/env bash
# PreToolUse hook: gate file writes behind the Hot Seat lock.
# Reads the lock-status registry (written by the MCP server's
# LockStatusWriter) to check whether the lock is held by another peer.
#
# FAIL-CLOSED: any parse error or unexpected state results in deny.
# This prevents writes from slipping through on corrupted/partial files.
#
# Checks performed:
#   1. Session liveness (PID still running)
#   2. Lock TTL expiry (5-minute timeout, matching HOOP_LOCK_TTL_MS)
#   3. Lock holder vs self identity
#
# Only applies to Edit, Write, and NotebookEdit tools.
# NOTE: The lock file path must match defaultLockStatusPath() in
# src/state/lockStatusWriter.ts — both derive from TMPDIR.

set -euo pipefail

LOCK_FILE="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-lock-status.json"
LOCK_TTL_SEC=300  # 5 minutes, matches HOOP_LOCK_TTL_MS in hoopLock.ts

# ── Helper: deny with reason ──────────────────────────────────────
deny() {
  local reason="$1"
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# ── Read and validate hook input ──────────────────────────────────
INPUT=$(cat) || deny "Failed to read hook input."

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || deny "Failed to parse hook input."

# Only check Edit and Write tools
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac

# No lock file means no active session — allow
if [ ! -f "$LOCK_FILE" ]; then
  exit 0
fi

# ── Parse lock file (fail-closed on any error) ───────────────────
LOCK_JSON=$(cat "$LOCK_FILE" 2>/dev/null) || deny "Failed to read lock status file."

STATUS=$(echo "$LOCK_JSON" | jq -r '.status // empty' 2>/dev/null) || deny "Failed to parse lock status file."
HOLDER=$(echo "$LOCK_JSON" | jq -r '.holderPeerId // empty' 2>/dev/null) || deny "Failed to parse lock status file."
SELF=$(echo "$LOCK_JSON" | jq -r '.selfPeerId // empty' 2>/dev/null) || deny "Failed to parse lock status file."
SESSION_PID=$(echo "$LOCK_JSON" | jq -r '.sessionPid // empty' 2>/dev/null) || deny "Failed to parse lock status file."
ACQUIRED_AT=$(echo "$LOCK_JSON" | jq -r '.acquiredAt // empty' 2>/dev/null) || deny "Failed to parse lock status file."

# ── Validate required fields ─────────────────────────────────────
if [ -z "$STATUS" ] || [ -z "$SELF" ]; then
  deny "Lock status file has missing required fields (status or selfPeerId)."
fi

# ── Session liveness check ────────────────────────────────────────
# If the MCP server process is dead, the lock file is stale — allow writes
if [ -n "$SESSION_PID" ] && ! kill -0 "$SESSION_PID" 2>/dev/null; then
  # Stale file from a dead process — clean it up and allow
  rm -f "$LOCK_FILE" 2>/dev/null || true
  exit 0
fi

# ── Lock is free — allow ─────────────────────────────────────────
if [ "$STATUS" != "busy" ]; then
  exit 0
fi

# ── Lock TTL expiry check ────────────────────────────────────────
# If the lock was acquired more than LOCK_TTL_SEC ago, treat it as expired
if [ -n "$ACQUIRED_AT" ] && [ "$ACQUIRED_AT" != "null" ]; then
  NOW_MS=$(($(date +%s) * 1000))
  ELAPSED_MS=$((NOW_MS - ACQUIRED_AT))
  if [ "$ELAPSED_MS" -ge $((LOCK_TTL_SEC * 1000)) ]; then
    # Lock expired — allow the write through
    exit 0
  fi
fi

# ── Lock holder identity check ───────────────────────────────────
# Require both holder and self to be non-empty for a valid comparison
if [ -z "$HOLDER" ] || [ "$HOLDER" = "null" ]; then
  deny "Lock is busy but holder identity is missing. Cannot verify ownership."
fi

# Lock is held by self — allow
if [ "$HOLDER" = "$SELF" ]; then
  exit 0
fi

# Lock is held by another peer — deny
deny "Hot seat lock is held by peer ${HOLDER}. You must acquire the lock (hoop_acquire_lock) before writing files, or wait for it to be released."
