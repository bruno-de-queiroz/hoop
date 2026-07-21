#!/usr/bin/env bash
# stack.sh — the hoop two-service runtime engine, as a sourced library.
#
# Owns everything the old `hoop-dashboard`/`hoop-stack` launcher did: host-side
# preflight (Claude profile onboarding seed, plugin wiring, auth tokens,
# embedding env) and the docker-compose orchestration for both `agent-sandbox`
# and `dashboard`. It is sourced by the oosh CLI modules (stack/dashboard/
# sandbox/login/logout) and by the top-level `hoop` verbs — the single source
# of truth.
#
# The sandbox owns its OWN Claude identity: `hoop login` runs an interactive
# `claude /login` inside the container (one-time, paste-code flow) which mints
# an independent, self-refreshing OAuth token. The host's credentials are never
# read, copied, or synced.
#
# Contract for sourcing: this file has NO top-level side effects. It only
# assigns HS_* variables and defines functions, so it is safe to source during
# tab-completion or `help`. All docker/host checks happen inside the functions.
#
# Public API (all take an optional service: all|sandbox|dashboard, default all):
#   hoop_stack_start <svc>    up -d (builds only a missing image)
#   hoop_stack_stop <svc>     down (all) / stop (single)
#   hoop_stack_restart <svc>  stop + start
#   hoop_stack_rebuild <svc>  build + up -d --force-recreate  (HOOP_BUILD_NO_CACHE=1 busts cache)
#   hoop_stack_status         is the dashboard up?
#   hoop_stack_logs <svc>     follow logs

# --- Paths (resolved from this file's location: <plugin>/cli/lib/stack.sh) ---
HS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HS_PLUGIN_ROOT="$(cd "${HS_LIB_DIR}/../.." && pwd)"

HS_PORT="${HOOP_PORT:-7842}"
# Layout on host (mirrors what the sandbox container sees at /home/agent/):
#   $HS_SANDBOX_PROFILE/
#     .claude.json    ← claude top-level config (oauthAccount, mcpServers, projects)
#     .claude/        ← .credentials.json, plugins/, sessions/, projects/, hoop/, …
# compose binds $HS_SANDBOX_PROFILE to /home/agent so both land where claude expects.
HS_SANDBOX_PROFILE_ROOT="$HOME/.claude/hoop/sandbox"
HS_SANDBOX_PROFILE="$HS_SANDBOX_PROFILE_ROOT/profile"
HS_SANDBOX_CLAUDE_DIR="$HS_SANDBOX_PROFILE/.claude"
# Where the setup wizard writes profile.md + install-log.md (the dashboard reads
# both via the sandbox API). Inside the container this is ~/.claude/hoop.
HS_SANDBOX_STATE="$HS_SANDBOX_CLAUDE_DIR/hoop"
HS_DASHBOARD_TOKEN_FILE="$HOME/.local/share/hoop/dashboard.token"
HS_PEER_SECRET_FILE="$HOME/.local/share/hoop/peer-signing.secret"
# Opt-in overrides written by /hoop:setup (embedding backend + gh account).
# Sourced at start and forwarded into the sandbox via compose. Named hoop.env
# because its values are almost all sandbox-facing.
HS_ENV_FILE="$HOME/.claude/hoop/hoop.env"

HS_COMPOSE_FILE="${HS_PLUGIN_ROOT}/dashboard/docker-compose.yml"
HS_SVC_SANDBOX="agent-sandbox"
HS_SVC_DASHBOARD="dashboard"
# Image name the compose `agent-sandbox` service builds/runs (kept in sync with
# docker-compose.yml). Reused as a throwaway probe container in host detection.
HS_IMAGE_SANDBOX="hoop-sandbox"

# User-defined host bind-mounts for the sandbox workspace, managed by
# `hoop mount`. `mounts.list` is the source of truth (one
# `<host-path><TAB><name>` per line); `mounts.override.yml` is generated from it
# and layered onto the base compose via a second `-f`. Compose merges the
# `volumes` sequence by appending on unique container mount targets, so these
# extra binds never clobber the base profile/socket/plugin mounts.
HS_SANDBOX_MOUNTS_LIST="$HS_SANDBOX_PROFILE_ROOT/mounts.list"
HS_SANDBOX_MOUNTS_OVERRIDE="$HS_SANDBOX_PROFILE_ROOT/mounts.override.yml"

# Dev-only override: when HOOP_PLUGIN_DEV is truthy, overlay the host plugin repo
# back onto /opt/hoop (read-only) so plugin-source edits are live without an
# image rebuild. The plugin is otherwise BAKED into the sandbox image
# (sandbox/Dockerfile), so this file is absent for normal self-contained runs.
HS_PLUGIN_DEV_OVERRIDE="$HS_SANDBOX_PROFILE_ROOT/plugin-dev.override.yml"

# Embedding-backend override written by `hoop setup` when Docker Model
# Runner is chosen: declares the embedding model via Compose's `models:` element
# so `docker compose up` pulls it and injects the endpoint into the sandbox. Its
# presence makes the stack DEPEND on DMR being enabled on the host, so two guards
# protect it: _hs_compose_guard (Compose must be new enough to parse `models:`,
# runs for every verb) and _hs_guard_dmr_override (DMR must be reachable, runs in
# the start/rebuild preflight) — either one drops the override for the session.
HS_SANDBOX_DMR_OVERRIDE="$HS_SANDBOX_PROFILE_ROOT/dmr.override.yml"

