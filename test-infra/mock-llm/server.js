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

// Conversation-state-driven, multi-step scenario serving.
//
// A scenario file is an ORDERED list of steps.  Each step has a tool_use
// (with a unique id) and may have a `when` condition gating when it fires.
// The mock-llm walks the list in order and serves the first not-yet-completed
// step whose condition is met.  When all steps are done (or the next step is
// waiting for its condition) we ECHO the most recent tool_result back as the
// assistant's end_turn — no scripted success template, so the mock can't lie.
//
// Vars priority (highest wins): user-prompt slash args > tool_result
// extractions (e.g. PENDING_PEER_ID from a prior hoop_check_admissions) >
// set-vars presets.
function nextResponse(scenario, messages, tools) {
  if (!ensure(scenario)) return endTurn(`[mock-llm] unknown scenario: ${scenario}`);
  const s = registry.get(scenario);

  // Tools-ready gate (Claude Code's init phase issues messages with no tool
  // schemas; serving a tool_use against an unregistered tool would error).
  // We wait until *every* tool the scenario references is present in the
  // request's `tools` list.
  const scenarioToolNames = new Set();
  for (const r of s.responses) {
    for (const c of r.content ?? []) {
      if (c?.type === "tool_use" && typeof c.name === "string") scenarioToolNames.add(c.name);
    }
  }
  const advertisedToolNames = new Set((tools ?? []).map(t => t.name));
  const allToolsReady = [...scenarioToolNames].every(n => advertisedToolNames.has(n));
  if (scenarioToolNames.size > 0 && !allToolsReady) {
    return endTurn("[mock-llm] waiting for MCP tools to initialize");
  }

  // Tool_use ids already echoed back as tool_results — these steps are done.
  const seenToolUseIds = new Set();
  for (const m of messages ?? []) {
    if (!Array.isArray(m?.content)) continue;
    for (const c of m.content) {
      if (c?.type === "tool_result" && c.tool_use_id) seenToolUseIds.add(c.tool_use_id);
    }
  }

  // First not-yet-completed step.  If its `when` condition isn't met, we
  // stop — don't skip ahead, otherwise step ordering is meaningless.
  let stepToServe = null;
  for (const step of s.responses) {
    const tu = step.content?.find(c => c.type === "tool_use");
    if (!tu) continue;
    if (seenToolUseIds.has(tu.id)) continue;
    if (step.when && !whenSatisfied(step.when, messages)) break;
    stepToServe = step;
    break;
  }

  if (!stepToServe) {
    // All scripted steps done OR waiting on a condition — echo last result.
    const lastResult = lastToolResult(messages);
    if (lastResult) {
      const prefix = lastResult.isError ? "Tool error: " : "";
      return endTurn(prefix + lastResult.text);
    }
    return endTurn("[mock-llm] no actionable step");
  }

  const promptVars = extractVarsFromUserPrompt(messages);
  const toolResultVars = extractVarsFromToolResults(messages);
  const vars = { ...s.vars, ...toolResultVars, ...promptVars };

  // Log var provenance so stale presets (set-vars left over from a prior
  // run) are visible the moment they leak into a substitution.
  const provenance = Object.keys(vars).map(k => {
    if (k in promptVars) return `${k}=${vars[k]}(prompt)`;
    if (k in toolResultVars) return `${k}=${vars[k]}(tool_result)`;
    return `${k}=${vars[k]}(preset)`;
  }).join(" ");
  if (provenance) console.log(`[mock-llm] ${scenario} vars: ${provenance}`);

  const tmpl = JSON.parse(JSON.stringify(stepToServe));
  delete tmpl.when;
  deepSub(tmpl, vars);

  // Defensive: refuse to serve if any {PLACEHOLDER} is still in the
  // tool_use input.  The MCP tool would otherwise receive a literal
  // "{SESSION_CODE}" string and reject it, which is harder to debug.
  const missing = findUnsubstitutedPlaceholders(tmpl);
  if (missing.length) {
    return endTurn(
      `[mock-llm] missing var(s): ${missing.join(", ")} — pass them in the slash command (e.g. /hoop:join <code>) or POST /scenario/${scenario}/set-vars first`
    );
  }

  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 100, output_tokens: 50 },
    ...tmpl,
  };
}

