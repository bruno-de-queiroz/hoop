#!/bin/bash
#@module Dashboard - control just the dashboard web service (the UI container)

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# The two-service engine (preflight + compose). Sourced, not exec'd, so these
# commands call its functions scoped to the dashboard service.
. ${MODULES_DIR}/../lib/stack.sh

#@public ~ start the dashboard service (builds its image only if missing)
function start() { hoop_stack_start dashboard; }

#@public ~ stop the dashboard service (leaves agent-sandbox running)
function stop() { hoop_stack_stop dashboard; }

#@public ~ restart just the dashboard service
function restart() { hoop_stack_restart dashboard; }

#@public ~ rebuild the dashboard image and recreate its container (picks up code changes)
#@flag -n|--no-cache DASHBOARD_NO_CACHE "false" boolean ~ build without the layer cache
function rebuild() {
  hoop_stack_nocache "$DASHBOARD_NO_CACHE"
  hoop_stack_rebuild dashboard
}

#@public ~ show dashboard status and URL
function status() { hoop_stack_status; }

#@public ~ follow the dashboard container logs
function logs() { hoop_stack_logs dashboard; }

# Bootstraps the parser
main $0 "$@"
