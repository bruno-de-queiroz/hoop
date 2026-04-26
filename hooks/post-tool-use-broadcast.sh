#!/usr/bin/env bash
# PostToolUse hook: broadcast file changes after Write/Edit tool use.
#
# After Claude modifies a file via Edit/Write, this hook:
# 1. Reads the tool_input from stdin to get the file path
# 2. Computes a git diff for the changed file
# 3. Writes the update to hoop-outbound-updates.json
# 4. The MCP server's OutboundUpdatesReader picks it up and broadcasts
#
# Fire-and-forget: the network broadcast is async via the MCP server.

set -euo pipefail

SESSION_FILE="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-session-status.json"
OUTBOUND_FILE="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-outbound-updates.json"

# Read hook input from stdin
INPUT=$(cat)

# No active session → nothing to broadcast
if [ ! -f "$SESSION_FILE" ]; then
  exit 0
fi

# Verify the MCP server is still alive
PID=$(jq -r '.pid // empty' "$SESSION_FILE" 2>/dev/null) || exit 0
if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
  exit 0
fi

# Extract file path from tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Get worktree path from session status (host sessions have it)
WORKTREE=$(jq -r '.worktreePath // empty' "$SESSION_FILE" 2>/dev/null) || WORKTREE=""

# Determine git root: use worktree path if available, else discover from file
if [ -n "$WORKTREE" ]; then
  GIT_DIR="$WORKTREE"
else
  GIT_DIR=$(cd "$(dirname "$FILE_PATH")" && git rev-parse --show-toplevel 2>/dev/null) || exit 0
fi

# Make path relative to git root for git operations
REL_PATH=$(realpath --relative-to="$GIT_DIR" "$FILE_PATH" 2>/dev/null) || exit 0

# Compute diff (working tree vs index, matching computeGitDiff in TypeScript)
PATCH=$(cd "$GIT_DIR" && git diff --no-color -- "$REL_PATH" 2>/dev/null) || PATCH=""

# For untracked (new) files, diff against empty tree
if [ -z "$PATCH" ]; then
  IS_UNTRACKED=$(cd "$GIT_DIR" && git ls-files --others --exclude-standard -- "$REL_PATH" 2>/dev/null) || IS_UNTRACKED=""
  if [ -n "$IS_UNTRACKED" ]; then
    PATCH=$(cd "$GIT_DIR" && git diff --no-color --no-index -- /dev/null "$REL_PATH" 2>/dev/null; true)
  fi
fi

# No diff → file unchanged or already staged
if [ -z "$PATCH" ]; then
  exit 0
fi

# Compute hashes (MD5, matching hashContent in TypeScript).
# Pipe `git show` directly into md5sum — going through a shell variable via
# $(...) strips trailing newlines AND mangles binary bytes, producing a
# BASE_HASH that disagrees with the TypeScript receiver's hashContent over
# the same content. Every text file with a final \n hit this. Pipe-only
# preserves raw bytes end-to-end.
# For files not in the index (new/untracked), git show fails silently and
# md5sum hashes empty input → matches hashContent("") on the receiver.
BASE_HASH=$(cd "$GIT_DIR" && git show :"$REL_PATH" 2>/dev/null | md5sum | cut -d' ' -f1)
RESULT_HASH=$(md5sum < "$FILE_PATH" | cut -d' ' -f1)

TIMESTAMP=$(date +%s000)

# Append update to outbound file with file locking
LOCK_FILE="${OUTBOUND_FILE}.lock"
(
  flock -w 2 200 || exit 0

  CURRENT=$(cat "$OUTBOUND_FILE" 2>/dev/null) || CURRENT='{"updates":[],"updatedAt":0}'

  UPDATED=$(echo "$CURRENT" | jq \
    --arg fp "$REL_PATH" \
    --arg patch "$PATCH" \
    --arg bh "$BASE_HASH" \
    --arg rh "$RESULT_HASH" \
    --argjson ts "$TIMESTAMP" \
    '.updates += [{filePath: $fp, patch: $patch, baseHash: $bh, resultHash: $rh, timestamp: $ts}] | .updatedAt = $ts')

  printf '%s\n' "$UPDATED" > "$OUTBOUND_FILE"
) 200>"$LOCK_FILE"

# Output additionalContext for the first broadcast in this session
FIRST_FLAG="${HOOP_REGISTRY_DIR:-${TMPDIR:-/tmp}}/hoop-first-broadcast.flag"
if [ ! -f "$FIRST_FLAG" ]; then
  touch "$FIRST_FLAG"
  jq -n --arg file "$REL_PATH" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: ("Hoop: broadcasting " + $file + " change to peers.")
    }
  }'
fi