// Step gate.  Today only `userMessageMatches` is supported — a regex string
// tested against the concatenated text of any user message in the history.
// Used by the host scenario's check_admissions step to fire only after the
// UserPromptSubmit hook injects "Peer X wants to join …".
function whenSatisfied(when, messages) {
  if (typeof when?.userMessageMatches === "string") {
    const re = new RegExp(when.userMessageMatches);
    for (const m of messages ?? []) {
      if (m?.role !== "user") continue;
      if (re.test(userMessageText(m))) return true;
    }
    return false;
  }
  return true;
}

function userMessageText(m) {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter(c => c?.type === "text" && typeof c.text === "string")
      .map(c => c.text)
      .join("\n");
  }
  return "";
}

// Walk every tool_result and pull well-known fields out of any JSON payload.
// Lets later steps reference values produced by earlier steps without the
// scenario file having to know IDs in advance.
//   sessionCode               → SESSION_CODE
//   listenAddresses[loopback] → HOST_ADDRESS  (prefer 127.0.0.1, else first)
//   requests[0].peerId        → PENDING_PEER_ID  (from hoop_check_admissions)
function extractVarsFromToolResults(messages) {
  const out = {};
  for (const m of messages ?? []) {
    if (!Array.isArray(m?.content)) continue;
    for (const block of m.content) {
      if (block?.type !== "tool_result") continue;
      let text = "";
      if (typeof block.content === "string") text = block.content;
      else if (Array.isArray(block.content)) {
        text = block.content
          .filter(c => c?.type === "text" && typeof c.text === "string")
          .map(c => c.text).join("\n");
      }
      let obj;
      try { obj = JSON.parse(text); } catch { continue; }
      if (!obj || typeof obj !== "object") continue;

      if (typeof obj.sessionCode === "string") out.SESSION_CODE = obj.sessionCode;
      if (Array.isArray(obj.listenAddresses) && obj.listenAddresses.length) {
        const loopback = obj.listenAddresses.find(
          a => typeof a === "string" && a.startsWith("/ip4/127.0.0.1/"));
        out.HOST_ADDRESS = loopback ?? obj.listenAddresses[0];
      }
      if (Array.isArray(obj.requests) && obj.requests.length > 0) {
        const peerId = obj.requests[0]?.peerId;
        if (typeof peerId === "string") out.PENDING_PEER_ID = peerId;
      }
    }
  }
  return out;
}

// Pull vars out of the user's most recent slash-command invocation.
// Claude Code expands `/hoop:join NAQ-BN5` into a user message containing:
//   <command-name>/hoop:join</command-name>
//   <command-args>NAQ-BN5</command-args>
// We parse that tag rather than the raw prompt because the prompt also
// includes the SKILL.md body and system reminders.
function extractVarsFromUserPrompt(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text).join("\n")
        : "";
    const argsMatch = text.match(/<command-args>([^<]*)<\/command-args>/);
    if (!argsMatch) continue;
    const args = argsMatch[1].trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) continue;
    const out = {};
    if (args[0]) out.SESSION_CODE = args[0];
    for (const a of args.slice(1)) {
      // Multiaddrs MUST start with `/` but users often forget — auto-prepend.
      const normalized = /^\/?(ip4|ip6|dns)\b/.test(a) && !a.startsWith("/")
        ? `/${a}` : a;
      if (normalized.startsWith("/ip") || normalized.startsWith("/dns")) {
        out.HOST_ADDRESS = normalized;
      }
    }
    return out;
  }
  return {};
}

function findUnsubstitutedPlaceholders(obj, found = new Set()) {
  if (!obj || typeof obj !== "object") return [...found];
  for (const v of Object.values(obj)) {
    if (typeof v === "string") {
      const matches = v.match(/\{([A-Z_]+)\}/g);
      if (matches) for (const m of matches) found.add(m.slice(1, -1));
    } else if (typeof v === "object") {
      findUnsubstitutedPlaceholders(v, found);
    }
  }
  return [...found];
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

// Walk messages in reverse and return the most recent tool_result.
// Returns { text, isError } or null.  The MCP server emits success results as
// content:[{type:"text",text:"..."}] and errors as a plain string content
// with is_error:true — handle both shapes.
function lastToolResult(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m?.content)) continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const block = m.content[j];
      if (block?.type !== "tool_result") continue;
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
