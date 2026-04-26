#!/usr/bin/env bash
# Interactive sibling of run.sh.  Launches claude in REPL mode with the probe
# plugin installed, pointed at the (already-running) mock-llm.  In the REPL,
# type any prompt -- the mock-llm will respond by calling probe_elicit, the
# probe MCP server will issue an elicitInput request, and Claude Code's
# interactive UI should surface a real Ask-style prompt.
#
# Use this to confirm that elicitation actually renders to a human in REPL
# mode (run.sh already proved it works in --print mode but auto-cancels).
#
# Pre-reqs:
#   docker compose -f docker-compose.test.yml up -d
#   hoop-claude-runner image already built
set -euo pipefail
cd "$(dirname "$0")/../.."

cat > /tmp/elicit-probe-scenario.json <<'JSON'
[
  {
    "stop_reason": "tool_use",
    "content": [
      { "type": "text", "text": "Calling probe_elicit." },
      { "type": "tool_use", "id": "toolu_probe_01", "name": "mcp__plugin_probe_probe__probe_elicit", "input": {} }
    ]
  }
]
JSON

docker cp /tmp/elicit-probe-scenario.json hoop-mock-llm-1:/app/scenarios/probe.json
curl -s -X POST http://localhost:4000/scenario/probe/reset >/dev/null

PROBE_PLUGIN=$(mktemp -d /tmp/probe-plugin-XXXXXX)
mkdir -p "$PROBE_PLUGIN/.claude-plugin" "$PROBE_PLUGIN/dist"
cp test-infra/elicit-probe/server.js "$PROBE_PLUGIN/dist/main.js"
cp -r node_modules "$PROBE_PLUGIN/node_modules"
cat > "$PROBE_PLUGIN/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "probe",
  "owner": { "name": "probe", "email": "probe@local" },
  "plugins": [{ "name": "probe", "source": "./", "description": "elicit probe" }]
}
JSON
cat > "$PROBE_PLUGIN/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "probe",
  "description": "elicit probe",
  "version": "0.0.1",
  "mcpServers": {
    "probe": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/main.js"]
    }
  }
}
JSON

REPO=$(mktemp -d /tmp/probe-repo-XXXXXX)

cat <<'EOF'

==================== Interactive Elicit Probe ====================
Once the REPL is up, type ANY prompt (e.g. "go") and press Enter.
The mock-llm will respond by invoking probe_elicit.  The probe MCP
server will then call server.elicitInput(...).

Expected: Claude Code's UI surfaces a yes/no Ask-style prompt asking
"Probe: do you accept this elicitation?".  Answer it.

If you see the prompt + can answer it: ELICITATION RENDERS IN REPL.
If you don't see a prompt and the tool just returns "cancel" or
similar, REPL handling is the same as headless and we need plan B.

Type /exit when done.  (Cleanup runs after.)
===================================================================

EOF

docker run --rm --network host \
  -v "$REPO":/repo \
  -v "$PROBE_PLUGIN":/probe-plugin:ro \
  -w /repo \
  -e ANTHROPIC_BASE_URL=http://localhost:4000/probe \
  -e ANTHROPIC_API_KEY=test \
  -it hoop-claude-runner \
  sh -c '
    claude plugin marketplace add /probe-plugin >/dev/null 2>&1
    claude plugin install probe@probe >/dev/null 2>&1
    claude --allowedTools "mcp__plugin_probe_probe__*"
  '

echo
echo "=== mock-llm logs (last 20 lines) ==="
docker logs hoop-mock-llm-1 --tail 20

echo
echo "=== cleanup ==="
rm -rf "$REPO" "$PROBE_PLUGIN"
