#!/usr/bin/env bash
# Boot a manual hoop host in an interactive Claude Code REPL.
#
# Sets up everything the host needs:
#   - throw-away workspace in /tmp with git init + empty commit + Gitea remote
#   - throw-away tmp dir for hoop registry files
#   - docker run with all required env vars and bind mounts
#   - HOOP_ADMISSION_MODE defaults to elicit (Claude Code's Ask UI prompts on
#     peer dial); export HOOP_ADMISSION_MODE=tool before invoking this script
#     to use the legacy hook+tool flow instead
#
# Usage:
#   bash test-infra/manual/host.sh
#
# Inside the REPL, type `/hoop:new` to create a session.  Note the
# sessionCode and the /ip4/127.0.0.1/... listen address — the peer needs them.
# Leave this terminal open while the peer joins.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Verify test infra is up (mock-llm + gitea)
if ! docker ps --format '{{.Names}}' | grep -q hoop-mock-llm-1; then
  echo "[host.sh] mock-llm not running.  Bring up the test infra first:"
  echo "  docker compose -f docker-compose.test.yml up -d --wait"
  exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -q hoop-gitea-1; then
  echo "[host.sh] gitea not running.  Bring up the test infra first:"
  echo "  docker compose -f docker-compose.test.yml up -d --wait"
  exit 1
fi

# Reuse cached Gitea token if valid, else mint one and cache.  Avoids the
# token-rotation footgun where two manual scripts running back-to-back would
# invalidate each other's tokens.
echo "[host.sh] resolving Gitea fixtures…"
# shellcheck source=test-infra/manual/_gitea-env.sh
source "$(dirname "$0")/_gitea-env.sh"

# Throw-away workspace + tmp dir
REPO=$(mktemp -d /tmp/hoop-manual-host-repo-XXXXXX)
HOOPTMP=$(mktemp -d /tmp/hoop-manual-host-tmp-XXXXXX)
git -C "$REPO" init -q
git -C "$REPO" -c user.name=hoop-host -c user.email=host@hoop.test \
  commit --allow-empty -m init -q
git -C "$REPO" remote add origin "$GITEA_CLONE_URL"

# Reset host scenario state so stale set-vars from a prior run don't leak in.
curl -s -X POST http://localhost:4000/scenario/host/reset >/dev/null || true

ADMISSION_MODE="${HOOP_ADMISSION_MODE:-elicit}"

cat <<EOF

==================== Manual Hoop Host ====================
  workspace:        $REPO
  hoop tmp dir:     $HOOPTMP
  gitea remote:     ${GITEA_CLONE_URL%@*}@…
  scenario:         http://localhost:4000/host
  admission mode:   $ADMISSION_MODE
==========================================================

Inside the REPL:
  /hoop:new                         → create a session, note the code + addr

In elicit mode (default), Claude Code's Ask UI surfaces the admit/deny prompt
the moment a peer dials.  In tool mode (HOOP_ADMISSION_MODE=tool), type any
prompt at the REPL when the peer is dialing — the user-prompt-submit hook
injects the pending admission and the host scenario calls hoop_admit_peer.

Cleanup runs automatically on exit.
EOF

# Trap to clean up tmpdirs.  /repo is bind-mounted, root-owned files inside
# need sudo to remove from the host.
cleanup() {
  echo
  echo "[host.sh] cleaning up $REPO and $HOOPTMP …"
  sudo rm -rf "$REPO" "$HOOPTMP" 2>/dev/null || rm -rf "$REPO" "$HOOPTMP" 2>/dev/null || true
}
trap cleanup EXIT

docker run --rm --network host \
  -v "$REPO":/repo \
  -v "$HOOPTMP":/hoop-tmp \
  -w /repo \
  -e HOOP_REGISTRY_DIR=/repo/.hoop \
  -e HOOP_ADMISSION_MODE="$ADMISSION_MODE" \
  -e ANTHROPIC_BASE_URL=http://localhost:4000/host \
  -e ANTHROPIC_API_KEY=test-key-not-real \
  -e GIT_AUTHOR_NAME=hoop-host -e GIT_AUTHOR_EMAIL=host@hoop.test \
  -e GIT_COMMITTER_NAME=hoop-host -e GIT_COMMITTER_EMAIL=host@hoop.test \
  -e GIT_CONFIG_COUNT=1 \
  -e GIT_CONFIG_KEY_0=safe.directory \
  -e GIT_CONFIG_VALUE_0='*' \
  -it hoop-claude-runner \
  claude --allowedTools 'mcp__plugin_hoop_hoop__*'
