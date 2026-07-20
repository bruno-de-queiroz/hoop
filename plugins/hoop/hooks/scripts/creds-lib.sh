#!/usr/bin/env bash
# creds-lib.sh — shared helpers for keeping the sandbox's bind-mounted
# .credentials.json in sync with the host, WITHOUT clobbering the
# sandbox-owned per-MCP OAuth tokens.
#
# Sourced by:
#   - hooks/scripts/refresh-sandbox-creds.sh   (host Stop / SessionStart hook)
#   - cli/lib/stack.sh                         (hoop CLI host-side preflight)
#
# THE FILE IS A MULTI-TOKEN DOCUMENT
# ---------------------------------
#   { "claudeAiOauth": { accessToken, refreshToken, expiresAt, ... },
#     "mcpOAuth":      { "<server-id>": { accessToken, refreshToken, expiresAt, ... }, ... } }
#
#   - .claudeAiOauth  the Anthropic subscription OAuth. The HOST (macOS Keychain
#                     entry "Claude Code-credentials", or ~/.claude/.credentials.json
#                     elsewhere) is authoritative for THIS and only this.
#   - .mcpOAuth.*     independent per-MCP-server OAuth sessions. The sandbox owns
#                     these: it refreshes each one itself (non-interactively) using
#                     that server's own refresh token. They must NOT be replaced
#                     by the host's copy on a reseed, or the sandbox loses (or
#                     lineage-clobbers) MCP auth it can't re-establish headlessly.
#
# So a reseed is SURGICAL: it replaces only .claudeAiOauth and leaves the rest of
# the document untouched. A wholesale overwrite (the historical behavior) is used
# ONLY to bootstrap a missing/corrupt file.
#
# DRIFT DIRECTION (why we don't just "reseed when different")
# -----------------------------------------------------------
# Claude Code OAuth refresh tokens are single-use and rotate on every refresh, so
# the host and sandbox — two independent clients seeded from one lineage — can
# invalidate each other. We only ever move the sandbox onto the host's token when
# the host's is strictly NEWER (later expiresAt). If the sandbox self-refreshed
# more recently than the host, the sandbox holds the live lineage and the host's
# copy is the stale one; downgrading the sandbox would break it, so we leave it.
#
# All functions are `set -u` safe and require jq. No global state; no stdout noise
# except hoop_creds_reconcile, which prints exactly one result verb.

# Normalize a raw credential blob to the wrapped form. Accepts either the wrapped
# shape ({claudeAiOauth: {...}, ...}) or a bare oauth object ({accessToken: ...}).
# stdin -> stdout. Empty output on parse failure.
hoop_creds_normalize() {
  jq -c 'if type == "object" and has("claudeAiOauth") then . else {claudeAiOauth: .} end' 2>/dev/null
}

# Print the host's normalized credential blob (wrapped). Empty if unavailable.
#   macOS: freshest login-Keychain entry for svce "Claude Code-credentials",
#          selected by mdat (there are often stale duplicates from old logins).
#   other: ~/.claude/.credentials.json.
hoop_creds_host_blob() {
  case "$(uname -s)" in
    Darwin) _hoop_creds_host_blob_macos ;;
    *)      _hoop_creds_host_blob_file ;;
  esac
}

_hoop_creds_host_blob_file() {
  local src="$HOME/.claude/.credentials.json"
  [ -f "$src" ] || return 0
  hoop_creds_normalize < "$src"
}

_hoop_creds_host_blob_macos() {
  command -v security >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0

  # Dump metadata and pick the account with the highest mdat among blocks whose
  # service is "Claude Code-credentials". `security find-generic-password -a`
  # can't disambiguate by freshness, so we resolve the account name here first.
  local acct raw
  acct=$(security dump-keychain 2>/dev/null | awk '
    BEGIN { want=0; acct=""; mdat=""; best_mdat=""; best_acct="" }
    function flush() { if (want && acct != "" && mdat > best_mdat) { best_mdat=mdat; best_acct=acct } }
    /^keychain:/ { flush(); want=0; acct=""; mdat=""; next }
    /"svce"<blob>="Claude Code-credentials"/ { want=1 }
    /"acct"<blob>="/ { line=$0; sub(/.*"acct"<blob>="/, "", line); sub(/".*/, "", line); acct=line }
    /"mdat"<timedate>=/ { line=$0; sub(/.*"mdat"<timedate>=0x[0-9A-F]+[[:space:]]+"/, "", line); sub(/".*/, "", line); mdat=line }
    END { flush(); if (best_acct != "") print best_acct }
  ')
  [ -n "$acct" ] || return 0

  raw=$(security find-generic-password -s "Claude Code-credentials" -a "$acct" -w 2>/dev/null) || return 0
  [ -n "$raw" ] || return 0
  printf '%s' "$raw" | hoop_creds_normalize
}

# Coerce a value to a non-negative integer (drop any fractional part; non-numeric
# -> 0). Keeps the `-gt` comparison in reconcile from erroring on odd input.
_hoop_creds_int() {
  local v="${1:-0}"
  v="${v%%.*}"
  case "$v" in
    ""|*[!0-9]*) v=0 ;;
  esac
  printf '%s' "$v"
}

