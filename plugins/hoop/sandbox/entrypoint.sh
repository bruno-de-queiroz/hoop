#!/usr/bin/env bash
# Sandbox container entrypoint.
#
# Runs as root initially so it can fix ownership of the bind-mounted Claude
# state, then drops to the non-root `agent` user (uid 1100) via gosu before
# exec-ing the server process.
#
# Mount layout (set up on the host by the hoop CLI engine, cli/lib/stack.sh):
#   /home/agent/                       ← bind-mount source = $HOME/.claude/hoop/sandbox/profile
#     .claude.json                     ← claude top-level config
#     .claude/
#       .credentials.json              ← OAuth refresh tokens
#       plugins/, sessions/, hoop/, ...
#
# Why chown here instead of on the host:
#   On macOS with Docker Desktop the bind-mount source is owned by the
#   macOS user (typically uid 501 / 502). The container's `agent` user is
#   uid 1100. Without the chown the agent process can't write credentials,
#   session state, etc. Doing it at entrypoint time avoids a manual
#   `sudo chown -R 1100:1100 ...` step on the host after every fresh setup.
#
# Security posture:
#   The server process itself NEVER runs as root; this script is the only
#   root-capable code and it exits immediately after exec-ing gosu.

set -euo pipefail

HOME_DIR="/home/agent"
RUN_DIR="/var/run/hoop"

# Ensure the expected layout exists even on a freshly-bootstrapped host.
mkdir -p "$HOME_DIR/.claude"
mkdir -p "$HOME_DIR/workspace"
[ -f "$HOME_DIR/.claude.json" ] || echo "{}" > "$HOME_DIR/.claude.json"

# Fix ownership of the bind-mounted tree. Approach varies by filesystem:
#
#   Linux bind-mount (uid honoured): recursive chown writes real ownership,
#     ~milliseconds even on big trees.
#
#   macOS Docker Desktop grpcfuse: chown silently no-ops (files always
#     appear as the host user's uid). A recursive walk still STATs every
#     file before giving up — on a 2.5 GB / 60k-file profile (claude-mem,
#     uv tool installs, plugins/cache, etc.) that's 30+ seconds, blowing
#     past the healthcheck's start-period and causing `compose up
#     --depends_on: service_healthy` to bail.
#
# Probe with a single non-recursive chown. If THAT succeeds, the FS honours
# chown and we walk the tree. If it refuses, the recursive walk would be
# pure wasted IO — skip it. The agent process still writes fine on grpcfuse
# because the bind-mount surfaces files under the host user's uid and the
# Docker fuse layer permits writes regardless.
if chown agent:hoop "$HOME_DIR" 2>/dev/null; then
  chown -R agent:hoop "$HOME_DIR" 2>/dev/null || true
else
  echo "[entrypoint] note: chown $HOME_DIR refused (likely macOS Docker Desktop bind-mount); skipping recursive chown."
fi
chmod 0700 "$HOME_DIR/.claude" 2>/dev/null || true
chmod 0600 "$HOME_DIR/.claude.json" 2>/dev/null || true

# Named volume for the shared UDS + token file. Docker creates it as root:root
# 755 — the agent process can't write there without this fixup. Group-write
# is enabled so the dashboard's `node` user (added to gid 1100) can connect()
# the socket and read sandbox.token.
mkdir -p "$RUN_DIR"
chown agent:hoop "$RUN_DIR"
chmod 0770 "$RUN_DIR"

# The HOME env must point at the agent's real home so Node's os.homedir()
# returns /home/agent and claude resolves ~/.claude.json + ~/.claude/ at the
# canonical paths.
export HOME="$HOME_DIR"

# --- Telemetry isolation (opt-in, configured via /hoop:setup → hoop.env) ---
#
# One master switch, off by default so the shipped image and the open-source
# repo carry no org-specific config or surprising outbound suppression:
#
#   HOOP_DISABLE_TELEMETRY  truthy → fully isolate this sandbox from telemetry.
#     Nothing but the model API (and, later, hoop's own telemetry) should leave.
#     It does two complementary things:
#
#     (1) APP-LAYER OPT-OUTS. Export every documented Claude Code kill switch
#         plus the standard DO_NOT_TRACK and the claude-mem plugin's own toggle.
#         CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is the aggregate (auto-updater
#         + feedback + error-reporting/Sentry + Statsig telemetry); the granular
#         vars are set too for older clients, plus DISABLE_GROWTHBOOK (feature-
#         flag fetches). These are honored by things that CHOOSE to phone home
#         (Statsig, Sentry, GrowthBook, claude-mem) — so their telemetry stops at
#         the source, without blackholing vendor API apexes that MCP *tools*
#         (a Sentry or Datadog MCP) legitimately use.
#
#     (2) NETWORK BLACKHOLE for what ignores the flags. The org's managed
#         remote-settings force-enables CLAUDE_CODE_ENABLE_TELEMETRY (OTEL) at a
#         precedence no in-app setting can beat, and Claude still reaches some
#         Statsig/feature-flag hosts even with the opt-outs set (see
#         anthropics/claude-code#10494). So we map those hosts to 0.0.0.0 in
#         /etc/hosts → the exporter resolves to localhost → connection-refused,
#         fails open (drops the batch, never crashes claude). Hosts come from:
#           - DISCOVERY: every OTLP endpoint declared in the mounted Claude
#             settings and in this process's env (so the org endpoint needs no
#             hand-copying). remote-settings.json is fetched LAZILY and persists
#             in the bind-mounted profile, so discovery covers every boot after
#             the first session; HOOP_OTEL_COLLECTOR_URL closes the first-boot gap.
#           - DENYLIST: a curated set of pure telemetry / feature-flag hosts that
#             don't honor the flags. Deliberately NOT vendor apexes (sentry.io,
#             datadoghq.com) so MCP tools keep working.
#
#   HOOP_OTEL_COLLECTOR_URL  optional explicit host(s) to also blackhole — the
#     first-boot gap, or endpoints not present in settings. URL or bare host;
#     comma-/space-separated for multiple. Honored regardless of the switch.
#
# NOTE: a /etc/hosts denylist can't wildcard and can't enumerate every endpoint;
# for a hard guarantee an egress ALLOWLIST firewall is the only complete tool.
# /etc/hosts must also be written at RUNTIME — Docker regenerates it per start,
# so a build-time entry would be wiped (and would leak endpoints into image layers).

