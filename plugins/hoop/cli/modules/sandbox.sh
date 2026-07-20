#!/bin/bash
#@module Sandbox - manage just the agent-sandbox container lifecycle

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# The two-service engine (preflight + compose). Sourced, not exec'd, so these
# commands call its functions scoped to the sandbox service — the host-side
# preflight (credential reconcile, plugin wiring, forwarded env) runs before
# the container comes up.
. ${MODULES_DIR}/../lib/stack.sh

#@public ~ start the agent-sandbox container (builds its image only if missing)
function start() { hoop_stack_start sandbox; }

#@public ~ stop the agent-sandbox container (leaves the dashboard running)
function stop() { hoop_stack_stop sandbox; }

#@public ~ restart just the agent-sandbox container
function restart() { hoop_stack_restart sandbox; }

#@public ~ rebuild the sandbox image and recreate the container (picks up code changes)
#@flag -n|--no-cache SANDBOX_NO_CACHE "false" boolean ~ build without the layer cache
function rebuild() {
  hoop_stack_nocache "$SANDBOX_NO_CACHE"
  hoop_stack_rebuild sandbox
}

#@public ~ pin the claude-code CLI baked into the sandbox image to a version and rebuild just that layer forward
#@flag -c|--claude-version SANDBOX_CLAUDE_VERSION "" ~ version to pin (default: resolve latest from npm)
function update() {
  _hs_require_host || return $?
  _hs_preflight_common || return 1
  _requires npm
  local version="$SANDBOX_CLAUDE_VERSION"
  if [[ -z "$version" ]]; then
    version="$(npm view @anthropic-ai/claude-code version 2>/dev/null)"
    [[ -n "$version" ]] || _die "could not resolve latest @anthropic-ai/claude-code version from npm"
  fi
  _info "pinning claude-code ${version} into the sandbox image"
  # Run the same host-side preflight as start/rebuild so the recreated container
  # keeps its forwarded env (embedding backend, gh token, telemetry switches)
  # instead of losing it to empty compose interpolation. Also creates/chmods the
  # bind-mount source so docker doesn't make it root-owned.
  _hs_preflight_sandbox
  "${HS_COMPOSE[@]}" build --build-arg "CLAUDE_CODE_VERSION=${version}" "$HS_SVC_SANDBOX"
  "${HS_COMPOSE[@]}" up -d --no-deps --force-recreate "$HS_SVC_SANDBOX"
}

# --- add: install skills / MCPs / plugins into the sandbox ------------------

# `docker compose exec` allocates a TTY by default (good for interactive
# `claude mcp add` prompts). When our own stdin isn't a TTY (e.g. invoked by an
# agent via /hoop:add), pass -T so exec doesn't fail demanding one.
function _hs_exec_sandbox() {
  local tty=(); [ -t 0 ] || tty=(-T)
  "${HS_COMPOSE[@]}" exec "${tty[@]}" "$HS_SVC_SANDBOX" "$@"
}

# Fail fast (with a start hint) unless the agent-sandbox container is running.
function _hs_require_sandbox_up() {
  local id; id="$("${HS_COMPOSE[@]}" ps -q "$HS_SVC_SANDBOX" 2>/dev/null | head -1)"
  [ -n "$id" ] && return 0
  _error "the ${HS_SVC_SANDBOX} container isn't running."
  _die   "start it first:  hoop sandbox start"
}

# `claude mcp add` writes to the sandbox profile's .claude.json. All args after
# `mcp` are forwarded verbatim (including a `-- <command …>` for stdio servers).
function _hs_add_mcp() {
  _hs_require_host || return $?
  _requires docker
  [ "$#" -gt 0 ] || _die "usage: hoop sandbox add mcp <name> [flags] [-- <command…>]   (forwarded to 'claude mcp add')"
  _hs_require_sandbox_up
  _info "sandbox: claude mcp add $*"
  _hs_exec_sandbox claude mcp add "$@"
}

# `claude plugin install`, optionally registering a marketplace first via
# `-m|--marketplace <spec>`. Remaining args forward verbatim to plugin install.
function _hs_add_plugin() {
  _hs_require_host || return $?
  _requires docker
  local marketplace="" args=() a
  while [ "$#" -gt 0 ]; do
    a="$1"
    case "$a" in
      -m|--marketplace) shift; marketplace="$1" ;;
      --marketplace=*)  marketplace="${a#--marketplace=}" ;;
      *)                args+=("$a") ;;
    esac
    shift
  done
  [ "${#args[@]}" -gt 0 ] || _die "usage: hoop sandbox add plugin [-m <marketplace>] <plugin[@marketplace]> …"
  _hs_require_sandbox_up
  if [ -n "$marketplace" ]; then
    _info "sandbox: claude plugin marketplace add $marketplace"
    _hs_exec_sandbox claude plugin marketplace add "$marketplace" || _die "marketplace add failed"
  fi
  _info "sandbox: claude plugin install ${args[*]}"
  _hs_exec_sandbox claude plugin install "${args[@]}"
}

