#!/bin/bash
#@module Doctor - health-check the host + stack; report Docker-only standalone readiness

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# Runtime engine: HS_* paths, HS_COMPOSE, auth check, host guards. Sourcing has
# no side effects, so `hoop doctor` stays read-only.
. ${MODULES_DIR}/../lib/stack.sh

# Report helpers. FAIL increments a counter so the exit code reflects real,
# blocking problems; WARN is advisory (never fails the run).
_DOC_FAIL=0 _DOC_WARN=0
_d_pass() { printf "  ${_GR}✔${_RST}  %s\n" "$*"; }
_d_warn() { printf "  ${_YL}!${_RST}  %s\n" "$*"; _DOC_WARN=$((_DOC_WARN + 1)); }
_d_fail() { printf "  ${_RD}✘${_RST}  %s\n" "$*"; _DOC_FAIL=$((_DOC_FAIL + 1)); }
_d_head() { printf "\n  ${_B}%s${_RST}\n" "$*"; }
_d_have() { command -v "$1" >/dev/null 2>&1; }

#@protected ~ run every health check and print a verdict
function _doctor() {
  _hs_require_host || return $?
  printf "\n  ${_B}hoop doctor${_RST} ${_DIM}— host + stack health (Docker-only standalone lens)${_RST}\n"

  # --- Host prerequisites the CLI actually needs ---------------------------
  _d_head "Host prerequisites"
  if _d_have docker; then _d_pass "docker present ${_DIM}($(docker --version 2>/dev/null | head -1))${_RST}"
  else _d_fail "docker missing — install Docker Desktop or your distro's docker package"; fi
  if docker compose version >/dev/null 2>&1; then _d_pass "docker compose v2 present"
  else _d_fail "docker compose v2 missing — hoop needs the Compose v2 plugin (\`docker compose\`)"; fi
  # Beyond Docker, `hoop start` needs nothing (profile seeding runs in the sandbox;
  # the health wait falls back to /dev/tcp). The rest are per-subcommand tools with
  # different tiers: jq is REQUIRED by `hoop install setup` + `hoop logout` (and used
  # by `open`), awk is REQUIRED by `hoop mount`, curl is an optional nicety (DMR probe
  # + health wait, both degrade). Report compactly instead of a per-tool checklist.
  local dep missing_opt=""
  for dep in jq curl awk; do _d_have "$dep" || missing_opt+="$dep "; done
  if [ -z "$missing_opt" ]; then
    _d_pass "subcommand tools present ${_DIM}(jq, curl, awk)${_RST}"
  else
    _d_warn "subcommand tools missing: ${missing_opt}${_DIM}— not needed for 'hoop start'; jq required for setup/logout, awk for mount, curl optional${_RST}"
  fi

  # --- The host should NOT depend on Claude Code / Node -------------------
  _d_head "Host decoupling (host should NOT need Claude Code)"
  if _d_have claude; then _d_pass "host has claude, but hoop ignores it — the sandbox owns its own login"
  else _d_pass "no host claude — correct; the sandbox ships its own \`claude\`"; fi
  if _d_have node; then _d_pass "host has node, but hoop doesn't require it"
  else _d_pass "no host node — correct; Node runs inside the containers"; fi

  # --- Docker daemon -------------------------------------------------------
  _d_head "Docker daemon"
  if docker info >/dev/null 2>&1; then _d_pass "docker daemon reachable"
  else _d_fail "docker daemon not reachable — start Docker, then re-run"; fi

  # --- Sandbox profile (host-side bind-mount source) ----------------------
  _d_head "Sandbox profile"
  if [ -d "$HS_SANDBOX_CLAUDE_DIR" ]; then _d_pass "profile present ${_DIM}($HS_SANDBOX_PROFILE)${_RST}"
  else _d_warn "no sandbox profile yet — run 'hoop start' (first run builds the image, ~2-3 min)"; fi

  # --- Stack services ------------------------------------------------------
  _d_head "Stack services"
  local sid did
  sid="$("${HS_COMPOSE[@]}" ps -q "$HS_SVC_SANDBOX" 2>/dev/null | head -1)"
  did="$("${HS_COMPOSE[@]}" ps -q "$HS_SVC_DASHBOARD" 2>/dev/null | head -1)"
  if [ -n "$sid" ]; then _d_pass "agent-sandbox running"
  else _d_warn "agent-sandbox not running — 'hoop start'"; fi
  if [ -n "$did" ] && _hs_http_ready "http://localhost:$HS_PORT/api/health"; then
    _d_pass "dashboard reachable on http://localhost:$HS_PORT/"
  elif [ -n "$did" ]; then _d_warn "dashboard container up but not reachable on :$HS_PORT"
  else _d_warn "dashboard not running — 'hoop start'"; fi

  # --- Claude sign-in (sandbox's own account) -----------------------------
  _d_head "Claude sign-in (sandbox)"
  if _hs_sandbox_authenticated; then _d_pass "sandbox is signed in to Claude"
  else _d_warn "sandbox not signed in — run 'hoop login'"; fi

  # --- Semantic search (embeddings) ---------------------------------------
  _d_head "Semantic search (embeddings)"
  local base
  base="$(grep '^EMBEDDING_BASE_URL=' "$HS_ENV_FILE" 2>/dev/null | cut -d= -f2-)"
  if [ -f "$HS_SANDBOX_DMR_OVERRIDE" ]; then
    if ! _hs_compose_supports_models; then
      _d_warn "Docker Model Runner wired via Compose 'models:' but docker compose < v2.38 can't parse it — 'hoop start' ignores the override and falls back to BM25 (upgrade Compose, or re-run 'hoop install setup')"
    elif _d_have curl && ! curl -fsS --connect-timeout 1 "$HS_DMR_PROBE_URL" >/dev/null 2>&1; then
      _d_warn "Docker Model Runner wired via Compose 'models:' but not reachable on :12434 — 'hoop start' will fall back to BM25 until DMR is enabled"
    else
      _d_pass "Docker Model Runner via Compose 'models:' (embedding model in the compose stack)"
    fi
  elif grep -q '^OPENAI_API_KEY=' "$HS_ENV_FILE" 2>/dev/null; then
    _d_pass "hosted OpenAI embeddings configured"
  elif [ -n "$base" ]; then
    _d_pass "custom/Ollama embeddings configured ${_DIM}($base)${_RST}"
  else
    _d_warn "no embedder detected — semantic search is BM25-only ('hoop install setup' to add DMR/OpenAI/Ollama)"
  fi

  # --- Verdict -------------------------------------------------------------
  _d_head "Verdict"
  if [ "$_DOC_FAIL" -eq 0 ]; then
    printf "  ${_GR}Docker-only host requirements satisfied.${_RST} ${_DIM}(%s warning(s))${_RST}\n\n" "$_DOC_WARN"
    return 0
  fi
  printf "  ${_RD}%s blocking issue(s)${_RST}, ${_YL}%s warning(s)${_RST} — fix the ✘ items above.\n\n" \
    "$_DOC_FAIL" "$_DOC_WARN"
  return 1
}

# `hoop doctor` takes no subcommands — anything that isn't a built-in runs the
# checks. Built-ins (help/shortlist/version) still resolve for completion + help.
function _call() {
  case "${1:-}" in
    help|--help|-h|shortlist|version|--version|-V) _default_call "$@"; return ;;
  esac
  _doctor "$@"; exit $?
}

# Bootstraps the parser
main $0 "$@"