# Core reconcile — the testable unit. The host blob is INJECTED (no Keychain
# access here) so it can be exercised with fixtures.
#
#   $1 = sandbox credentials file path
#   $2 = host normalized blob JSON (from hoop_creds_host_blob)
#
# Writes atomically + chmod 0600 only when it changes the file. Prints exactly
# one result verb to stdout:
#   no-host              host blob empty/invalid -> nothing done
#   insync               host & sandbox .claudeAiOauth.accessToken identical
#   reseeded:first       sandbox file missing/corrupt -> wrote whole host blob
#   reseeded:added       sandbox file valid but had no .claudeAiOauth -> spliced in
#   reseeded:host-newer  host token strictly newer -> spliced .claudeAiOauth only
#   skip:sandbox-newer   tokens differ but sandbox's is newer/equal -> left as-is
hoop_creds_reconcile() {
  local file="$1" host_blob="$2"
  command -v jq >/dev/null 2>&1 || { echo "no-host"; return 0; }

  local host_oauth host_tok host_exp
  host_oauth=$(printf '%s' "$host_blob" | jq -c '.claudeAiOauth // empty' 2>/dev/null)
  [ -n "$host_oauth" ] || { echo "no-host"; return 0; }
  host_tok=$(printf '%s' "$host_oauth" | jq -r '.accessToken // empty' 2>/dev/null)
  host_exp=$(_hoop_creds_int "$(printf '%s' "$host_oauth" | jq -r '.expiresAt // 0' 2>/dev/null)")
  [ -n "$host_tok" ] || { echo "no-host"; return 0; }

  # Bootstrap path: file missing or not valid JSON -> write the whole host blob.
  if [ ! -f "$file" ] || ! jq -e . "$file" >/dev/null 2>&1; then
    if _hoop_creds_write "$file" "$(printf '%s' "$host_blob" | jq -c '.' 2>/dev/null)"; then
      echo "reseeded:first"
    else
      echo "no-host"
    fi
    return 0
  fi

  local file_tok file_exp
  file_tok=$(jq -r '.claudeAiOauth.accessToken // empty' "$file" 2>/dev/null)
  file_exp=$(_hoop_creds_int "$(jq -r '.claudeAiOauth.expiresAt // 0' "$file" 2>/dev/null)")

  # Valid file that has no .claudeAiOauth yet (e.g. only mcpOAuth): splice one in,
  # preserving the rest.
  if [ -z "$file_tok" ]; then
    if _hoop_creds_splice "$file" "$host_oauth"; then echo "reseeded:added"; else echo "no-host"; fi
    return 0
  fi

  if [ "$host_tok" = "$file_tok" ]; then
    echo "insync"
    return 0
  fi

  if [ "$host_exp" -gt "$file_exp" ]; then
    if _hoop_creds_splice "$file" "$host_oauth"; then echo "reseeded:host-newer"; else echo "no-host"; fi
  else
    echo "skip:sandbox-newer"
  fi
  return 0
}

# Splice: replace ONLY .claudeAiOauth, preserving .mcpOAuth and every other key.
_hoop_creds_splice() {
  local file="$1" oauth="$2" tmp
  tmp="${file}.tmp.$$"
  jq --argjson h "$oauth" '.claudeAiOauth = $h' "$file" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$file" 2>/dev/null || { rm -f "$tmp"; return 1; }
  chmod 0600 "$file" 2>/dev/null || true
  return 0
}

# Write a whole blob (bootstrap / corrupt-file recovery only).
_hoop_creds_write() {
  local file="$1" blob="$2" tmp
  [ -n "$blob" ] || return 1
  mkdir -p "$(dirname "$file")" 2>/dev/null || true
  tmp="${file}.tmp.$$"
  printf '%s' "$blob" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$file" 2>/dev/null || { rm -f "$tmp"; return 1; }
  chmod 0600 "$file" 2>/dev/null || true
  return 0
}
