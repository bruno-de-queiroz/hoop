#!/usr/bin/env bash
# Source this file from any manual-flow script to populate $GITEA_TOKEN /
# $GITEA_CLONE_URL etc.  Caches the result in /tmp/hoop-gitea.env so multiple
# `setup-gitea.sh` calls don't keep deleting each other's tokens (the script
# rotates ci-token on every run).
#
# To force a fresh mint:  rm /tmp/hoop-gitea.env
set -euo pipefail

CACHE_FILE="${HOOP_GITEA_ENV_FILE:-/tmp/hoop-gitea.env}"

verify_cached() {
  local cache="$1"
  [ -f "$cache" ] || return 1
  # shellcheck source=/dev/null
  source "$cache"
  [ -n "${GITEA_CLONE_URL:-}" ] || return 1
  [ -n "${GITEA_TOKEN:-}" ]     || return 1
  # Auth-probe via Gitea API: ls-remote isn't useful because the test repo is
  # public (no auth needed for reads).  /api/v1/user requires a valid token
  # and returns 401 otherwise.
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: token $GITEA_TOKEN" \
    "${GITEA_URL:-http://localhost:3000}/api/v1/user")
  [ "$code" = "200" ]
}

if verify_cached "$CACHE_FILE"; then
  # shellcheck source=/dev/null
  source "$CACHE_FILE"
else
  # Mint fresh, then cache.  Use BASH_SOURCE so paths resolve correctly when
  # this file is sourced (not executed) from another script.
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "$HERE/../.." && pwd)"
  ENV_TEXT=$(bash "$REPO_ROOT/scripts/setup-gitea.sh")
  echo "$ENV_TEXT" > "$CACHE_FILE"
  # shellcheck source=/dev/null
  source "$CACHE_FILE"
fi
