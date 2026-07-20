#!/usr/bin/env bash
# permission-gate.sh — sole permission gate for the hoop sandbox.
#
# Context: claude is spawned with `--permission-mode bypassPermissions`,
# which disables Claude's built-in permission system entirely. This hook
# is therefore the only thing standing between the model and tool execution.
#
# Decisions:
#   - Known-safe read/inspection tools auto-allow without UI prompt.
#   - Write/Edit and anything else long-poll the dashboard for an
#     explicit user decision.
#   - On any failure (no sandbox, no token, timeout, malformed response)
#     the gate defaults to DENY — never pass-through, since pass-through
#     in bypassPermissions mode equals unconditional allow.
#
# Output protocol (stdout): Claude Code's hookSpecificOutput shape:
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#                          "permissionDecision":"allow|deny",
#                          "permissionDecisionReason":"..."}}
#
# Exit code is always 0 — the decision flows through stdout JSON.

set -u

STATE_DIR="$HOME/.claude/hoop"
HOOK_TOKEN_FILE="${HOOP_HOOK_TOKEN_FILE:-$STATE_DIR/hook.token}"
SANDBOX_SOCKET="${HOOP_SANDBOX_SOCKET:-/var/run/hoop/sandbox.sock}"
GATE_TIMEOUT="${HOOP_PERMISSION_GATE_TIMEOUT_SECONDS:-120}"

# Read-only inspection tools that never need a prompt — allowed with no round
# trip. Keep this list NARROW: anything that can write to disk, change config,
# hit the network with side effects, run a shell, or drive the plan lifecycle
# MUST route to the sandbox (/permission-ask) so the sandbox is the single policy
# authority. These read-only tools are also safe during a `/plan` turn, so
# fast-allowing them here doesn't weaken plan-mode enforcement.
#
# Deliberately NOT auto-allowed (they route to the sandbox):
#   - Bash: frictionless in normal mode, but the sandbox must be able to DENY it
#     during a plan turn (read-only) and escalate `git push` to the host. The
#     sandbox answers immediately for the normal case (no dashboard card).
#   - ExitPlanMode: the sandbox captures the plan from its input and opens the
#     review deterministically (replacing the old heuristic), then denies the
#     tool so the turn holds for approval.
#   - AskUserQuestion: in headless mode it would resolve empty ("dismissed"); it
#     flows through the dashboard so the operator's answer is relayed back.
# ToolSearch only reads deferred tool schemas (no side effects) so it stays here.
AUTO_ALLOW='^(Read|Glob|Grep|WebFetch|WebSearch|NotebookRead|TodoWrite|ToolSearch)$'

emit_allow() {
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"approved by user via dashboard"}}'
  exit 0
}

emit_allow_auto() {
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"auto-allowed (safe tool)"}}'
  exit 0
}

emit_deny() {
  local reason="${1:-denied}"
  # Reason is a fixed literal — no shell interpolation into JSON.
  case "$reason" in
    no-dashboard) printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"permission gate unreachable; dashboard offline"}}' ;;
    timeout)      printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no response from dashboard within timeout"}}' ;;
    user)         printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"denied by user via dashboard"}}' ;;
    policy)       printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked by hoop policy: browser_run_code_unsafe (arbitrary-code browser tool) is permanently disabled"}}' ;;
    *)            printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"denied"}}' ;;
  esac
  exit 0
}

# Hard-deny list: tools that are NEVER allowed — not even via a dashboard
# approval. @playwright/mcp ships `browser_run_code_unsafe` (arbitrary JS in the
# Playwright process, RCE-equivalent) as a non-removable "core" capability, and
# under `--permission-mode bypassPermissions` claude's own permissions.deny is
# inert — so THIS gate is the only reliable place to block it on the dashboard.
# (The settings.json deny still covers `hoop open`, which uses normal perms.)
HARD_DENY='^mcp__playwright__browser_run_code_unsafe$'

