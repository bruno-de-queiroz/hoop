#!/usr/bin/env bash
# SessionEnd hook: trigger graceful P2P shutdown.
#
# Signals the MCP server to perform graceful cleanup (stop ack
# intervals, close broadcast streams, stop P2P node) before
# Claude Code exits.

set -euo pipefail

STATUS_FILE="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-session-status.json"

# No status file means no active session — nothing to clean up
if [ ! -f "$STATUS_FILE" ]; then
  exit 0
fi

# Read the MCP server PID
PID=$(jq -r '.pid // empty' "$STATUS_FILE" 2>/dev/null) || exit 0

if [ -z "$PID" ]; then
  exit 0
fi

# Signal MCP server for graceful shutdown (SIGUSR1 triggers cleanup)
if kill -0 "$PID" 2>/dev/null; then
  kill -USR1 "$PID" 2>/dev/null || true
  # Brief wait for graceful cleanup to complete
  for i in 1 2 3 4 5; do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
fi

# Belt-and-suspenders: clean up volatile registry files.  We intentionally
# do NOT remove $STATUS_FILE here — leaving it lets the next claude session
# detect a zombie and offer to recover.  hoop_leave_session is the only
# code path that clears the status file.
rm -f "${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-active-edits.json"
rm -f "${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-pending-admissions.json"
rm -f "${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-pending-updates.json"
rm -f "${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-outbound-updates.json"
rm -f "${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-outbound-updates.json.lock"
rm -f "${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-lock-status.json"
rm -f "${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-lock-status.json.tmp"
rm -f "${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-first-broadcast.flag"

# Residual proof that this hook executed — readable by tests and by a
# follow-up SessionStart that wants to confirm clean teardown.
touch "${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/.hoop-session-end.marker" 2>/dev/null || true

exit 0
