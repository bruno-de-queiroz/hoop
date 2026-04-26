#!/usr/bin/env bash
# Drive the elicit-probe MCP via the existing claude-runner image and the mock-llm.
# We script a single tool_use response that calls probe_elicit, so we can see
# exactly how Claude Code answers a server.elicitInput() round-trip.
#
# Usage:
#   bash test-infra/elicit-probe/run.sh
#
# Pre-reqs:
#   docker compose -f docker-compose.test.yml up -d
#   hoop-claude-runner image already built
set -euo pipefail
cd "$(dirname "$0")/../.."

# Set up a one-shot scenario in mock-llm: just call probe_elicit, end_turn.
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

# Hot-swap the scenario into the running mock-llm container.
docker cp /tmp/elicit-probe-scenario.json hoop-mock-llm-1:/app/scenarios/probe.json
curl -s -X POST http://localhost:4000/scenario/probe/reset >/dev/null

# Build a one-shot plugin layout for the probe.
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

echo "=== running probe ==="
docker run --rm --network host \
  -v "$REPO":/repo \
  -v "$PROBE_PLUGIN":/probe-plugin:ro \
  -w /repo \
  -e ANTHROPIC_BASE_URL=http://localhost:4000/probe \
  -e ANTHROPIC_API_KEY=test \
  hoop-claude-runner \
  sh -c '
    claude plugin marketplace add /probe-plugin >/dev/null 2>&1
    claude plugin install probe@probe >/dev/null 2>&1
    echo "--- claude run ---"
    claude "test elicitation" --print --output-format json \
      --allowedTools "mcp__plugin_probe_probe__*" \
      2>/tmp/claude.err | tee /tmp/claude.out
    echo "--- mcp server stderr ([probe] lines tell us what elicitInput did) ---"
    grep "\\[probe\\]" /tmp/claude.err || cat /tmp/claude.err | tail -40
  '

echo
echo "=== mock-llm logs (last 30 lines) ==="
docker logs hoop-mock-llm-1 --tail 30 | tail -30

echo
echo "=== cleanup ==="
rm -rf "$REPO" "$PROBE_PLUGIN"
