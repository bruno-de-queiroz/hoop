#!/bin/bash
#@module Install - install/configure the hoop CLI (symlinks + shell completion)

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# Interactive confirm helper (side-effect-free to source, so completion/help
# stay fast). Used to ask before reconfiguring an existing install.
. ${MODULES_DIR}/../lib/prompt.sh

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

#@public ~ install the hoop cli (symlinks + shell profile wiring) then run setup
#@flag -f|--force INSTALL_FORCE "false" boolean ~ reinstall even if hoop is already on PATH
#@flag --wizard INSTALL_WIZARD "false" boolean ~ run the interactive setup wizard instead of installing the default stack
function cli() {
  # Decide whether to (re)wire the symlink + shell profile. When `hoop` is
  # already on PATH we don't need to relink — but `hoop install` continues into
  # `hoop setup`, so ask first whether to reconfigure (a plain re-run shouldn't
  # silently rebuild/reconfigure the stack). `-f|--force` relinks and proceeds
  # without asking; a non-interactive shell can't be asked, so it proceeds.
  local _wire=true _existing_bin
  _existing_bin=$(command -v hoop 2>/dev/null || true)
  if [[ -n "$_existing_bin" && "$INSTALL_FORCE" == true ]]; then
    _info "forcing reinstall (removing existing ${_existing_bin})"
    rm -f "$_existing_bin"
  elif [[ -n "$_existing_bin" && -e "$_existing_bin" ]]; then
    if [ -t 0 ] && ! _p_confirm "hoop is already installed at ${_existing_bin}. Reconfigure the stack now (runs 'hoop setup')?" y; then
      _info "left as-is — run 'hoop setup' any time to reconfigure, or 'hoop install -f' to relink."
      return 0
    fi
    _info "hoop already on PATH — skipping relink, continuing to setup (use -f|--force to relink)."
    _wire=false
  elif [[ -n "$_existing_bin" ]]; then
    _info "hoop symlink is broken — reinstalling"
    rm -f "$_existing_bin"
  fi

  if [[ "$_wire" == true ]]; then
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
  fi

  # `hoop install` is the one-liner: after wiring the CLI onto PATH it continues
  # straight into `hoop setup`, which configures the sandbox stack and — when a
  # TTY is present — signs the sandbox in and starts the dashboard. Invoke the
  # CLI by its real path (not the just-created PATH symlink the current shell
  # hasn't picked up yet). Pass --wizard through for the full interactive menus.
  local _setup_args=()
  [[ "${INSTALL_WIZARD:-false}" == true ]] && _setup_args=(--wizard)
  _info "configuring the sandbox stack: hoop setup ${_setup_args[*]}"
  "${HOOP_OUT_DIR}/hoop.sh" setup "${_setup_args[@]}"
}

# Bootstraps the parser
main $0 "$@"