# Docker Model Runner serves an OpenAI-compatible API on :12434. Single source of
# truth for the readiness probe used by the reachability guard, the runtime
# auto-detect, `hoop doctor`, and `hoop setup` — so the port/path lives
# in exactly one place.
HS_DMR_PORT=12434
HS_DMR_PROBE_URL="http://localhost:${HS_DMR_PORT}/engines/llama.cpp/v1/models"

# Recompute HS_COMPOSE, layering the generated overrides when they exist.
# Pure variable assignment (only file-existence tests) so it stays safe to run
# at source time — no docker calls, honoring this file's no-side-effects contract.
# The DMR override is gated on HS_DMR_OVERRIDE_ACTIVE (default on) so the preflight
# guard can drop it for a single run when Docker Model Runner isn't reachable.
_hs_compose_reload() {
  HS_COMPOSE=(docker compose -f "$HS_COMPOSE_FILE")
  [ -f "$HS_SANDBOX_MOUNTS_OVERRIDE" ] && HS_COMPOSE+=(-f "$HS_SANDBOX_MOUNTS_OVERRIDE")
  [ -f "$HS_PLUGIN_DEV_OVERRIDE" ] && HS_COMPOSE+=(-f "$HS_PLUGIN_DEV_OVERRIDE")
  [ -f "$HS_SANDBOX_DMR_OVERRIDE" ] && [ "${HS_DMR_OVERRIDE_ACTIVE:-1}" = 1 ] && HS_COMPOSE+=(-f "$HS_SANDBOX_DMR_OVERRIDE")
}
_hs_compose_reload

# Write/remove the DMR compose-models override. Kept here (not in install.sh) so
# the YAML shape lives next to the compose reload logic. The model endpoint is
# injected into the sandbox as HOOP_MODEL_ENDPOINT / HOOP_MODEL_NAME (distinct
# from the base compose's EMBEDDING_BASE_URL to avoid an env-key collision); the
# sandbox entrypoint maps them onto EMBEDDING_BASE_URL / EMBEDDING_MODEL.
hoop_stack_write_dmr_model() {
  local model="${1:-ai/nomic-embed-text-v1.5}"
  mkdir -p "$HS_SANDBOX_PROFILE_ROOT"
  cat > "$HS_SANDBOX_DMR_OVERRIDE" <<YAML
# Generated by 'hoop setup' (Docker Model Runner) — do not edit by hand.
# Declares the embedding model via Compose's \`models:\` element. On
# \`docker compose up\`, Docker Model Runner pulls the model and injects
# HOOP_MODEL_ENDPOINT / HOOP_MODEL_NAME into the sandbox (the entrypoint maps
# them onto EMBEDDING_BASE_URL / EMBEDDING_MODEL). REQUIRES Docker Model Runner
# enabled on the host (Docker Desktop AI, or the docker-model-plugin on Engine)
# and Docker Compose v2.38+. Remove this file to drop the dependency.
services:
  ${HS_SVC_SANDBOX}:
    models:
      embedding_model:
        endpoint_var: HOOP_MODEL_ENDPOINT
        model_var: HOOP_MODEL_NAME
models:
  embedding_model:
    model: ${model}
    runtime_flags:
      - "--embeddings"
YAML
  HS_DMR_OVERRIDE_ACTIVE=1
  HS_COMPOSE_GUARD_DONE=""   # re-evaluate compose-version support on next verb
  _hs_compose_reload
  # The compose-models provider is now the source of truth for the endpoint
  # (injected as HOOP_MODEL_ENDPOINT, mapped to EMBEDDING_BASE_URL by the sandbox
  # entrypoint). Drop any value _hs_detect_dmr exported earlier in THIS process
  # (e.g. setup bootstrapped the sandbox before DMR was chosen) so it can't
  # shadow the injection via compose's ${EMBEDDING_BASE_URL:-} interpolation.
  unset EMBEDDING_BASE_URL EMBEDDING_MODEL
}

hoop_stack_clear_dmr_model() {
  rm -f "$HS_SANDBOX_DMR_OVERRIDE"
  HS_COMPOSE_GUARD_DONE=""
  _hs_compose_reload
}

