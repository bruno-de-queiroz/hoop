// Scripted Anthropic API stub for docker-based integration tests.
//
// Routing: ANTHROPIC_BASE_URL=http://host:4000/<scenario> causes the SDK to
// POST to /<scenario>/v1/messages. The server routes by the path prefix so
// two claude processes can run different scenarios simultaneously:
//   host: ANTHROPIC_BASE_URL=http://localhost:4000/host
//   peer: ANTHROPIC_BASE_URL=http://localhost:4000/peer
//
// Scenario files live in ./scenarios/<name>.json — an array of response
// objects returned in order, one per API call.  {TOKEN} placeholders in
// response bodies are substituted at call time:
//   {SESSION_CODE}  — extracted from tool results already in the conversation
//   {HOST_ADDRESS}  — extracted from listenAddresses in tool results
//   Any key set via POST /scenario/<name>/set-vars
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);

// scenario → { responses, index, vars }
const registry = new Map();

function load(name) {
  const path = join(__dirname, "scenarios", `${name}.json`);
  if (!existsSync(path)) return false;
  registry.set(name, { responses: JSON.parse(readFileSync(path, "utf-8")), vars: {} });
  return true;
}

function ensure(name) {
  return registry.has(name) || load(name);
}

// Match both the legacy "mcp__hoop__*" prefix (--mcp-config style) and the
// plugin-discovery prefix "mcp__plugin_hoop_hoop__*" (claude plugin install).
const isHoopTool = (name) => name?.startsWith("mcp__hoop__") || name?.startsWith("mcp__plugin_hoop_hoop__");

// Conversation-state-driven scenario serving.
//
// A scenario file declares a single tool_use response.  When the incoming
// conversation already has a matching tool_result, we ECHO that tool_result's
// text (success or error) back as the assistant's end_turn — no scripted
// "Successfully X" template, so the mock can't lie.  Tests that grep the
// result string see what the real MCP tool actually returned.
//
// {SESSION_CODE} / {HOST_ADDRESS} substitution is still honoured for the
// tool_use input (driven by setScenarioVars from the test side), so the
// peer scenario can be aimed at a specific live host.
function nextResponse(scenario, messages, tools) {
  if (!ensure(scenario)) return endTurn(`[mock-llm] unknown scenario: ${scenario}`);
  const s = registry.get(scenario);

  // Hoop-tools-ready gate (Claude Code's init phase makes hoop-less requests
  // first; serving the tool_use to those would be wrong).
  const scenarioUsesMcp = s.responses.some(r =>
    r.content?.some(c => c.type === "tool_use" && isHoopTool(c.name)));
  const hoopToolsReady = (tools ?? []).some(t => isHoopTool(t.name));
  if (scenarioUsesMcp && !hoopToolsReady) {
    return endTurn("[mock-llm] waiting for MCP tools to initialize");
  }

  const toolUseStep = s.responses.find(r =>
    r.content?.some(c => c.type === "tool_use"));
  const toolUseId = toolUseStep?.content?.find(c => c.type === "tool_use")?.id;

  // If a tool_result for our tool_use is in the conversation, echo it.
  if (toolUseId) {
    const result = extractToolResult(messages, toolUseId);
    if (result) {
      const prefix = result.isError ? "Tool error: " : "";
      return endTurn(prefix + result.text);
    }
  }

  // No tool_result yet — serve the scripted tool_use step (with input
  // substitution from preset vars).
  if (!toolUseStep) return endTurn("[mock-llm] scenario has no tool_use step");
  const tmpl = JSON.parse(JSON.stringify(toolUseStep));
  deepSub(tmpl, s.vars);
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 100, output_tokens: 50 },
    ...tmpl,
  };
}

