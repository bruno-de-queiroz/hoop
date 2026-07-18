#!/usr/bin/env bash
# refresh-sandbox-creds.sh — keep the sandbox's bind-mounted .credentials.json
# in sync with the host's macOS Keychain after a /login (or any other event
# that rotates the host's "Claude Code-credentials" entry).
#
# Wiring: host claude's hoop plugin runs this on every Stop and
# SessionStart. Both hooks fire dozens of times a day; the Keychain dump
# costs ~10ms and the awk parse another ~10ms. Doing that on every turn
# is wasteful when the token has hours of life left.
#
# TTL-aligned design:
#   1. Read the sandbox file's .claudeAiOauth.expiresAt. If now < expiresAt -
#      SAFETY_WINDOW, the current token is still fresh enough that the host
#      claude won't have refreshed it yet — skip the Keychain dump entirely.
#   2. Only when we cross into the safety window (default 10 min before
#      expiry) do we actually read the Keychain to look for a rotation.
#   3. The --force flag bypasses (1) so SessionStart can detect a /login
#      that happened in another claude window while we weren't watching.
#   4. The reconcile itself (in creds-lib.sh) is CONTENT-based: it compares the
#      actual .claudeAiOauth token, reseeds only .claudeAiOauth (never the
#      sandbox-owned .mcpOAuth.*), and only when the host token is newer.
#
# Other invariants:
#   - silent when there's nothing to do: claude hook output is noisy enough
#   - safe when not on the sandboxed install: bail before touching anything
#   - safe inside the sandbox container: bail before reading host-only state
#
# Exits 0 on success or no-op; non-zero is reserved for "bug" not "stale".

set -u

SAFETY_WINDOW_SEC=600   # 10 min — start watching Keychain this long before expiry
FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

# 1. Bail early when this fires inside the sandbox container itself: the
#    plugin runs in both the host and sandbox claude, but only the host can
#    read its own Keychain.
if [ ! -d "$HOME/.claude/hoop/sandbox" ]; then
  exit 0  # not the sandboxed install
fi
if [ -f /.dockerenv ]; then
  exit 0  # inside the sandbox container; the launcher's job, not this hook's
fi
if [ "$(uname -s)" != "Darwin" ]; then
  # On non-macOS hosts the sandbox already bind-mounts a host file we can't
  # easily compare timestamps with through Keychain. Skip for now — the
  # launcher's start-time staleness check handles it.
  exit 0
fi

# 2. Path the sandbox bind-mounts into /home/agent/.claude/.credentials.json.
SANDBOX_CRED="$HOME/.claude/hoop/sandbox/profile/.claude/.credentials.json"

# 2a. TTL fast path. The current sandbox creds carry an expiresAt; while
#     that's comfortably in the future we know:
#       - host claude won't have refreshed yet (it refreshes near expiry)
#       - even if the user runs /login, the OLD token is still valid until
#         its expiresAt, so we don't lose access by deferring the check
#     so the Keychain dump is wasted IO. Skip unless --force.
if [ "$FORCE" -eq 0 ] && [ -f "$SANDBOX_CRED" ]; then
  # Key off .claudeAiOauth.expiresAt specifically. The file is a multi-token
  # document (claudeAiOauth + per-MCP mcpOAuth.*, each with its own expiresAt);
  # a naive first-match grep can read an MCP token's expiry and mis-decide the
  # fast path — e.g. skip a needed Keychain refresh because some MCP token
  # still has TTL while the claude token is about to expire. Prefer jq; if jq
  # is unavailable, skip the fast path and fall through to the drift check
  # rather than risk reading the wrong token.
  EXP_MS=""
  if command -v jq >/dev/null 2>&1; then
    EXP_MS=$(jq -r '.claudeAiOauth.expiresAt // empty' "$SANDBOX_CRED" 2>/dev/null)
  fi
  if [ -n "$EXP_MS" ]; then
    NOW_MS=$(( $(date +%s) * 1000 ))
    SAFETY_MS=$(( SAFETY_WINDOW_SEC * 1000 ))
    if [ "$EXP_MS" -gt "$(( NOW_MS + SAFETY_MS ))" ]; then
      exit 0  # plenty of TTL left, no need to consult Keychain
    fi
  fi
  # If we got here: claudeAiOauth.expiresAt is missing/malformed, jq is
  # unavailable, or the token is within the safety window. Fall through to the
  # Keychain check.
fi

# 3. Content-based reconcile via the shared lib. We compare the ACTUAL
#    .claudeAiOauth token in the Keychain against the one in the sandbox file
#    (not filesystem mtimes — those are fooled when the file is re-touched with
#    an older token, and they can't tell an MCP-only write apart from a claude
#    token rotation). The lib reseeds SURGICALLY (only .claudeAiOauth; the
#    sandbox-owned .mcpOAuth.* is preserved) and only when the host token is
#    strictly newer, so we never downgrade a sandbox that self-refreshed.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./creds-lib.sh
. "$SCRIPT_DIR/creds-lib.sh"

HOST_BLOB=$(hoop_creds_host_blob)
[ -n "$HOST_BLOB" ] || exit 0  # no Keychain entry / host creds — nothing to do

RESULT=$(hoop_creds_reconcile "$SANDBOX_CRED" "$HOST_BLOB")

# Single audit line on any actual reseed — answers "did the hook fire?" when a
# user reports a 401, without spamming the common no-drift (insync) path.
case "$RESULT" in
  reseeded:host-newer)
    echo "[hoop] sandbox .claudeAiOauth refreshed from host Keychain (host token newer)" >&2 ;;
  reseeded:first)
    echo "[hoop] sandbox credentials seeded from host Keychain" >&2 ;;
  reseeded:added)
    echo "[hoop] sandbox .claudeAiOauth added from host Keychain" >&2 ;;
  skip:sandbox-newer)
    # Sandbox self-refreshed more recently than the host; the host's copy is the
    # stale one. Don't downgrade. Quiet on the Stop hot path.
    : ;;
esac

exit 0