# When the DMR compose-models override is present it makes `docker compose up`
# depend on Docker Model Runner being enabled on the host — the models provider
# hard-fails the whole `up` if DMR is absent. So before bringing the stack up,
# verify DMR is reachable; if it isn't, drop the override FOR THIS RUN (the file
# stays on disk) and warn, so search degrades to BM25 instead of bricking start.
# Needs curl to probe; without curl we can't tell, so we leave it layered.
_hs_guard_dmr_override() {
  [ -f "$HS_SANDBOX_DMR_OVERRIDE" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  if curl -fsS --connect-timeout 1 "$HS_DMR_PROBE_URL" >/dev/null 2>&1; then
    return 0
  fi
  echo "hoop: Docker Model Runner not reachable on :12434 — running WITHOUT the DMR compose model this session (search: BM25)." >&2
  echo "  Re-enable it (docker desktop enable model-runner --tcp 12434), or run 'hoop setup' to switch embedding backend." >&2
  HS_DMR_OVERRIDE_ACTIVE=0
  _hs_compose_reload
}

# a >= b for dotted versions (major.minor.patch; missing/garbage parts = 0).
# Tolerates suffixes like "2.38.1-desktop.1" by keeping only leading digits per
# field. Returns 0 (true) when a >= b.
_hs_semver_ge() {
  local a="$1" b="$2" a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<< "${a#v}"
  IFS=. read -r b1 b2 b3 <<< "${b#v}"
  a1="${a1//[!0-9]/}"; a2="${a2//[!0-9]/}"; a3="${a3//[!0-9]/}"
  b1="${b1//[!0-9]/}"; b2="${b2//[!0-9]/}"; b3="${b3//[!0-9]/}"
  a1=$((10#${a1:-0})); a2=$((10#${a2:-0})); a3=$((10#${a3:-0}))
  b1=$((10#${b1:-0})); b2=$((10#${b2:-0})); b3=$((10#${b3:-0}))
  [ "$a1" -ne "$b1" ] && { [ "$a1" -gt "$b1" ]; return; }
  [ "$a2" -ne "$b2" ] && { [ "$a2" -gt "$b2" ]; return; }
  [ "$a3" -ge "$b3" ]
}

# The Compose `models:` element (used by the DMR override) shipped in Docker
# Compose v2.38. On OLDER Compose, layering the override makes EVERY compose
# command — even `ps`/`logs`/`down` — fail schema validation, which would brick
# the whole CLI, not just semantic search. True when this host's Compose is new
# enough to understand `models:`.
_hs_compose_supports_models() {
  local v; v="$(docker compose version --short 2>/dev/null)"
  _hs_semver_ge "${v:-0}" "2.38.0"
}

# Cross-verb safety gate for the DMR compose-models override. The DMR override is
# layered at source time by _hs_compose_reload, so it rides along on *every*
# verb (status/logs/stop/start/rebuild/login/add/mount/...). The reachability
# check (_hs_guard_dmr_override) only runs in the start/rebuild preflight; this
# gate covers the ONE failure mode that breaks every verb: a Compose too old to
# parse `models:`. Run once per process (cached), invoked from the universal
# chokepoints (_hs_require_host + hoop_stack_status). Always returns 0 — it only
# ever DROPS the override, never fails a verb.
HS_COMPOSE_GUARD_DONE=""
_hs_compose_guard() {
  [ -n "${HS_COMPOSE_GUARD_DONE:-}" ] && return 0
  HS_COMPOSE_GUARD_DONE=1
  [ -f "$HS_SANDBOX_DMR_OVERRIDE" ] || return 0
  [ "${HS_DMR_OVERRIDE_ACTIVE:-1}" = 1 ] || return 0
  if ! _hs_compose_supports_models; then
    echo "hoop: docker compose is older than v2.38, which doesn't understand the" >&2
    echo "  'models:' element the Docker Model Runner embedding override uses —" >&2
    echo "  ignoring that override this session (search falls back to BM25)." >&2
    echo "  Fix: upgrade Docker Compose, or run 'hoop setup' to switch backend." >&2
    HS_DMR_OVERRIDE_ACTIVE=0
    _hs_compose_reload
  fi
  return 0
}

# Regenerate mounts.override.yml from mounts.list. When the list is empty/absent
# the override is removed so no stray binds linger. Callers (`hoop sandbox
# mount`/`unmount`) run _hs_compose_reload afterwards to pick up the change.
_hs_regen_mounts_override() {
  if [ ! -s "$HS_SANDBOX_MOUNTS_LIST" ]; then
    rm -f "$HS_SANDBOX_MOUNTS_OVERRIDE"
    return 0
  fi
  {
    echo "# Generated by 'hoop mount' — do not edit by hand."
    echo "services:"
    echo "  ${HS_SVC_SANDBOX}:"
    echo "    volumes:"
    local host name
    while IFS=$'\t' read -r host name; do
      [ -n "$host" ] && [ -n "$name" ] || continue
      # Quote the scalars so paths with spaces, ':' or '#' stay valid YAML.
      printf '      - type: bind\n'
      printf '        source: "%s"\n' "$host"
      printf '        target: "/home/agent/workspace/%s"\n' "$name"
    done < "$HS_SANDBOX_MOUNTS_LIST"
  } > "$HS_SANDBOX_MOUNTS_OVERRIDE"
}

# Regenerate the plugin-dev override from HOOP_PLUGIN_DEV. Truthy → overlay the
# host plugin repo ($HS_PLUGIN_ROOT) onto /opt/hoop read-only for live-editing;
# otherwise remove the override so the baked-in plugin is used. Callers run
# _hs_compose_reload afterwards to pick up the change.
_hs_regen_plugin_dev_override() {
  case "${HOOP_PLUGIN_DEV:-}" in
    1|true|TRUE|yes|YES|on|ON) ;;
    *) rm -f "$HS_PLUGIN_DEV_OVERRIDE"; return 0 ;;
  esac
  {
    echo "# Generated by hoop (HOOP_PLUGIN_DEV=1) — overlays the host plugin repo"
    echo "# onto the baked-in /opt/hoop for live-editing. Unset HOOP_PLUGIN_DEV to"
    echo "# use the image's baked plugin. Do not edit by hand."
    echo "services:"
    echo "  ${HS_SVC_SANDBOX}:"
    echo "    volumes:"
    printf '      - type: bind\n'
    printf '        source: "%s"\n' "$HS_PLUGIN_ROOT"
    printf '        target: /opt/hoop\n'
    printf '        read_only: true\n'
  } > "$HS_PLUGIN_DEV_OVERRIDE"
  echo "HOOP_PLUGIN_DEV: overlaying host plugin repo onto /opt/hoop (live-edit mode)"
}

# compose interpolates ${HOOP_PLUGIN_ROOT} (read-only plugin mount) and
# ${HOOP_PORT}; export them so `docker compose` sees them.
export HOOP_PLUGIN_ROOT="$HS_PLUGIN_ROOT"
export HOOP_PORT="$HS_PORT"

# --- Host guards -------------------------------------------------------------

_hs_in_container() {
  [ -f /.dockerenv ] || grep -qi docker /proc/1/cgroup 2>/dev/null
}

# Refuse to drive compose from inside a container, and require docker. Callers
# do `_hs_require_host || return $?`.
_hs_require_host() {
  if _hs_in_container; then
    echo "hoop: refusing to control the stack from inside a container — run on your host shell." >&2
    return 2
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "hoop: docker not found on host." >&2
    return 1
  fi
  # Drop the DMR compose-models override up front if this host's Compose can't
  # parse `models:` — otherwise the very next `${HS_COMPOSE[@]}` invocation bricks.
  _hs_compose_guard
}

# --- Sandbox exec helpers (used by the `add` module + anything that needs to
# run a command inside the live agent-sandbox container) ---------------------

# `docker compose exec` allocates a TTY by default (good for interactive
# `claude mcp add` prompts). When our own stdin isn't a TTY (e.g. invoked by an
# agent via /hoop:add), pass -T so exec doesn't fail demanding one.
_hs_exec_sandbox() {
  local tty=(); [ -t 0 ] || tty=(-T)
  "${HS_COMPOSE[@]}" exec "${tty[@]}" "$HS_SVC_SANDBOX" "$@"
}

# Fail fast (with a start hint) unless the agent-sandbox container is running.
_hs_require_sandbox_up() {
  local id; id="$("${HS_COMPOSE[@]}" ps -q "$HS_SVC_SANDBOX" 2>/dev/null | head -1)"
  [ -n "$id" ] && return 0
  _error "the ${HS_SVC_SANDBOX} container isn't running."
  _die   "start it first:  hoop sandbox start"
}

# Resolve the address the sandbox should use for `host.docker.internal` and
# export HOOP_HOST_GATEWAY for compose to interpolate into both services'
# extra_hosts. VM-based runtimes (Docker Desktop, Rancher Desktop, OrbStack)
# inject a WORKING host.docker.internal that reaches the real host; forcing the
# alias to Docker's `:host-gateway` magic there instead pins it to the docker0
# bridge gateway (e.g. 172.17.0.1 on Rancher), which cannot reach host services
# — the Ollama/DMR embedders. So probe what a plain container (no --add-host)
# actually resolves and reuse that IP; when nothing resolves — native Linux
# Docker, where the docker0 gateway *is* the host — fall back to `host-gateway`.
# Honors an explicit HOOP_HOST_GATEWAY override.
#
# The probe spawns a throwaway container, so its result is CACHED (keyed by the
# docker context) to keep repeat start/rebuild fast; delete the cache file or
# change context to re-probe. First-ever launch has no image to probe → falls
# back to host-gateway for that run; the next start detects correctly. Fail-open.
HS_HOST_GATEWAY_CACHE="$HOME/.claude/hoop/host-gateway.cache"
_hs_detect_host_gateway() {
  if [ -n "${HOOP_HOST_GATEWAY:-}" ]; then
    export HOOP_HOST_GATEWAY
    echo "host.docker.internal -> ${HOOP_HOST_GATEWAY} (from HOOP_HOST_GATEWAY)"
    return 0
  fi

  local ctx cached_ctx cached_ip
  ctx="$(docker context show 2>/dev/null || echo default)"
  if [ -f "$HS_HOST_GATEWAY_CACHE" ]; then
    IFS=$'\t' read -r cached_ctx cached_ip < "$HS_HOST_GATEWAY_CACHE" 2>/dev/null || true
    if [ "$cached_ctx" = "$ctx" ] && [ -n "$cached_ip" ]; then
      export HOOP_HOST_GATEWAY="$cached_ip"
      echo "host.docker.internal -> ${HOOP_HOST_GATEWAY} (cached)"
      return 0
    fi
  fi

  local ip=""
  if docker image inspect "$HS_IMAGE_SANDBOX" >/dev/null 2>&1; then
    ip="$(docker run --rm --entrypoint sh "$HS_IMAGE_SANDBOX" -c \
      'getent hosts host.docker.internal 2>/dev/null | awk "{print \$1; exit}"' 2>/dev/null | tr -d '[:space:]')"
  fi
  export HOOP_HOST_GATEWAY="${ip:-host-gateway}"
  # Only cache a real probe result (image present); don't pin the first-run
  # host-gateway fallback, so the next start re-probes once the image exists.
  if [ -n "$ip" ]; then
    mkdir -p "$(dirname "$HS_HOST_GATEWAY_CACHE")" 2>/dev/null || true
    printf '%s\t%s\n' "$ctx" "$HOOP_HOST_GATEWAY" > "$HS_HOST_GATEWAY_CACHE" 2>/dev/null || true
  fi
  echo "host.docker.internal -> ${HOOP_HOST_GATEWAY}"
}

# Host-side prerequisite for the build/up paths: just Docker. The JSON seeding
# that used to need host jq now runs INSIDE the sandbox (sandbox/seed-profile.mjs
# via the entrypoint), and curl is only an OPTIONAL nicety (the dashboard health
# wait falls back to a bash /dev/tcp probe; DMR auto-detect is skipped without
# it). So `hoop start` needs nothing but Docker. (jq is REQUIRED by `hoop install
# setup` + `hoop logout` and used by `hoop open`; curl is an optional nicety; awk is
# REQUIRED by `hoop mount` — each guards for itself. The host-gateway probe's awk
# runs INSIDE the container.)
_hs_preflight_common() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "hoop: \`docker\` is required but not on PATH." >&2
    echo "  Install Docker Desktop or your distro's docker package." >&2
    return 1
  fi
  _hs_detect_host_gateway
}

# --- Service resolution ------------------------------------------------------

# Single source of truth for the cache-bust switch: translate a truthy value
# into the HOOP_BUILD_NO_CACHE env the rebuild path reads. Callers (the module
# `-n|--no-cache` flags and the top-level arg scan) funnel through here so the
# env var name lives in exactly one place.
hoop_stack_nocache() {
  [[ "${1:-}" == true ]] && export HOOP_BUILD_NO_CACHE=1
  return 0
}

# Map a user-facing service token to the internal target keyword. Defaults to
# `all`. Prints the normalized target; returns 2 on an unknown value.
hoop_stack_resolve_service() {
  case "${1:-all}" in
    all|both|"")            echo all ;;
    sandbox|agent-sandbox)  echo sandbox ;;
    dashboard|dash|ui)      echo dashboard ;;
    *) echo "hoop: unknown service '$1' (use: all | sandbox | dashboard)" >&2; return 2 ;;
  esac
}

