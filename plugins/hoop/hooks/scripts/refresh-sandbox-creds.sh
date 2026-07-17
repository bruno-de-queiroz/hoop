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
#   1. Read the sandbox file's `expiresAt` (it's already in the JSON we
#      wrote on the previous reseed). If now < expiresAt - SAFETY_WINDOW,
#      the current token is still fresh enough that the host claude won't
#      have refreshed it yet — skip the Keychain dump entirely.
#   2. Only when we cross into the safety window (default 10 min before
#      expiry) do we actually read the Keychain to look for a rotation.
#   3. The --force flag bypasses (1) so SessionStart can detect a /login
#      that happened in another claude window while we weren't watching.
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
  EXP_MS=$(grep -o '"expiresAt"[[:space:]]*:[[:space:]]*[0-9]*' "$SANDBOX_CRED" \
             | head -1 \
             | grep -o '[0-9]*$')
  if [ -n "$EXP_MS" ]; then
    NOW_MS=$(( $(date +%s) * 1000 ))
    SAFETY_MS=$(( SAFETY_WINDOW_SEC * 1000 ))
    if [ "$EXP_MS" -gt "$(( NOW_MS + SAFETY_MS ))" ]; then
      exit 0  # plenty of TTL left, no need to consult Keychain
    fi
  fi
  # If we got here: expiresAt is missing, malformed, or within the safety
  # window. Fall through to the Keychain check.
fi

# 3. Pick the freshest Keychain account name for service "Claude Code-credentials".
#    Matches the launcher's selection logic exactly.
ACCT=$(security dump-keychain 2>/dev/null | awk '
  BEGIN { in_block=0; want=0; acct=""; mdat=""; best_mdat=""; best_acct="" }
  function flush() {
    if (want && acct != "" && mdat > best_mdat) { best_mdat=mdat; best_acct=acct }
  }
  /^keychain:/ { flush(); in_block=1; want=0; acct=""; mdat=""; next }
  /"svce"<blob>="Claude Code-credentials"/ { want=1 }
  /"acct"<blob>="/ {
    line=$0
    sub(/.*"acct"<blob>="/, "", line)
    sub(/".*/, "", line)
    acct=line
  }
  /"mdat"<timedate>=/ {
    line=$0
    sub(/.*"mdat"<timedate>=0x[0-9A-F]+[[:space:]]+"/, "", line)
    sub(/".*/, "", line)
    mdat=line
  }
  END { flush(); if (best_acct != "") print best_acct ":" best_mdat }
')
[ -n "$ACCT" ] || exit 0  # no Keychain entry — nothing to do

KC_ACCT="${ACCT%%:*}"
KC_MDAT="${ACCT#*:}"  # YYYYMMDDhhmmssZ\0

# 4. Drift check. Compare Keychain mdat (its last-modified) to the sandbox
#    file's mtime, both normalised to a fixed-width digit string for
#    lexicographic comparison. The Keychain reports mdat as
#    "20260518094213Z\000" — the leading 14 chars are the timestamp in UTC
#    YYYYMMDDhhmmss; everything after is the SQLite-blob terminator. A
#    naive `tr -d 'Z\\0'` would also delete every "0" digit, so explicitly
#    keep only the leading 14 digits.
KC_TS=$(printf '%s' "$KC_MDAT" | head -c 14)
if [ -f "$SANDBOX_CRED" ]; then
  FILE_TS=$(date -u -r "$SANDBOX_CRED" +%Y%m%d%H%M%S 2>/dev/null || echo "00000000000000")
else
  FILE_TS="00000000000000"
fi

# Compare lex-style — the format is fixed-width so string compare = chrono.
if [ "$KC_TS" \> "$FILE_TS" ]; then
  # 5. Drift detected → reseed. Pull the freshest blob; normalise to the
  #    wrapped form the sandbox expects; write atomically; chmod 0600.
  RAW=$(security find-generic-password -s "Claude Code-credentials" -a "$KC_ACCT" -w 2>/dev/null) || exit 0
  [ -n "$RAW" ] || exit 0

  TMP="${SANDBOX_CRED}.tmp.$$"
  printf '%s' "$RAW" | jq 'if has("claudeAiOauth") then . else {claudeAiOauth: .} end' > "$TMP" 2>/dev/null \
    || { rm -f "$TMP"; exit 0; }
  mv "$TMP" "$SANDBOX_CRED" 2>/dev/null
  chmod 0600 "$SANDBOX_CRED" 2>/dev/null
  # Single audit line. Avoids the timestamp-only "did the hook fire?" question
  # when the user reports a 401, without spamming on the common no-drift path.
  echo "[hoop] sandbox credentials refreshed from Keychain (acct=$KC_ACCT, mdat=$KC_TS)" >&2
fi

exit 0
