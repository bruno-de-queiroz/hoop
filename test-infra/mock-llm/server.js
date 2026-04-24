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
  registry.set(name, { responses: JSON.parse(readFileSync(path, "utf-8")), index: 0, vars: {} });
  return true;
}

function ensure(name) {
  return registry.has(name) || load(name);
}

function nextResponse(scenario, messages, tools) {
  if (!ensure(scenario)) return endTurn(`[mock-llm] unknown scenario: ${scenario}`);
  const s = registry.get(scenario);
  if (s.index >= s.responses.length) return endTurn("[mock-llm] scenario exhausted");

  // If the scenario uses hoop MCP tools but they haven't been registered in this
  // request yet (parallel no-tools requests from Claude Code's init phase),
  // return a placeholder and do NOT advance the index.
  const scenarioUsesMcp = s.responses.some(r =>
    r.content?.some(c => c.type === "tool_use" && c.name?.startsWith("mcp__hoop__")));
  const hoopToolsReady = (tools ?? []).some(t => t.name?.startsWith("mcp__hoop__"));
  if (scenarioUsesMcp && !hoopToolsReady) {
    return endTurn("[mock-llm] waiting for MCP tools to initialize");
  }

  // For tool_use steps: serve the same response to ALL parallel requests without
  // advancing the index — Claude Code fires multiple concurrent API calls and one
  // of them may be discarded.  Only advance past the tool_use once an incoming
  // request actually carries the matching tool_result (meaning Claude executed it).
  const currentStep = s.responses[s.index];
  const currentToolUseId = currentStep?.content?.find(c => c.type === "tool_use")?.id;

  if (currentToolUseId) {
    const hasToolResult = (messages ?? []).some(m =>
      Array.isArray(m.content) && m.content.some(c =>
        c.type === "tool_result" && c.tool_use_id === currentToolUseId));

    if (!hasToolResult) {
      // Tool not yet executed — re-serve the tool_use without advancing.
      const tmpl = JSON.parse(JSON.stringify(currentStep));
      deepSub(tmpl, buildVars(messages, s.vars));
      return { id: `msg_${Date.now()}`, type: "message", role: "assistant",
        model: "claude-sonnet-4-6", usage: { input_tokens: 100, output_tokens: 50 }, ...tmpl };
    }

    // Tool was executed — advance past the tool_use step.
    s.index++;
    if (s.index >= s.responses.length) return endTurn("[mock-llm] scenario exhausted");
  }

  // Non-tool-use step (or post-tool-result continuation): serve WITHOUT advancing
  // so all parallel requests in this phase get the same response.
  const tmpl = JSON.parse(JSON.stringify(s.responses[s.index]));
  deepSub(tmpl, buildVars(messages, s.vars));
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

// Walk messages in reverse looking for a tool_result whose text is JSON.
// Returns the parsed object, or null if none found.  Regex over the
// JSON.stringify'd form doesn't work because nested JSON gets double-escaped.
function extractLastToolResultJson(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m?.content)) continue;
    for (const block of m.content) {
      if (block?.type !== "tool_result" || !Array.isArray(block.content)) continue;
      for (const tc of block.content) {
        if (tc?.type !== "text" || typeof tc.text !== "string") continue;
        try {
          const obj = JSON.parse(tc.text);
          if (obj && typeof obj === "object") return obj;
        } catch { /* not JSON — skip */ }
      }
    }
  }
  return null;
}

function buildVars(messages, preset) {
  const parsed = extractLastToolResultJson(messages);
  return {
    SESSION_CODE: parsed?.sessionCode ?? preset.SESSION_CODE,
    HOST_ADDRESS: parsed?.listenAddresses?.[0] ?? preset.HOST_ADDRESS,
    ...preset,
  };
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
      console.log(`[mock-llm] ${scenario} turn ${s?.index ?? 0} hoop=${hoopReady} msgs: ${msgSummary}`);
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