# --- Sandbox-facing preflight ------------------------------------------------

# NOTE: the sandbox profile seeding (onboarding bypass + hoop plugin
# install/enable + hook wiring + playwright deny) that used to run HERE via jq
# now runs INSIDE the container on every boot — sandbox/seed-profile.mjs, invoked
# by the entrypoint using the image's baked Node. That's what lets the host run
# `hoop start` with nothing but Docker (no host jq). It is idempotent and
# merge-safe (never clobbers a logged-in identity).

# Move files from the pre-restructure flat layout into profile/ + .claude/.
_hs_migrate_legacy_profile() {
  if [ -f "$HS_SANDBOX_PROFILE/.claude.json" ] || [ -f "$HS_SANDBOX_CLAUDE_DIR/.credentials.json" ]; then
    return 0
  fi
  local legacy_creds="$HS_SANDBOX_PROFILE_ROOT/.credentials.json"
  local legacy_config="$HS_SANDBOX_PROFILE_ROOT/.claude.json"
  local legacy_agentic="$HS_SANDBOX_PROFILE_ROOT/hoop"
  if [ ! -e "$legacy_creds" ] && [ ! -e "$legacy_config" ] && [ ! -e "$legacy_agentic" ]; then
    return 0
  fi
  echo "migrating legacy sandbox profile layout -> $HS_SANDBOX_PROFILE/"
  [ -f "$legacy_creds" ]  && mv "$legacy_creds"  "$HS_SANDBOX_CLAUDE_DIR/.credentials.json"
  [ -f "$legacy_config" ] && mv "$legacy_config" "$HS_SANDBOX_PROFILE/.claude.json"
  if [ -d "$legacy_agentic" ]; then
    mv "$legacy_agentic" "$HS_SANDBOX_CLAUDE_DIR/hoop"
  fi
}

