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

# Signal MCP server for graceful shutdown (SIGUSR1 triggers cleanup).
# Wait up to ~10 seconds for the process to actually exit. Removing the
# registry files while the server is still writing to them would drop
# in-flight peer acks / outbound updates / lock changes on the floor —
# the writer's atomic-rename pattern protects integrity, not ordering.
if kill -0 "$PID" 2>/dev/null; then
  kill -USR1 "$PID" 2>/dev/null || true
  for i in $(seq 1 50); do
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
#
# Default registry paths now suffix with the MCP server PID (matching the
# writer side's defaultXxxPath() helpers). Remove both the PID-suffixed
# variant (current default) and the un-suffixed variant (legacy / explicit
# HOOP_REGISTRY_DIR + fixed name configurations).
REG_DIR="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}"
for base in hoop-active-edits hoop-pending-admissions hoop-pending-updates hoop-pending-prompt-requests; do
  rm -f "$REG_DIR/${base}.json" "$REG_DIR/${base}-${PID}.json"
  rm -f "$REG_DIR/${base}.json.tmp" "$REG_DIR/${base}-${PID}.json.tmp"
done
rm -f "$REG_DIR/hoop-outbound-updates.json"
rm -f "$REG_DIR/hoop-outbound-updates.json.lock"
rm -f "$REG_DIR/hoop-lock-status.json"
rm -f "$REG_DIR/hoop-lock-status.json.tmp"
rm -f "$REG_DIR/hoop-first-broadcast.flag"

# Residual proof that this hook executed — readable by tests and by a
# follow-up SessionStart that wants to confirm clean teardown.
touch "${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/.hoop-session-end.marker" 2>/dev/null || true

exit 0
