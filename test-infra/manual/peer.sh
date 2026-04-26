#!/usr/bin/env bash
# Boot a manual hoop peer in an interactive Claude Code REPL.
#
# Sets up everything the peer needs:
#   - throw-away workspace in /tmp with git init + empty commit + Gitea remote
#   - throw-away tmp dir for hoop registry files
#   - docker run with all required env vars and bind mounts
#   - HOOP_ADMISSION_MODE only matters on the host side; peer doesn't admit
#
# Usage:
#   bash test-infra/manual/peer.sh
#
# Inside the REPL, type:
#   /hoop:join <CODE> /ip4/127.0.0.1/tcp/<PORT>/p2p/<HOST_PEER_ID>
# using the values you got from the host's /hoop:new output.
#
# In elicit mode the host's REPL gets an Ask prompt on dial — answer it and
# this REPL prints `"admitted":true`.  In tool mode the host has to type any
# prompt + Enter to fire the user-prompt-submit hook.
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! docker ps --format '{{.Names}}' | grep -q hoop-mock-llm-1; then
  echo "[peer.sh] mock-llm not running.  Bring up the test infra first:"
  echo "  docker compose -f docker-compose.test.yml up -d --wait"
  exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -q hoop-gitea-1; then
  echo "[peer.sh] gitea not running.  Bring up the test infra first:"
  echo "  docker compose -f docker-compose.test.yml up -d --wait"
  exit 1
fi

# Reuse cached Gitea token if valid, else mint one and cache.  Avoids the
# token-rotation footgun where running peer.sh after host.sh would invalidate
# the host's token.
echo "[peer.sh] resolving Gitea fixtures…"
# shellcheck source=test-infra/manual/_gitea-env.sh
source "$(dirname "$0")/_gitea-env.sh"

REPO=$(mktemp -d /tmp/hoop-manual-peer-repo-XXXXXX)
HOOPTMP=$(mktemp -d /tmp/hoop-manual-peer-tmp-XXXXXX)
git -C "$REPO" init -q
git -C "$REPO" -c user.name=hoop-peer -c user.email=peer@hoop.test \
  commit --allow-empty -m init -q
git -C "$REPO" remote add origin "$GITEA_CLONE_URL"

# Clear any stale set-vars / preset from prior peer runs.
curl -s -X POST http://localhost:4000/scenario/peer/reset >/dev/null || true

cat <<EOF

==================== Manual Hoop Peer ====================
  workspace:        $REPO
  hoop tmp dir:     $HOOPTMP
  gitea remote:     ${GITEA_CLONE_URL%@*}@…
  scenario:         http://localhost:4000/peer
==========================================================

Inside the REPL:
  /hoop:join <CODE> /ip4/127.0.0.1/tcp/<PORT>/p2p/<HOST_PEER_ID>

Cleanup runs automatically on exit.
EOF

cleanup() {
  echo
  echo "[peer.sh] cleaning up $REPO and $HOOPTMP …"
  sudo rm -rf "$REPO" "$HOOPTMP" 2>/dev/null || rm -rf "$REPO" "$HOOPTMP" 2>/dev/null || true
}
trap cleanup EXIT

docker run --rm --network host \
  -v "$REPO":/repo \
  -v "$HOOPTMP":/hoop-tmp \
  -w /repo \
  -e HOOP_REGISTRY_DIR=/repo/.hoop \
  -e ANTHROPIC_BASE_URL=http://localhost:4000/peer \
  -e ANTHROPIC_API_KEY=test-key-not-real \
  -e GIT_AUTHOR_NAME=hoop-peer -e GIT_AUTHOR_EMAIL=peer@hoop.test \
  -e GIT_COMMITTER_NAME=hoop-peer -e GIT_COMMITTER_EMAIL=peer@hoop.test \
  -e GIT_CONFIG_COUNT=1 \
  -e GIT_CONFIG_KEY_0=safe.directory \
  -e GIT_CONFIG_VALUE_0='*' \
  -it hoop-claude-runner \
  claude --allowedTools 'mcp__plugin_hoop_hoop__*'
