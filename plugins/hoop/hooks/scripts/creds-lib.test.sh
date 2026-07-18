#!/usr/bin/env bash
# creds-lib.test.sh — unit tests for the pure reconcile core in creds-lib.sh.
#
# The host blob is injected (no Keychain access), so these run anywhere with
# bash + jq. Exercised in CI via the vitest wrapper in the sandbox package
# (see sandbox/lib/creds-lib.test.ts), and runnable directly:
#
#   bash plugins/hoop/hooks/scripts/creds-lib.test.sh
#
# Exit 0 = all pass, non-zero = at least one failure.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./creds-lib.sh
. "$SCRIPT_DIR/creds-lib.sh"

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not available"; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
ok()   { PASS=$((PASS + 1)); }

assert_eq() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok; else fail "$1: expected [$2] got [$3]"; fi
}

# jq field read from a file
jf() { jq -r "$2" "$1" 2>/dev/null; }

# ---- fixtures -------------------------------------------------------------
# Host blob carries a claude token AND a host-side mcp token; the sandbox file
# carries a DIFFERENT claude token and its OWN mcp token. The whole point is
# that a reseed must never let host mcp state leak over sandbox mcp state.
host_blob() { # <accessToken> <expiresAt>
  jq -cn --arg t "$1" --argjson e "$2" \
    '{claudeAiOauth:{accessToken:$t,refreshToken:"host-refresh",expiresAt:$e},
      mcpOAuth:{"host-mcp":{accessToken:"host-mcp-tok",expiresAt:1}}}'
}
sandbox_file() { # <path> <accessToken> <expiresAt>
  jq -cn --arg t "$2" --argjson e "$3" \
    '{claudeAiOauth:{accessToken:$t,refreshToken:"sbx-refresh",expiresAt:$e},
      mcpOAuth:{"sandbox-mcp":{accessToken:"sbx-mcp-tok",expiresAt:1}}}' > "$1"
}
no_leftover_tmp() { # <file> -> asserts no .tmp.* sibling remains
  local d b; d="$(dirname "$1")"; b="$(basename "$1")"
  if ls "$d/$b".tmp.* >/dev/null 2>&1; then fail "leftover tmp file for $1"; else ok; fi
}

echo "creds-lib reconcile tests"

# 1. Empty host blob -> no-host, no write.
F="$WORK/c1.json"; sandbox_file "$F" "sbx-token" 1000
assert_eq "1 verb"  "no-host" "$(hoop_creds_reconcile "$F" "")"
assert_eq "1 kept"  "sbx-token" "$(jf "$F" '.claudeAiOauth.accessToken')"

# 2. Missing file -> reseeded:first, whole host blob written (incl host mcp).
F="$WORK/c2.json"
assert_eq "2 verb" "reseeded:first" "$(hoop_creds_reconcile "$F" "$(host_blob host-token 2000)")"
assert_eq "2 tok"  "host-token" "$(jf "$F" '.claudeAiOauth.accessToken')"
assert_eq "2 mcp"  "host-mcp-tok" "$(jf "$F" '.mcpOAuth."host-mcp".accessToken')"
no_leftover_tmp "$F"

# 3. Corrupt file -> reseeded:first.
F="$WORK/c3.json"; printf 'not json{' > "$F"
assert_eq "3 verb" "reseeded:first" "$(hoop_creds_reconcile "$F" "$(host_blob host-token 2000)")"
assert_eq "3 tok"  "host-token" "$(jf "$F" '.claudeAiOauth.accessToken')"

# 4. Same token -> insync, untouched.
F="$WORK/c4.json"; sandbox_file "$F" "same-token" 1000
assert_eq "4 verb" "insync" "$(hoop_creds_reconcile "$F" "$(host_blob same-token 9999)")"
assert_eq "4 tok"  "same-token" "$(jf "$F" '.claudeAiOauth.accessToken')"
assert_eq "4 exp"  "1000" "$(jf "$F" '.claudeAiOauth.expiresAt')"   # not overwritten

# 5. Different token, host NEWER -> surgical splice; sandbox mcp PRESERVED,
#    host mcp NOT imported.
F="$WORK/c5.json"; sandbox_file "$F" "sbx-token" 1000
assert_eq "5 verb" "reseeded:host-newer" "$(hoop_creds_reconcile "$F" "$(host_blob host-token 2000)")"
assert_eq "5 tok"  "host-token" "$(jf "$F" '.claudeAiOauth.accessToken')"
assert_eq "5 exp"  "2000" "$(jf "$F" '.claudeAiOauth.expiresAt')"
assert_eq "5 keepmcp" "sbx-mcp-tok" "$(jf "$F" '.mcpOAuth."sandbox-mcp".accessToken')"
assert_eq "5 nohostmcp" "null" "$(jf "$F" '.mcpOAuth."host-mcp"')"
no_leftover_tmp "$F"

# 6. Different token, sandbox NEWER -> skip, untouched.
F="$WORK/c6.json"; sandbox_file "$F" "sbx-token" 3000
assert_eq "6 verb" "skip:sandbox-newer" "$(hoop_creds_reconcile "$F" "$(host_blob host-token 2000)")"
assert_eq "6 tok"  "sbx-token" "$(jf "$F" '.claudeAiOauth.accessToken')"

# 7. Different token, EQUAL expiry -> not strictly newer -> skip.
F="$WORK/c7.json"; sandbox_file "$F" "sbx-token" 2000
assert_eq "7 verb" "skip:sandbox-newer" "$(hoop_creds_reconcile "$F" "$(host_blob host-token 2000)")"
assert_eq "7 tok"  "sbx-token" "$(jf "$F" '.claudeAiOauth.accessToken')"

# 8. Valid file with mcpOAuth but NO claudeAiOauth -> reseeded:added, mcp kept.
F="$WORK/c8.json"; jq -cn '{mcpOAuth:{"sandbox-mcp":{accessToken:"sbx-mcp-tok",expiresAt:1}}}' > "$F"
assert_eq "8 verb" "reseeded:added" "$(hoop_creds_reconcile "$F" "$(host_blob host-token 2000)")"
assert_eq "8 tok"  "host-token" "$(jf "$F" '.claudeAiOauth.accessToken')"
assert_eq "8 keepmcp" "sbx-mcp-tok" "$(jf "$F" '.mcpOAuth."sandbox-mcp".accessToken')"

# 9. Host blob present but has no usable accessToken -> no-host, untouched.
F="$WORK/c9.json"; sandbox_file "$F" "sbx-token" 1000
assert_eq "9 verb" "no-host" "$(hoop_creds_reconcile "$F" '{"claudeAiOauth":{"expiresAt":9999}}')"
assert_eq "9 tok"  "sbx-token" "$(jf "$F" '.claudeAiOauth.accessToken')"

echo "----"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