_hs_load_env_file() {
  # Source the opt-in overrides /hoop:setup writes (OPENAI_API_KEY,
  # EMBEDDING_BASE_URL / EMBEDDING_MODEL, EMBED_DIM, GH account). `set -a`
  # exports every assignment so compose's ${VAR:-} interpolation picks them up.
  [ -f "$HS_ENV_FILE" ] || return 0
  echo "loading overrides from $HS_ENV_FILE"
  set -a; . "$HS_ENV_FILE"; set +a
  if [ -n "${HOOP_GH_ACCOUNT:-}" ] && command -v gh >/dev/null 2>&1; then
    GH_TOKEN="$(gh auth token --user "$HOOP_GH_ACCOUNT" 2>/dev/null || true)"
    export GH_TOKEN
  fi
}

# Upsert KEY=VALUE into the opt-in env file (0600). Used by `hoop setup`
# to persist the semantic-search backend, gh account, and telemetry switches the
# launcher forwards into the sandbox. Values may be secret -> callers must never
# echo/log them. Mirrors the set_env_kv helper the old /hoop:setup markdown used.
hoop_stack_set_env() {
  local key="$1" val="$2" tmp
  mkdir -p "$(dirname "$HS_ENV_FILE")"; touch "$HS_ENV_FILE"; chmod 600 "$HS_ENV_FILE"
  tmp="$(mktemp)"
  grep -v "^${key}=" "$HS_ENV_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$HS_ENV_FILE"; chmod 600 "$HS_ENV_FILE"
}

