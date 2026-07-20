#!/bin/bash
#@module Uninstall - remove the hoop CLI from the system

#import oo.sh
. ${MODULES_DIR}/../oo.sh

PROFILES=(${HOME}/.bashrc ${HOME}/.zshrc)
HOOP_OUT_DIR="$(cd "${MODULES_DIR}/.." && pwd)"

function _call() {
  [[ $# -eq 0 ]] && { cli; return; }
  _default_call "$@"
}

#@public ~ uninstall hoop (removes symlinks + profile wiring; keeps the repo)
function cli() {
  # Remove the PATH symlink.
  local bin; bin=$(command -v hoop 2>/dev/null)
  [[ -L "$bin" ]] && rm -f "$bin"

  # Remove the completion symlink from any known location.
  local d
  for d in /opt/homebrew/etc/bash_completion.d \
           /usr/local/etc/bash_completion.d \
           /opt/local/etc/bash_completion.d \
           /etc/bash_completion.d \
           /usr/share/bash-completion/completions \
           ${HOME}/.bash_completion.d; do
    [[ -L "$d/hoop" ]] && rm -f "$d/hoop"
  done

  # Clean shell profiles.
  for i in ${PROFILES[@]}; do
    _remove_from_profile $i "export HOOP_DIR="
    _remove_from_profile $i "export HOOP_PATH="
    _remove_from_profile $i "${HOOP_OUT_DIR}/hoop.comp.sh"
    _remove_from_profile $i "${HOOP_OUT_DIR}/hoop.zcomp.sh"
  done

  _info "hoop uninstalled (the repo at ${HOOP_OUT_DIR} was left in place)"
}

# Bootstraps the parser
main $0 "$@"