# blackhole one host: strip scheme/path/userinfo/port, then map -> 0.0.0.0 (idempotent).
blackhole_host() {
  local h="$1"
  h="${h#*://}"; h="${h%%/*}"; h="${h##*@}"; h="${h%%:*}"
  [ -n "$h" ] || return 0
  if grep -qiE "[[:space:]]${h}([[:space:]]|\$)" /etc/hosts 2>/dev/null; then
    return 0
  fi
  printf '0.0.0.0\t%s\n' "$h" >> /etc/hosts \
    && echo "[entrypoint] telemetry: blackholed $h -> 0.0.0.0" \
    || echo "[entrypoint] telemetry: WARNING could not write /etc/hosts for $h"
}

# Curated denylist: pure telemetry / feature-flag / analytics INTAKE hosts that
# don't reliably honor the app-level opt-outs. Vendor API *apexes* are
# deliberately excluded so Sentry/Datadog/PostHog/etc. MCP *tools* keep
# functioning — these are all one-way INGESTION endpoints, never what a tool
# queries interactively:
#   - http-intake.logs.*.datadoghq.com  Datadog log ingestion (tools use api.*)
#   - {us,eu}.i.posthog.com             PostHog event ingestion (claude-mem)
#   - oraios-software.de                Serena news/banner/usage (function is
#                                       100% local LSP; this host is non-functional)
# All of the above were observed leaking empirically (tshark SNI) during a
# claude-mem observer + Serena startup EVEN WITH the documented flags set
# (CLAUDE_MEM_TELEMETRY=0, DO_NOT_TRACK, SERENA_USAGE_REPORTING=false): the
# claude-mem endpoints are assembled at runtime and Serena's news/banner fetches
# aren't covered by its usage-reporting flag — so the flags alone don't suffice
# and the intake hosts must be blackholed to actually stop egress.
TELEMETRY_DENYLIST="
statsig.anthropic.com
api.statsig.com
statsigapi.net
events.statsigapi.net
featuregates.org
featureassets.org
prodregistryv2.org
api.growthbook.io
cdn.growthbook.io
http-intake.logs.datadoghq.com
http-intake.logs.us3.datadoghq.com
http-intake.logs.us5.datadoghq.com
http-intake.logs.ap1.datadoghq.com
http-intake.logs.datadoghq.eu
us.i.posthog.com
eu.i.posthog.com
i.posthog.com
oraios-software.de
"

case "${HOOP_DISABLE_TELEMETRY:-}" in
  1|true|TRUE|yes|YES|on|ON)
    # (1) App-layer opt-outs — exported as root so the server and every claude /
    # plugin-worker subprocess inherit them.
    export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
    export DISABLE_TELEMETRY=1
    export DISABLE_ERROR_REPORTING=1
    export DISABLE_BUG_COMMAND=1
    export DISABLE_AUTOUPDATER=1
    export DISABLE_GROWTHBOOK=1
    export DO_NOT_TRACK=1
    export CLAUDE_MEM_TELEMETRY=0
    export SERENA_USAGE_REPORTING=false   # Serena MCP startup usage report -> oraios-software.de
    echo "[entrypoint] telemetry: app-layer opt-outs set (nonessential-traffic, telemetry, error-reporting, growthbook, autoupdater, claude-mem, serena)"

    # (2) Network blackhole: discovered OTLP endpoints (settings + env) ∪ denylist.
    _discovered="$(python3 - <<'PY' 2>/dev/null || true
import json, os
from urllib.parse import urlparse
files = [os.path.expanduser(os.path.join("~/.claude", f)) for f in
         ("remote-settings.json", "settings.json", "settings.local.json", "managed-settings.json")]
files.append("/etc/claude-code/managed-settings.json")
keys = ("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
hosts = set()
def add(v):
    v = (v or "").strip()
    if not v:
        return
    netloc = urlparse(v if "://" in v else "//" + v).netloc or v
    netloc = netloc.split("@")[-1].split(":")[0]
    if netloc:
        hosts.add(netloc)
for fp in files:
    try:
        with open(fp) as fh:
            env = (json.load(fh) or {}).get("env", {})
    except Exception:
        continue
    if isinstance(env, dict):
        for k in keys:
            add(env.get(k))
for k in keys:               # also honor endpoints set directly in this env
    add(os.environ.get(k))
print(" ".join(sorted(hosts)))
PY
)"
    [ -n "$_discovered" ] && echo "[entrypoint] telemetry: discovered OTEL endpoint(s): $_discovered"
    for _h in $_discovered $TELEMETRY_DENYLIST; do blackhole_host "$_h"; done
    ;;
esac

# Explicit extra/override hosts — honored regardless of the switch above.
if [ -n "${HOOP_OTEL_COLLECTOR_URL:-}" ]; then
  for _raw in ${HOOP_OTEL_COLLECTOR_URL//,/ }; do blackhole_host "$_raw"; done
fi

exec gosu agent "$@"
