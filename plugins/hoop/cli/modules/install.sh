#!/bin/bash
#@module Install - install/configure the hoop CLI (symlinks + shell completion)

#import oo.sh
. ${MODULES_DIR}/../oo.sh

PROFILES=(${HOME}/.bashrc ${HOME}/.zshrc)
# Resolved at runtime so the repo is portable (no absolute paths baked in).
HOOP_OUT_DIR="$(cd "${MODULES_DIR}/.." && pwd)"

function _call() {
  # The interactive stack wizard moved out of here into its own top-level
  # command: `hoop setup` (was `hoop install setup`). Point stale muscle memory
  # + old docs at the new spelling instead of a bare "unknown command".
  if [[ "${1:-}" == setup ]]; then
    _error "\`hoop install setup\` has moved — run:  hoop setup"
    return 2
  fi
  [[ $# -eq 0 ]] && { cli; return; }
  _default_call "$@"
}

#@protected ~ find a writable bin directory
function _find_bin_dir() {
  local d
  for d in /opt/homebrew/bin /usr/local/bin ${HOME}/.local/bin; do
    [[ -d "$d" && -w "$d" ]] && { echo "$d"; return; }
  done
  mkdir -p "${HOME}/.local/bin"
  for i in ${PROFILES[@]}; do
    _write_to_profile $i 'export PATH="$HOME/.local/bin:$PATH"'
  done
  echo "${HOME}/.local/bin"
}

#@protected ~ find bash completion directory
function _find_comp_dir() {
  local d
  for d in /opt/homebrew/etc/bash_completion.d \
           /usr/local/etc/bash_completion.d \
           /opt/local/etc/bash_completion.d \
           /etc/bash_completion.d \
           /usr/share/bash-completion/completions; do
    [[ -d "$d" && -w "$d" ]] && { echo "$d"; return; }
  done
  d="${HOME}/.bash_completion.d"
  mkdir -p "$d"
  local entry='for f in ~/".bash_completion.d/"*; do [[ -f "$f" ]] && . "$f"; done'
  for i in ${PROFILES[@]}; do
    _write_to_profile $i "$entry"
  done
  echo "$d"
}

#@public ~ install the hoop cli (symlinks + shell profile wiring)
#@flag -f|--force INSTALL_FORCE "false" boolean ~ reinstall even if hoop is already on PATH
function cli() {
  local _existing_bin
  _existing_bin=$(command -v hoop 2>/dev/null || true)
  if [[ -n "$_existing_bin" && "$INSTALL_FORCE" == true ]]; then
    _info "forcing reinstall (removing existing ${_existing_bin})"
    rm -f "$_existing_bin"
  elif [[ -n "$_existing_bin" ]]; then
    if [[ -e "$_existing_bin" ]]; then
      _info "hoop is already installed at ${_existing_bin} (use -f|--force to reinstall)"
      return 0
    fi
    _info "hoop symlink is broken — reinstalling"
    rm -f "$_existing_bin"
  fi

  local binDir; binDir=$(_find_bin_dir)
  local compDir; compDir=$(_find_comp_dir)

  ln -sf "${HOOP_OUT_DIR}/hoop.sh" "$binDir/hoop"
  ln -sf "${HOOP_OUT_DIR}/hoop.comp.sh" "$compDir/hoop"

  # NB: we intentionally do NOT export HOOP_DIR — hoop.sh always self-resolves
  # its own location, and a stale exported HOOP_DIR (e.g. after the CLI moves)
  # only causes confusion. HOOP_PATH is still needed by the completion script.
  for i in ${PROFILES[@]}; do
    _write_to_profile $i "export HOOP_PATH=$binDir"
    if [[ "$i" == *".zshrc" ]]; then
      _write_to_profile $i "autoload -Uz compinit && compinit"
      _write_to_profile $i "[[ -f ${HOOP_OUT_DIR}/hoop.zcomp.sh ]] && source ${HOOP_OUT_DIR}/hoop.zcomp.sh"
    else
      _write_to_profile $i "[[ -f ${HOOP_OUT_DIR}/hoop.comp.sh ]] && . ${HOOP_OUT_DIR}/hoop.comp.sh"
    fi
  done

  _info "hoop installed to ${binDir}/hoop"
  _info "open a new shell (or 'source ${HOOP_OUT_DIR}/hoop.comp.sh') to enable completion"
  _info "next: configure the sandbox stack with 'hoop setup' (optional), then 'hoop login'"
}

# Bootstraps the parser
main $0 "$@"
