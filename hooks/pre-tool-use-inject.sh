#!/usr/bin/env bash
# PreToolUse hook: inject peer updates before tool execution.
# Calls hoop_check_updates via the MCP server to drain pending
# incoming changes from peers so the agent sees the latest state.
#
# TODO: Wire to MCP tool call in a future ticket.
exit 0