# 1. Read hook context. Extract the tool_name.
PAYLOAD=$(cat 2>/dev/null)
if [ -z "$PAYLOAD" ]; then
  emit_deny no-dashboard
fi
TOOL_NAME=$(printf '%s' "$PAYLOAD" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')

# 1a. Hard-deny: never routed to the dashboard, never approvable.
if printf '%s' "$TOOL_NAME" | grep -qE "$HARD_DENY"; then
  emit_deny policy
fi

# 2. Fast-path: read-only tools allow without a round trip. Everything else
#    (Bash, ExitPlanMode, writes, AskUserQuestion, MCP, …) routes to the sandbox,
#    which is the single policy authority — it enforces plan-mode read-only,
#    captures plans, escalates `git push`, and prompts the dashboard as needed.
if printf '%s' "$TOOL_NAME" | grep -qE "$AUTO_ALLOW"; then
  emit_allow_auto
fi

# 3. Everything else needs an explicit dashboard approval. Bail to DENY if
#    sandbox plumbing is missing.
command -v curl >/dev/null 2>&1 || emit_deny no-dashboard
[ -S "$SANDBOX_SOCKET" ] || emit_deny no-dashboard
[ -r "$HOOK_TOKEN_FILE" ] || emit_deny no-dashboard
TOKEN=$(cat "$HOOK_TOKEN_FILE" 2>/dev/null) || emit_deny no-dashboard
[ -n "$TOKEN" ] || emit_deny no-dashboard

ASK_RES=$(curl -fsS --max-time 5 --unix-socket "$SANDBOX_SOCKET" \
  -H "X-Hook-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD" \
  "http://sandbox/permission-ask" 2>/dev/null) || emit_deny no-dashboard
[ -n "$ASK_RES" ] || emit_deny no-dashboard

REQUEST_ID=$(printf '%s' "$ASK_RES" | grep -o '"requestId":"[^"]*"' | head -1 | sed 's/.*"requestId":"\([^"]*\)"/\1/')
[ -n "$REQUEST_ID" ] || emit_deny no-dashboard

WAIT_RES=$(curl -fsS --max-time "$(( GATE_TIMEOUT + 5 ))" --unix-socket "$SANDBOX_SOCKET" \
  -H "X-Hook-Token: $TOKEN" \
  "http://sandbox/permission-wait?requestId=${REQUEST_ID}&timeout=${GATE_TIMEOUT}" 2>/dev/null) || emit_deny timeout
[ -n "$WAIT_RES" ] || emit_deny timeout

DECISION=$(printf '%s' "$WAIT_RES" | grep -o '"decision":"[^"]*"' | head -1 | sed 's/.*"decision":"\([^"]*\)"/\1/')

# Relay the host's decision reason (e.g. plan-rejection feedback) back to the
# model as permissionDecisionReason. The reason is arbitrary host text — quotes,
# newlines, markdown — so it MUST be JSON-encoded, not shell-interpolated. node
# ships in the sandbox image; if it's somehow absent or the payload won't parse,
# fall back to the fixed literals.
emit_from_wait() {
  local decision="$1"
  if command -v node >/dev/null 2>&1; then
    WAIT_RES="$WAIT_RES" DEC="$decision" node -e '
      try {
        const w = JSON.parse(process.env.WAIT_RES || "{}");
        const dec = process.env.DEC;
        const fallback = dec === "allow" ? "approved by user via dashboard" : "denied by user via dashboard";
        const reason = (typeof w.reason === "string" && w.reason.trim()) ? w.reason : fallback;
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: dec, permissionDecisionReason: reason } }) + "\n");
      } catch (e) { process.exit(3); }
    ' && exit 0
  fi
  if [ "$decision" = "allow" ]; then emit_allow; else emit_deny user; fi
}

case "$DECISION" in
  allow) emit_from_wait allow ;;
  deny)  emit_from_wait deny ;;
  *)     emit_deny timeout ;;
esac
