#!/bin/bash
#@module Open - launch an interactive, telemetry-isolated claude sandbox over $PWD

#import oo.sh
. ${MODULES_DIR}/../oo.sh

# Mount the current working directory read-write into the sandbox and drop the
# user into claude code. Uses the same image the dashboard's agent-sandbox runs
# (built by `hoop sandbox rebuild`).
#
#   $PWD        -> /home/agent/workspace   (rw, the code you're editing)
#   <profile>   -> /home/agent             (claude config, credentials, setup MCPs + skills)
#
# Differences from the dashboard's agent-sandbox, by design:
#   - Telemetry is fully isolated (HOOP_DISABLE_TELEMETRY=1) unless --telemetry.
#   - The dashboard-only hooks (permission-gate/emit-event) and the hoop plugin
#     are stripped from a throwaway settings.json overlay: they need the sandbox
#     HTTP socket that doesn't exist here, and claude code's own hooks/permission
#     prompts cover an interactive session. Setup MCPs, skills, other plugins,
#     and credentials from the mounted profile are kept.
#
# docker run is interactive (-it) so claude code's TUI gets a real tty.

#@flag -i|--image OPEN_IMAGE "hoop-sandbox" ~ sandbox image to run
# Default resolved in _launch — oosh only expands a bare "${VAR}" default, not a
# "${VAR}/subpath", so $HOME is expanded here instead of in the annotation.
#@flag -p|--profile OPEN_PROFILE "" dir ~ claude profile to mount (default: ~/.claude/hoop/sandbox/profile)
#@flag -y|--yolo OPEN_YOLO "false" boolean ~ pass --dangerously-skip-permissions to claude
#@flag -T|--telemetry OPEN_TELEMETRY "false" boolean ~ allow bundled-tool telemetry (default: fully isolated)
#@flag -b|--playwright-bridge OPEN_PLAYWRIGHT_BRIDGE "true" boolean ~ auto-start a host-side Playwright server so the sandbox can drive a real browser
#@flag -P|--playwright-port OPEN_PLAYWRIGHT_PORT "3355" number ~ port for the Playwright browser-automation bridge

# The sandbox has no root/apt access to install the system libs a real
# browser needs, so headed/headless Chromium runs on the host instead:
# `playwright run-server` exposes it over ws://, and playwright-core inside
# the sandbox connects to it via host.docker.internal. Idempotent — if
# something is already listening on the port (e.g. a previous `open`, or one
# started by hand), it's reused rather than starting a second server.
OPEN_PLAYWRIGHT_LOG="${HOME}/.claude/hoop/playwright-server.log"

function _port_listening() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || return 1
  exec 3<&- 3>&-
}

# 32 hex chars of randomness for the run-server endpoint path. openssl ships on
# macOS and the sandbox hosts we target; fall back to /dev/urandom otherwise.
function _rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Prints the ws:// endpoint the sandbox should connect to, read from the
# server's log line and rewritten to reach the host from inside the container
# (host.docker.internal). The URL carries the secret path (see
# _ensure_playwright_bridge) which is the de-facto bearer token, so we NEVER
# synthesise a tokenless fallback: if the log can't be read, fail closed and let
# the caller disable the bridge for this run.
function _playwright_ws_endpoint() {
  local ws
  ws="$(grep -oE 'ws://[^[:space:]]+' "$OPEN_PLAYWRIGHT_LOG" 2>/dev/null | tail -1)"
  if [[ -z "$ws" ]]; then
    _error "could not read the playwright ws endpoint from ${OPEN_PLAYWRIGHT_LOG} — browser bridge disabled for this run"
    return 1
  fi
  ws="${ws/0.0.0.0/host.docker.internal}"
  echo "${ws/127.0.0.1/host.docker.internal}"
}

function _ensure_playwright_bridge() {
  if _port_listening "$OPEN_PLAYWRIGHT_PORT"; then
    _info "playwright bridge already running on :${OPEN_PLAYWRIGHT_PORT}"
    return 0
  fi

  if ! command -v npx >/dev/null 2>&1; then
    _error "npx not found on host — skipping playwright browser bridge (browser automation from inside the sandbox won't work)"
    return 0
  fi

  _info "installing chromium for playwright (no-op if already cached)..."
  npx --yes playwright install chromium >/dev/null 2>&1 \
    || _error "chromium install failed — browser bridge may not work, see 'npx playwright install chromium'"

  mkdir -p "$(dirname "$OPEN_PLAYWRIGHT_LOG")"
  # Bind 0.0.0.0, NOT 127.0.0.1: the sandbox container reaches the host over the
  # docker bridge (host.docker.internal → host-gateway, see docker-compose.yml),
  # which arrives on a non-loopback host interface — a loopback-only bind would
  # refuse it and the bridge would be unreachable. 0.0.0.0 also exposes the port
  # on the LAN, so gate access with a random secret endpoint path: run-server's
  # default path is "/" (tokenless), which would let anyone who can reach the
  # port drive a real browser in the host's user context.
  local ws_path="/$(_rand_hex)"
  _info "starting playwright bridge on :${OPEN_PLAYWRIGHT_PORT}..."
  nohup npx --yes playwright run-server --port "$OPEN_PLAYWRIGHT_PORT" --host 0.0.0.0 --path "$ws_path" \
    >"$OPEN_PLAYWRIGHT_LOG" 2>&1 &
  disown

  local waited=0
  until _port_listening "$OPEN_PLAYWRIGHT_PORT" || (( waited >= 20 )); do
    sleep 0.25; ((waited++))
  done
  _port_listening "$OPEN_PLAYWRIGHT_PORT" \
    || _error "playwright bridge did not come up in time — see ${OPEN_PLAYWRIGHT_LOG}"
}