function endTurn(text) {
  return {
    id: `msg_end_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

// Walk messages in reverse looking for the tool_result that matches
// `toolUseId`.  Returns { text, isError } or null.  The MCP server emits
// success results as content:[{type:"text",text:"..."}] and errors as a
// plain string content with is_error:true — handle both shapes.
function extractToolResult(messages, toolUseId) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m?.content)) continue;
    for (const block of m.content) {
      if (block?.type !== "tool_result" || block.tool_use_id !== toolUseId) continue;
      const isError = block.is_error === true;
      let text = "";
      if (typeof block.content === "string") {
        text = block.content;
      } else if (Array.isArray(block.content)) {
        text = block.content
          .filter(c => c?.type === "text" && typeof c.text === "string")
          .map(c => c.text)
          .join("\n");
      }
      return { text, isError };
    }
  }
  return null;
}

function deepSub(obj, vars) {
  if (!obj || typeof obj !== "object") return;
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === "string") {
      obj[k] = obj[k].replace(/\{([A-Z_]+)\}/g, (_, t) => vars[t] ?? `{${t}}`);
    } else {
      deepSub(obj[k], vars);
    }
  }
}

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try { res(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { rej(e); }
    });
    req.on("error", rej);
  });
}

function send(res, status, data) {
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": buf.length });
  res.end(buf);
}

createServer(async (req, res) => {
  try {
    // Strip query string for all route matching
    const path = req.url?.split("?")[0] ?? "/";

    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });

    // HEAD requests — connectivity probes from the Anthropic SDK
    if (req.method === "HEAD") return send(res, 200, {});

    // POST /scenario/:name/reset
    const resetM = path.match(/^\/scenario\/([^/]+)\/reset$/);
    if (req.method === "POST" && resetM) {
      registry.delete(resetM[1]);
      return send(res, 200, { reset: resetM[1] });
    }

    // POST /scenario/:name/set-vars  { KEY: "value", ... }
    const varsM = path.match(/^\/scenario\/([^/]+)\/set-vars$/);
    if (req.method === "POST" && varsM) {
      const name = varsM[1];
      const body = await readBody(req);
      ensure(name);
      Object.assign(registry.get(name).vars, body);
      return send(res, 200, { updated: name });
    }

    // GET [/:scenario]/v1/models — needed for Claude Code model validation on startup
    const modelsM = path.match(/^(?:\/([^/]+))?\/v1\/models$/);
    if (req.method === "GET" && modelsM) {
      return send(res, 200, {
        data: [
          { id: "claude-opus-4-7", type: "model", display_name: "Claude Opus 4.7" },
          { id: "claude-sonnet-4-6", type: "model", display_name: "Claude Sonnet 4.6" },
          { id: "claude-haiku-4-5-20251001", type: "model", display_name: "Claude Haiku 4.5" },
        ],
        has_more: false,
        first_id: "claude-opus-4-7",
        last_id: "claude-haiku-4-5-20251001",
      });
    }

    // POST [/:scenario]/v1/messages
    const msgM = path.match(/^(?:\/([^/]+))?\/v1\/messages$/);
    if (req.method === "POST" && msgM) {
      const scenario = msgM[1] ?? "default";
      const payload = await readBody(req);
      const s = registry.get(scenario);
      const lastMsg = payload.messages?.at(-1);
      const toolNames = (payload.tools ?? []).map(t => t.name);
      const toolResults = Array.isArray(lastMsg?.content)
        ? lastMsg.content.filter(c => c.type === "tool_result")
        : [];
      const hoopReady = toolNames.some(t => t.startsWith("mcp__hoop__"));
      if (hoopReady) {
        const allToolResults = (payload.messages ?? []).flatMap(m =>
          Array.isArray(m.content) ? m.content.filter(c => c.type === "tool_result") : []);
        if (allToolResults.length) console.log(`[mock-llm] tool_results: ${JSON.stringify(allToolResults).slice(0, 600)}`);
      }
      const msgSummary = (payload.messages ?? []).map(m => {
        const ct = Array.isArray(m.content)
          ? m.content.map(c => c.type + (c.type === "tool_use" ? `:${c.name}` : c.type === "tool_result" ? `:${c.tool_use_id}` : "")).join("+")
          : (typeof m.content === "string" ? m.content.slice(0, 40).replace(/\n/g, " ") : "?");
        return `${m.role}[${ct}]`;
      }).join(" → ");
      console.log(`[mock-llm] ${scenario} hoop=${hoopReady} msgs: ${msgSummary}`);
      const resp = nextResponse(scenario, payload.messages, payload.tools);
      console.log(`[mock-llm] → stop_reason=${resp.stop_reason} content_types=${resp.content?.map(c => c.type).join(",")}`);
      return send(res, 200, resp);
    }

    console.error(`[mock-llm] unhandled ${req.method} ${path}`);
    send(res, 404, { error: "not found", url: req.url });
  } catch (err) {
    console.error("[mock-llm] error:", err);
    send(res, 500, { error: String(err) });
  }
}).listen(PORT, () => console.log(`[mock-llm] listening on :${PORT}`));