# Remove one or more keys from HS_ENV_FILE (no-op if absent). Used when switching
# the embedding backend so a prior choice's keys (e.g. OPENAI_API_KEY from an
# earlier OpenAI run) don't linger and shadow the new one / the DMR auto-detect.
hoop_stack_unset_env() {
  [ -f "$HS_ENV_FILE" ] || return 0
  local key tmp; tmp="$(mktemp)"
  cp "$HS_ENV_FILE" "$tmp"
  for key in "$@"; do
    grep -v "^${key}=" "$tmp" > "$tmp.n" 2>/dev/null || true
    mv "$tmp.n" "$tmp"
  done
  mv "$tmp" "$HS_ENV_FILE"; chmod 600 "$HS_ENV_FILE"
}

# Append HOST to HOOP_OTEL_COLLECTOR_URL (comma-separated), de-duplicated. The
# sandbox entrypoint maps every entry to 0.0.0.0 in /etc/hosts on next start, so
# a tool with no telemetry opt-out flag gets its analytics host blackholed.
hoop_stack_blackhole_host() {
  local host="$1" cur
  cur="$(grep '^HOOP_OTEL_COLLECTOR_URL=' "$HS_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  case ",$cur," in *",$host,"*) return 0 ;; esac
  if [ -n "$cur" ]; then
    hoop_stack_set_env HOOP_OTEL_COLLECTOR_URL "$cur,$host"
  else
    hoop_stack_set_env HOOP_OTEL_COLLECTOR_URL "$host"
  fi
}

_hs_detect_dmr() {
  # Sets EMBEDDING_BASE_URL / EMBEDDING_MODEL if Docker Model Runner is up.
  # An explicit endpoint from the env file wins — don't clobber it.
  if [ -n "${EMBEDDING_BASE_URL:-}" ] || [ -n "${OPENAI_API_KEY:-}" ]; then
    echo "embedding backend configured via $HS_ENV_FILE -> semantic search enabled"
    return 0
  fi
  # Auto-detect needs curl to probe the DMR /models endpoint. Without curl we
  # can't safely tell "DMR is up" from "something else is on :12434", so skip
  # the probe (the host stays Docker-only; configure explicitly via setup).
  if ! command -v curl >/dev/null 2>&1; then
    echo "No embedding backend auto-detected (curl absent) -> BM25-only search."
    echo "  Configure semantic search via 'hoop setup'."
    return 0
  fi
  if curl -fsS --connect-timeout 1 "$HS_DMR_PROBE_URL" >/dev/null 2>&1; then
    export EMBEDDING_BASE_URL="http://host.docker.internal:12434/engines/llama.cpp/v1"
    export EMBEDDING_MODEL="${EMBEDDING_MODEL:-ai/nomic-embed-text-v1.5}"
    echo "DMR detected at localhost:12434 -> semantic search enabled"
  else
    echo "No embedding backend -> BM25-only search."
    echo "  Enable semantic search via 'hoop setup' — recommended: Docker Model Runner"
    echo "    docker model pull ai/nomic-embed-text-v1.5   (TCP :12434; ships with Docker)"
    echo "  Alternatives: Ollama, OpenAI, or a custom OpenAI-compatible endpoint."
  fi
}

# The Playwright browser MCP is registered from INSIDE the container (see
# sandbox/entrypoint.sh), not here: it uses `claude mcp add` (claude's own config
# writer) so it can't race claude's live rewrites of .claude.json, and it points
# at an in-image path that's guaranteed present in whatever image is running —
# no host-side editing, no image/profile version skew.

# True when the sandbox holds its own Anthropic OAuth token.
_hs_sandbox_authenticated() {
  local cred="$HS_SANDBOX_CLAUDE_DIR/.credentials.json"
  [ -s "$cred" ] || return 1
  command -v jq >/dev/null 2>&1 || return 0  # can't inspect — assume present
  jq -e '.claudeAiOauth.accessToken // empty' "$cred" >/dev/null 2>&1
}

# Sandbox-facing setup: profile, onboarding seed, plugin wiring, forwarded env.
# Credentials are the sandbox's own (via `hoop login`) — never seeded from host.
_hs_preflight_sandbox() {
  # Create the bind-mount source so docker doesn't materialize it root-owned.
  # The profile CONTENTS (onboarding bypass, plugin wiring, hooks) are seeded
  # inside the container by sandbox/seed-profile.mjs on boot — not here — so the
  # host needs no jq.
  mkdir -p "$HS_SANDBOX_CLAUDE_DIR"
  chmod 0700 "$HS_SANDBOX_PROFILE" "$HS_SANDBOX_CLAUDE_DIR" 2>/dev/null || true
  _hs_migrate_legacy_profile
  _hs_load_env_file
  # HOOP_PLUGIN_DEV (from env or hoop.env, sourced just above) toggles the
  # host-repo overlay onto the baked /opt/hoop; reload so compose picks it up.
  _hs_regen_plugin_dev_override
  _hs_compose_reload
  _hs_guard_dmr_override
  # Embedding backend: when the DMR compose-models override is active, Compose
  # provisions + injects the endpoint, so skip the runtime curl auto-detect.
  if [ -f "$HS_SANDBOX_DMR_OVERRIDE" ] && [ "${HS_DMR_OVERRIDE_ACTIVE:-1}" = 1 ]; then
    # Compose's `models:` provider injects HOOP_MODEL_ENDPOINT/HOOP_MODEL_NAME and
    # the entrypoint maps them onto EMBEDDING_BASE_URL/EMBEDDING_MODEL. Clear any
    # value a prior _hs_detect_dmr exported in this process so it can't shadow the
    # injection (compose interpolates ${EMBEDDING_BASE_URL:-} from our env, and a
    # stale export would silently win over the shim).
    unset EMBEDDING_BASE_URL EMBEDDING_MODEL
    echo "embedding backend: Docker Model Runner via Compose 'models:' -> semantic search enabled"
  else
    _hs_detect_dmr
  fi
  if ! _hs_sandbox_authenticated; then
    echo "hoop: the sandbox has no Claude credentials yet — run 'hoop login' to authenticate it (one-time browser code flow)."
  fi
}