# Copy a local skill directory into the sandbox profile's skills dir (the
# bind-mount surfaces it at ~/.claude/skills/<name> inside the sandbox). Done on
# the host — no running container required. Refuses to overwrite unless -f.
function _hs_add_skill() {
  # Pure host-side file copy into the bind-mounted profile — no docker needed,
  # so only refuse from inside a container (don't require the docker CLI).
  if _hs_in_container; then
    _die "refusing to modify the sandbox profile from inside a container — run on your host shell."
  fi
  local force=false src="" a
  while [ "$#" -gt 0 ]; do
    a="$1"
    case "$a" in
      -f|--force) force=true ;;
      *) [ -z "$src" ] && src="$a" || _die "unexpected argument: $a" ;;
    esac
    shift
  done
  [ -n "$src" ]            || _die "usage: hoop sandbox add skill [-f] <path-to-skill-dir>"
  [ -d "$src" ]            || _die "not a directory: $src"
  [ -f "$src/SKILL.md" ]   || _die "no SKILL.md in $src — not a skill directory"
  local name dest; name="$(basename "$src")"; dest="$HS_SANDBOX_CLAUDE_DIR/skills/$name"
  mkdir -p "$HS_SANDBOX_CLAUDE_DIR/skills"
  if [ -e "$dest" ] && [ "$force" != true ]; then
    _die "skill '$name' already exists at $dest (use -f to overwrite)"
  fi
  rm -rf "$dest"
  cp -R "$src" "$dest" || _die "failed to copy skill into $dest"
  _info "installed skill '$name' -> available in the sandbox at ~/.claude/skills/$name"
}

#@public ~ install an mcp | plugin | skill into the sandbox (see: hoop sandbox help add)
#@flag -m|--marketplace SANDBOX_ADD_MARKETPLACE "" ~ (plugin) marketplace to register first, e.g. owner/repo or a git URL
#@flag -f|--force SANDBOX_ADD_FORCE "false" boolean ~ (skill) overwrite an existing skill of the same name
function add() {
  local kind="${1:-}"; [ "$#" -gt 0 ] && shift
  case "$kind" in
    mcp)          _hs_add_mcp "$@" ;;
    plugin)       _hs_add_plugin "$@" ;;
    skill)        _hs_add_skill "$@" ;;
    ""|-h|--help) main "$0" help add ;;
    *)            _die "unknown add target '$kind' (use: mcp | plugin | skill)" ;;
  esac
}

# --- mount: bind-mount host folders into the sandbox workspace --------------

# Recreate just the sandbox container so a changed mount set takes effect.
function _hs_recreate_sandbox() {
  _hs_compose_reload
  "${HS_COMPOSE[@]}" up -d --no-deps --force-recreate "$HS_SVC_SANDBOX"
}

#@public ~ bind-mount a host folder into the sandbox workspace (recreates the container)
function mount() {
  _hs_require_host || return $?
  _requires docker
  local raw="${1:-}" name="${2:-}"
  [ -n "$raw" ] || _die "usage: hoop sandbox mount <host-path> [name]"
  local host; host="$(cd "$raw" 2>/dev/null && pwd)" || _die "not a directory: $raw"
  [ -d "$host" ] || _die "not a directory: $raw"
  name="${name:-$(basename "$host")}"
  case "$name" in */*|*'\'*|.|..|"") _die "invalid mount name: '$name' (must be a single path segment)" ;; esac

  mkdir -p "$HS_SANDBOX_PROFILE_ROOT"
  touch "$HS_SANDBOX_MOUNTS_LIST"
  # Upsert: drop any prior entry for this name, then append the new mapping.
  local tmp; tmp="$(mktemp)"
  awk -F '\t' -v n="$name" '$2 != n' "$HS_SANDBOX_MOUNTS_LIST" > "$tmp" 2>/dev/null || true
  printf '%s\t%s\n' "$host" "$name" >> "$tmp"
  mv "$tmp" "$HS_SANDBOX_MOUNTS_LIST"

  _hs_regen_mounts_override
  _info "mounting $host -> /home/agent/workspace/$name (recreating sandbox)"
  _hs_recreate_sandbox
}

#@public ~ list host folders currently mounted into the sandbox workspace
function mounts() {
  if [ ! -s "$HS_SANDBOX_MOUNTS_LIST" ]; then
    _info "no mounts configured"
    return 0
  fi
  local host name
  while IFS=$'\t' read -r host name; do
    [ -n "$host" ] || continue
    printf "  %s  ->  /home/agent/workspace/%s\n" "$host" "$name"
  done < "$HS_SANDBOX_MOUNTS_LIST"
}

#@public ~ remove a previously mounted folder by name (recreates the container)
function unmount() {
  _hs_require_host || return $?
  local name="${1:-}"
  [ -n "$name" ] || _die "usage: hoop sandbox unmount <name>"
  [ -s "$HS_SANDBOX_MOUNTS_LIST" ] || _die "no mounts configured"
  local tmp; tmp="$(mktemp)"
  awk -F '\t' -v n="$name" '$2 != n' "$HS_SANDBOX_MOUNTS_LIST" > "$tmp"
  if cmp -s "$tmp" "$HS_SANDBOX_MOUNTS_LIST"; then
    rm -f "$tmp"; _die "no such mount: $name"
  fi
  mv "$tmp" "$HS_SANDBOX_MOUNTS_LIST"
  _hs_regen_mounts_override
  _info "unmounted '$name' (recreating sandbox)"
  _hs_recreate_sandbox
}

# `add`/`mount`/`mounts`/`unmount` forward args verbatim (to `claude` or docker
# compose), so bypass oosh's flag parser for EXECUTION: it strips the `--`
# separator and would warn on claude's own flags. `help`/`shortlist` still flow
# through main() below, so these verbs stay documented and tab-completable.
case "${1:-}" in
  add|mount|mounts|unmount)
    for _a in "$@"; do
      case "$_a" in -h|--help) main "$0" help "$1"; exit 0 ;; esac
    done
    "$@"; exit $?
    ;;
esac

# Bootstraps the parser
main $0 "$@"
