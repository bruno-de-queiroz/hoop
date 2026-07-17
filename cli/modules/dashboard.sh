#!/bin/bash
#@module Dashboard - control the hoop dashboard runtime (dashboard + agent-sandbox)

#import oo.sh
. ${MODULES_DIR}/../oo.sh

# Repo root = <repo>/cli/modules/../.. — the CLI is vendored under <repo>/cli.
HOOP_REPO_ROOT="$(cd "${MODULES_DIR}/../.." && pwd)"
HOOP_DASHBOARD_BIN="${HOOP_REPO_ROOT}/plugins/hoop/dashboard/bin/hoop-dashboard"

#@protected ~ exec the underlying launcher, forwarding stdio (tty for logs)
function _dash() {
  [[ -x "$HOOP_DASHBOARD_BIN" ]] || _die "launcher not found or not executable: ${HOOP_DASHBOARD_BIN}"
  exec "$HOOP_DASHBOARD_BIN" "$@"
}

#@public ~ start the dashboard (builds images if needed)
function start() { _dash start; }

#@public ~ stop the dashboard and remove its containers
function stop() { _dash stop; }

#@public ~ restart the dashboard
function restart() { _dash restart; }

#@public ~ show dashboard status and URL
function status() { _dash status; }

#@public ~ follow dashboard + sandbox logs
function logs() { _dash logs; }

# Bootstraps the parser
main $0 "$@"