# Dashboard-facing setup: the two secrets the UI container reads from its env.
_hs_preflight_dashboard() {
  # cloudflared is bundled INSIDE the dashboard image (dashboard/Dockerfile) and
  # spawned by server.mjs on demand for share links — nothing to install on the
  # host, so there's no host-side check here.
  mkdir -p "$(dirname "$HS_DASHBOARD_TOKEN_FILE")"
  if [ ! -s "$HS_DASHBOARD_TOKEN_FILE" ]; then
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 32 > "$HS_DASHBOARD_TOKEN_FILE"
    else
      head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$HS_DASHBOARD_TOKEN_FILE"
    fi
    chmod 0600 "$HS_DASHBOARD_TOKEN_FILE"
  fi
  export HOOP_DASHBOARD_TOKEN="$(cat "$HS_DASHBOARD_TOKEN_FILE")"

  if [ ! -s "$HS_PEER_SECRET_FILE" ]; then
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 32 > "$HS_PEER_SECRET_FILE"
    else
      head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$HS_PEER_SECRET_FILE"
    fi
    chmod 0600 "$HS_PEER_SECRET_FILE"
  fi
  export HOOP_PEER_SIGNING_SECRET="$(cat "$HS_PEER_SECRET_FILE")"
}

# Readiness probe that prefers curl (full HTTP check) but degrades to a bash
# /dev/tcp connect test when curl isn't on the host — so `hoop start` never
# requires host curl. The TCP fallback only proves the port is accepting
# connections, which is an adequate "dashboard is up" signal.
_hs_http_ready() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$url" >/dev/null 2>&1
    return $?
  fi
  local hp="${url#*://}"; hp="${hp%%/*}"
  local host="${hp%%:*}" port="${hp##*:}"
  [ "$host" = "$port" ] && port=80
  (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null || return 1
  exec 3>&- 3<&- 2>/dev/null || true
  return 0
}

# Poll the dashboard's health endpoint.
_hs_wait_for_dashboard() {
  echo "waiting for http://localhost:$HS_PORT/api/health ..."
  local _
  for _ in $(seq 1 60); do
    if _hs_http_ready "http://localhost:$HS_PORT/api/health"; then
      echo "ready at http://localhost:$HS_PORT/"
      return 0
    fi
    sleep 0.5
  done
  echo "WARNING: dashboard didn't respond within ~30s. Recent logs:"
  "${HS_COMPOSE[@]}" logs --tail 40 "$HS_SVC_DASHBOARD"
  return 1
}

# --- Public API --------------------------------------------------------------

hoop_stack_status() {
  # status is the one verb that doesn't route through _hs_require_host, so gate here.
  _hs_compose_guard
  "${HS_COMPOSE[@]}" ps --status running --quiet "$HS_SVC_DASHBOARD" 2>/dev/null | grep -q . \
    && echo "running on http://localhost:$HS_PORT/" \
    || { echo "not running"; return 1; }
}

hoop_stack_logs() {
  _hs_require_host || return $?
  local svc; svc=$(hoop_stack_resolve_service "${1:-all}") || return $?
  case "$svc" in
    all)       exec "${HS_COMPOSE[@]}" logs -f ;;
    sandbox)   exec "${HS_COMPOSE[@]}" logs -f "$HS_SVC_SANDBOX" ;;
    dashboard) exec "${HS_COMPOSE[@]}" logs -f "$HS_SVC_DASHBOARD" ;;
  esac
}

hoop_stack_stop() {
  _hs_require_host || return $?
  local svc; svc=$(hoop_stack_resolve_service "${1:-all}") || return $?
  case "$svc" in
    # `all` tears the whole project down (containers + network); a single
    # service just stops that container so the other keeps running.
    all)       "${HS_COMPOSE[@]}" down --remove-orphans ;;
    sandbox)   "${HS_COMPOSE[@]}" stop "$HS_SVC_SANDBOX" ;;
    dashboard) "${HS_COMPOSE[@]}" stop "$HS_SVC_DASHBOARD" ;;
  esac
}

# Bring services up WITHOUT forcing a rebuild. `docker compose up` still builds
# a MISSING image (first launch), so this "just works" cold while staying fast
# on later starts. Use hoop_stack_rebuild to pick up code changes.
hoop_stack_start() {
  _hs_require_host || return $?
  _hs_preflight_common || return 1
  local svc; svc=$(hoop_stack_resolve_service "${1:-all}") || return $?
  case "$svc" in
    sandbox)
      _hs_preflight_sandbox
      echo "hoop: starting agent-sandbox (builds only if image missing)..."
      "${HS_COMPOSE[@]}" up -d --no-deps "$HS_SVC_SANDBOX" || { echo "compose up failed"; return 1; }
      ;;
    dashboard)
      _hs_preflight_dashboard
      echo "hoop: starting dashboard (builds only if image missing)..."
      "${HS_COMPOSE[@]}" up -d --no-deps "$HS_SVC_DASHBOARD" || { echo "compose up failed"; return 1; }
      _hs_wait_for_dashboard
      ;;
    all)
      _hs_preflight_sandbox
      _hs_preflight_dashboard
      echo "hoop: starting dashboard + agent-sandbox (builds only if images missing)..."
      "${HS_COMPOSE[@]}" up -d || { echo "compose up failed"; return 1; }
      _hs_wait_for_dashboard
      ;;
  esac
}

