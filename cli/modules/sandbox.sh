#!/bin/bash
#@module Sandbox - manage the agent-sandbox container lifecycle

#import oo.sh
. ${MODULES_DIR}/../oo.sh

# Repo root = <repo>/cli/modules/../.. — the CLI is vendored under <repo>/cli.
HOOP_REPO_ROOT="$(cd "${MODULES_DIR}/../.." && pwd)"
HOOP_COMPOSE_FILE="${HOOP_REPO_ROOT}/plugins/hoop/dashboard/docker-compose.yml"
# The compose file defines two services; sandbox commands target this one only.
HOOP_SANDBOX_SERVICE="agent-sandbox"
# Mirror what bin/hoop-dashboard forwards so the compose bind mount for the
# read-only plugin tree resolves to the same path.
export HOOP_PLUGIN_ROOT="${HOOP_REPO_ROOT}/plugins/hoop"
# Host-side Claude profile the container bind-mounts at /home/agent.
HOOP_SANDBOX_PROFILE="${HOME}/.claude/hoop/sandbox/profile"

#@protected ~ preflight: docker present, compose file exists, profile dir ready
function _preflight() {
  _requires docker
  [[ -f "$HOOP_COMPOSE_FILE" ]] || _die "compose file not found: ${HOOP_COMPOSE_FILE}"
  # docker would create a missing bind source as root; make it up front so the
  # container's entrypoint can chown/seed it under the invoking user instead.
  mkdir -p "${HOOP_SANDBOX_PROFILE}/.claude"
}

#@protected ~ run docker compose scoped to this repo's compose file
function _compose() {
  docker compose -f "$HOOP_COMPOSE_FILE" "$@"
}

#@public ~ start the agent-sandbox container
function start() {
  _preflight
  _compose up -d "$HOOP_SANDBOX_SERVICE"
}

#@public ~ stop the agent-sandbox container
function stop() {
  _requires docker
  _compose stop "$HOOP_SANDBOX_SERVICE"
}

#@public ~ restart the agent-sandbox container
function restart() {
  _preflight
  _compose stop "$HOOP_SANDBOX_SERVICE"
  _compose up -d "$HOOP_SANDBOX_SERVICE"
}

#@public ~ rebuild the sandbox image and recreate the container
#@flag -n|--no-cache SANDBOX_NO_CACHE "false" boolean ~ build without the layer cache
function rebuild() {
  _preflight
  if [[ "$SANDBOX_NO_CACHE" == true ]]; then
    _compose build --no-cache "$HOOP_SANDBOX_SERVICE"
  else
    _compose build "$HOOP_SANDBOX_SERVICE"
  fi
  _compose up -d --force-recreate "$HOOP_SANDBOX_SERVICE"
}

#@public ~ pin the claude-code CLI baked into the sandbox image to a version and rebuild just that layer forward
#@flag -c|--claude-version SANDBOX_CLAUDE_VERSION "" ~ version to pin (default: resolve latest from npm)
function update() {
  _preflight
  _requires npm
  local version="$SANDBOX_CLAUDE_VERSION"
  if [[ -z "$version" ]]; then
    version="$(npm view @anthropic-ai/claude-code version 2>/dev/null)"
    [[ -n "$version" ]] || _die "could not resolve latest @anthropic-ai/claude-code version from npm"
  fi
  _info "pinning claude-code ${version} into the sandbox image"
  _compose build --build-arg "CLAUDE_CODE_VERSION=${version}" "$HOOP_SANDBOX_SERVICE"
  _compose up -d --force-recreate "$HOOP_SANDBOX_SERVICE"
}

# Bootstraps the parser
main $0 "$@"
