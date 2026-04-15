#!/usr/bin/env bash
# SessionStart hook: detect active hoop session and inject context.
#
# Reads hoop-session-status.json (written by the MCP server) and
# informs Claude of any active collaborative session.

set -euo pipefail

STATUS_FILE="${TMPDIR:-/tmp}/hoop-session-status.json"

# No status file means no active session
if [ ! -f "$STATUS_FILE" ]; then
  exit 0
fi

# Check if the MCP server process is still alive
PID=$(jq -r '.pid // empty' "$STATUS_FILE" 2>/dev/null) || exit 0
if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
  # Stale status file — MCP server is gone, clean up
  rm -f "$STATUS_FILE"
  exit 0
fi

# Build context message via jq
OUTPUT=$(jq -r '
  if .active != true then empty
  else
    (.role) as $role |
    (
      "Active hoop session: " + .sessionCode +
      ", role: " + .role +
      ", branch: " + .branchName +
      (if $role == "host" then
        (if .executionTarget then ", execution: " + .executionTarget else "" end) +
        (if .passwordProtected then ", password-protected" else "" end)
      else
        (if .hostPeerId then ", host: " + .hostPeerId else "" end)
      end)
    ) as $msg |
    {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: $msg
      }
    }
  end
' "$STATUS_FILE" 2>/dev/null) || exit 0

if [ -z "$OUTPUT" ]; then
  exit 0
fi

printf '%s\n' "$OUTPUT"
