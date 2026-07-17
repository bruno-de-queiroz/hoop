#!/bin/bash
#
# hoop — oosh-generated CLI for the hoop stack.
#
# Modules:
#   dashboard   control the dashboard runtime (dashboard + agent-sandbox)
#   sandbox     manage the agent-sandbox container lifecycle
#   open        launch an interactive claude sandbox in the current directory
#
# HOOP_DIR resolves to this script's directory by default so the CLI works
# straight from the repo (./cli/hoop.sh ...) without any env setup. `hoop
# install` symlinks it onto PATH and exports HOOP_DIR/HOOP_PATH in your shell
# profile.

# Resolve the real directory of this script (follow symlinks) so HOOP_DIR is
# correct whether run in-repo or via the installed symlink.
_hoop_src="${BASH_SOURCE[0]}"
while [ -L "$_hoop_src" ]; do
  _hoop_dir="$(cd "$(dirname "$_hoop_src")" && pwd)"
  _hoop_src="$(readlink "$_hoop_src")"
  [[ "$_hoop_src" != /* ]] && _hoop_src="$_hoop_dir/$_hoop_src"
done
export HOOP_DIR="${HOOP_DIR:-$(cd "$(dirname "$_hoop_src")" && pwd)}"
export MODULES_DIR="${HOOP_DIR}/modules"
unset _hoop_src _hoop_dir

#import oo.sh
. "${HOOP_DIR}/oo.sh"

MODULES=""
for _f in "${MODULES_DIR}"/*.sh; do
  [[ -f "$_f" ]] && MODULES="${MODULES:+${MODULES} }$(basename "${_f%.sh}")"
done
unset _f

function _shortlist() {
  local all=("$@")
  local module="${all[0]}"

  if [[ -f "${MODULES_DIR}/${module}.sh" ]]; then
    all=("${all[@]:1}")
    "${MODULES_DIR}/${module}.sh" shortlist "${all[@]}"
  elif [[ "$module" == "help" ]]; then
    _default_shortlist "$@"
    [[ -z "${all[1]}" ]] && echo "$MODULES"
  else
    _default_shortlist "$@"
    echo "$MODULES"
  fi
}

function _help() {
  printf "\n  ${_DIM}Usage:${_RST} ${_B}hoop${_RST} ${_CY}[ ${MODULES} help ]${_RST}\n"
  printf "\n  ${_B}Commands:${_RST}\n"
  printf "  ${_CY}%-20s${_RST} ${_DIM}%s${_RST}\n" "help" "show options and flags available"
  printf "\n  ${_B}Modules:${_RST}\n"
  for module in $MODULES; do
    if [[ -f "${MODULES_DIR}/${module}.sh" ]]; then
      local description="" _desc_line _pfx="#@module"
      while IFS= read -r _desc_line; do
        [[ "$_desc_line" == '#@module'* ]] || continue
        description="${_desc_line#"$_pfx"}"
        description="${description#"${description%%[! ]*}"}"
        break
      done < "${MODULES_DIR}/${module}.sh"
      printf "  ${_MG}%-20s${_RST} ${_DIM}%s${_RST}\n" "$module" "$description"
    fi
  done
  echo ""
}

function _call() {
  local all=("$@")
  local module="${all[0]}"

  if [[ "$module" =~ ^[a-zA-Z0-9_-]+$ && -f "${MODULES_DIR}/${module}.sh" ]]; then
    all=("${all[@]:1}")
    "${MODULES_DIR}/${module}.sh" "${all[@]}"
  else
    _default_call "$@"
  fi
}

main "$0" "$@"