#@protected ~ default entrypoint: run claude in an isolated sandbox over $PWD
function _launch() {
  _requires docker

  # Resolve the profile default here so $HOME expands to a real absolute path
  # (docker rejects a bind source containing literal "${HOME}").
  : "${OPEN_PROFILE:=${HOME}/.claude/hoop/sandbox/profile}"

  docker image inspect "$OPEN_IMAGE" >/dev/null 2>&1 \
    || _die "image '${OPEN_IMAGE}' not found — build it first: hoop sandbox rebuild"

  # Bind source must exist or docker creates it as root. The container
  # entrypoint chowns/seeds it under the agent user.
  mkdir -p "${OPEN_PROFILE}/.claude"
  if [[ ! -s "${OPEN_PROFILE}/.claude/.credentials.json" ]]; then
    _error "no claude credentials in ${OPEN_PROFILE} — claude may prompt for login."
    _error "run 'hoop dashboard start' once to seed them from your host, or 'claude login' inside the sandbox."
  fi

  local workspace="/home/agent/workspace"

  # Telemetry isolation is the point of `open` — on by default. The entrypoint
  # honours HOOP_DISABLE_TELEMETRY=1: exports every documented tool opt-out and
  # blackholes discovered OTEL endpoints + a curated intake denylist in /etc/hosts.
  local iso_env=(-e "HOOP_DISABLE_TELEMETRY=1")
  [[ "$OPEN_TELEMETRY" == true ]] && iso_env=()

  local playwright_env=()
  if [[ "$OPEN_PLAYWRIGHT_BRIDGE" == true ]]; then
    _ensure_playwright_bridge
    local ws_ep
    if ws_ep="$(_playwright_ws_endpoint)"; then
      playwright_env=(-e "HOOP_PLAYWRIGHT_WS=${ws_ep}")
    fi
  fi

  # Strip the dashboard-only hooks + the hoop plugin from a throwaway copy of the
  # profile's settings.json, then overlay it read-only over just that one file.
  # Keeps credentials, setup MCPs (in .claude.json), skills, and other plugins;
  # drops emit-event/permission-gate (need a socket absent here) and hoop@workspace.
  local settings_overlay=() tmp_settings=""
  local prof_settings="${OPEN_PROFILE}/.claude/settings.json"
  if [[ -f "$prof_settings" ]]; then
    if command -v jq >/dev/null 2>&1; then
      tmp_settings="$(mktemp -t hoop-open-settings.XXXXXX)"
      if jq 'del(.hooks)
             | if (.enabledPlugins | type) == "object" then .enabledPlugins |= del(.["hoop@workspace"]) else . end' \
             "$prof_settings" > "$tmp_settings" 2>/dev/null; then
        # 0644 so the in-container agent (uid 1100) can read it on a Linux bind mount.
        chmod 0644 "$tmp_settings"
        settings_overlay=(-v "${tmp_settings}:/home/agent/.claude/settings.json:ro")
      else
        rm -f "$tmp_settings"; tmp_settings=""
        _error "could not rewrite settings.json — dashboard hooks may error inside the sandbox."
      fi
    else
      _error "jq not found on host — cannot strip dashboard hooks; they will error inside the sandbox."
    fi
  fi

  # --yolo -> claude's --dangerously-skip-permissions.
  local claude_flags=()
  [[ "$OPEN_YOLO" == true ]] && claude_flags=(--dangerously-skip-permissions)

  # -it: interactive tty for claude code's TUI.
  # --rm: ephemeral; state that matters lives in the mounted profile + $PWD.
  # Overrides the image CMD (the sandbox server) with claude + any passthrough
  # args (a prompt, --model, etc.). Not exec'd so we can clean up the overlay.
  docker run --rm -it \
    ${iso_env[@]+"${iso_env[@]}"} \
    ${playwright_env[@]+"${playwright_env[@]}"} \
    ${settings_overlay[@]+"${settings_overlay[@]}"} \
    -v "${PWD}:${workspace}" \
    -v "${OPEN_PROFILE}:/home/agent" \
    -w "$workspace" \
    "$OPEN_IMAGE" claude ${claude_flags[@]+"${claude_flags[@]}"} "$@"
  local rc=$?

  [[ -n "$tmp_settings" ]] && rm -f "$tmp_settings"
  exit $rc
}

# Forward everything that isn't a built-in straight to claude, so `hoop open`,
# `hoop open --model opus`, and `hoop open "fix the bug"` all work. Built-ins
# (help/shortlist/version) still resolve normally for tab-completion + help.
function _call() {
  case "${1:-}" in
    help|--help|-h|shortlist|version|--version|-V) _default_call "$@"; return ;;
  esac
  _launch "$@"
}

# Bootstraps the parser
main $0 "$@"
