#!/usr/bin/env bash
# PreToolUse hook: inject pending peer file changes into Claude's context.
# Reads the pending-updates registry (written by the MCP server's
# PendingUpdatesWriter) and outputs a concise summary of peer file
# changes as additionalContext so the agent sees the latest state.
#
# Fires on every tool call (*). Must be fast (<100ms).

set -euo pipefail

REGISTRY_FILE="${TMPDIR:-/tmp}/hoop-pending-updates.json"

# No registry file means no active session or no peer changes
if [ ! -f "$REGISTRY_FILE" ]; then
  exit 0
fi

# Single jq pass: check for updates, format output, or produce nothing.
# Using jq `empty` to produce no output when there are zero updates.
MAX_PATCH_LINES=20
MAX_FILES=5

OUTPUT=$(jq -r --argjson maxLines "$MAX_PATCH_LINES" --argjson maxFiles "$MAX_FILES" '
  if (.updates | length) == 0 then empty
  else
    # Group by filePath, keep only the most recent per file
    [.updates | group_by(.filePath)[] | sort_by(.timestamp) | last] |
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
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: (($count | tostring) + " pending peer change(s):\n\n" + $summary)
      }
    }
  end
' "$REGISTRY_FILE" 2>/dev/null) || exit 0

if [ -z "$OUTPUT" ]; then
  exit 0
fi

# Drain the file after successful read
echo '{"updates":[],"updatedAt":'"$(date +%s000)"'}' > "$REGISTRY_FILE"

printf '%s\n' "$OUTPUT"
