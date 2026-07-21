#!/bin/bash
#@module Mount - bind-mount host folders into the sandbox workspace

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# Shared engine: HS_* paths, HS_COMPOSE, the mounts.list/override helpers
# (_hs_regen_mounts_override, _hs_compose_reload) and host guards. No side effects.
. ${MODULES_DIR}/../lib/stack.sh

# Recreate just the sandbox container so a changed mount set takes effect.
function _hs_recreate_sandbox() {
  _hs_compose_reload
  "${HS_COMPOSE[@]}" up -d --no-deps --force-recreate "$HS_SVC_SANDBOX"
}

#@public ~ bind-mount a host folder into the sandbox workspace (recreates the container)
#@flag -p|--path MOUNT_PATH "" dir ~ host directory to mount (required)
#@flag -n|--name MOUNT_NAME "" ~ name under ~/workspace/ inside the sandbox (default: the folder's basename)
function add() {
  _hs_require_host || return $?
  _requires docker
  _requires awk
  [ -n "$MOUNT_PATH" ] || _die "usage: hoop mount add -p <host-path> [-n <name>]"
  local host; host="$(cd "$MOUNT_PATH" 2>/dev/null && pwd)" || _die "not a directory: $MOUNT_PATH"
  [ -d "$host" ] || _die "not a directory: $MOUNT_PATH"
  local name="${MOUNT_NAME:-$(basename "$host")}"
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
function list() {
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
function remove() {
  _hs_require_host || return $?
  _requires awk
  local name="${1:-}"
  [ -n "$name" ] || _die "usage: hoop mount remove <name>"
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

# Bootstraps the parser
main $0 "$@"