# Rebuild image(s) and recreate the container(s). HOOP_BUILD_NO_CACHE=1 busts
# the layer cache. The "pick up my code / deps changes" path.
hoop_stack_rebuild() {
  _hs_require_host || return $?
  _hs_preflight_common || return 1
  local svc; svc=$(hoop_stack_resolve_service "${1:-all}") || return $?
  local build_args=(); [ -n "${HOOP_BUILD_NO_CACHE:-}" ] && build_args=(--no-cache)
  case "$svc" in
    sandbox)
      _hs_preflight_sandbox
      echo "hoop: rebuilding agent-sandbox image..."
      "${HS_COMPOSE[@]}" build "${build_args[@]}" "$HS_SVC_SANDBOX" || { echo "build failed"; return 1; }
      "${HS_COMPOSE[@]}" up -d --no-deps --force-recreate "$HS_SVC_SANDBOX" || { echo "compose up failed"; return 1; }
      ;;
    dashboard)
      _hs_preflight_dashboard
      echo "hoop: rebuilding dashboard image..."
      "${HS_COMPOSE[@]}" build "${build_args[@]}" "$HS_SVC_DASHBOARD" || { echo "build failed"; return 1; }
      "${HS_COMPOSE[@]}" up -d --no-deps --force-recreate "$HS_SVC_DASHBOARD" || { echo "compose up failed"; return 1; }
      _hs_wait_for_dashboard
      ;;
    all)
      _hs_preflight_sandbox
      _hs_preflight_dashboard
      echo "hoop: rebuilding dashboard + agent-sandbox images..."
      "${HS_COMPOSE[@]}" build "${build_args[@]}" || { echo "build failed"; return 1; }
      "${HS_COMPOSE[@]}" up -d --force-recreate || { echo "compose up failed"; return 1; }
      _hs_wait_for_dashboard
      ;;
  esac
}

# Restart = stop + start for the target.
hoop_stack_restart() {
  local svc; svc=$(hoop_stack_resolve_service "${1:-all}") || return $?
  hoop_stack_stop "$svc" && hoop_stack_start "$svc"
}

# --- Sandbox identity (own credentials, host-decoupled) ----------------------

# One-time interactive login: drop the user into `claude` inside the running
# sandbox as the non-root `agent` user (the image runs as root by default, and
# claude refuses some flows as root) so they can run `/login`. The container's
# localhost OAuth callback is unreachable, so claude falls back to the
# "Paste code here" flow: approve the printed URL in the host browser, paste the
# code back. This mints the sandbox's OWN OAuth token (independent refresh-token
# lineage), which claude then self-refreshes in place. The host is never used.
hoop_stack_login() {
  _hs_require_host || return $?
  local id; id="$("${HS_COMPOSE[@]}" ps -q "$HS_SVC_SANDBOX" 2>/dev/null | head -1)"
  if [ -z "$id" ]; then
    echo "hoop: sandbox not running — starting it first (first run builds the image)..."
    hoop_stack_start sandbox || return 1
  fi
  cat <<'EOF'

hoop login — authenticate the sandbox with its OWN Claude account.
Dropping you into a claude session inside the sandbox. There:
  1. type   /login
  2. open the printed URL in your browser and approve access
  3. paste the code back at the "Paste code here" prompt
  4. type   /exit   (or Ctrl-C) when done
The sandbox keeps its own token; your host credentials are never used.

EOF
  # No -T: compose exec allocates an interactive TTY for claude's login UI.
  "${HS_COMPOSE[@]}" exec -u agent -e HOME=/home/agent -w /home/agent \
    "$HS_SVC_SANDBOX" claude
  local rc=$?
  if _hs_sandbox_authenticated; then
    echo "hoop: sandbox credentials present — login looks good."
  else
    echo "hoop: no sandbox credentials detected. If you didn't finish /login, run 'hoop login' again." >&2
  fi
  return $rc
}

# Sign the sandbox out: strip only .claudeAiOauth from the sandbox
# .credentials.json (preserving per-MCP .mcpOAuth.* the sandbox owns), so a
# different account can be logged in with `hoop login`.
hoop_stack_logout() {
  _hs_require_host || return $?
  local cred="$HS_SANDBOX_CLAUDE_DIR/.credentials.json"
  if [ ! -s "$cred" ]; then
    echo "hoop: sandbox has no credentials — nothing to do."
    return 0
  fi
  command -v jq >/dev/null 2>&1 || { echo "hoop: jq required to edit credentials." >&2; return 1; }
  local tmp; tmp="$(mktemp)"
  if jq 'del(.claudeAiOauth)' "$cred" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$cred" && chmod 0600 "$cred"
    echo "hoop: cleared the sandbox's Claude login — run 'hoop login' to sign in again."
  else
    rm -f "$tmp"
    echo "hoop: failed to rewrite $cred" >&2
    return 1
  fi
}
