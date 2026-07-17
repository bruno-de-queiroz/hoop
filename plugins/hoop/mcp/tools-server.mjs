#!/usr/bin/env node
// hoop tools MCP server — a zero-dependency stdio JSON-RPC server that re-provides
// the interactive tools headless `claude -p` DROPS (they're TUI-only). Confirmed
// absent from the init tool list in every permission mode, not ToolSearch-findable:
//
//   submit_plan(plan)       — submit an implementation plan for human review.
//   enter_plan_mode()       — switch the session into read-only plan mode.
//   ask_user_question(...)  — ask the operator a multiple-choice question and
//                             block until they answer (native AskUserQuestion is
//                             absent in headless mode, so the model has no way to
//                             ask a structured question without this).
//
// Why this exists: without these, the model hunts for the native tool, fails, and
// falls back to prose (e.g. "AskUserQuestion isn't available"). Bundling this
// server (via the plugin's .mcp.json) gives the model tools that actually exist.
//
// Declaration-only: in normal operation the hoop PreToolUse permission gate
// intercepts these tool calls and drives the real behavior — plan capture /
// plan-mode flip / surfacing the question to the dashboard + relaying the answer
// — then answers the call itself. So `tools/call` here never actually runs. We
// still implement it (a benign ack) so the server is correct if a call ever
// reaches it (e.g. gate disabled). The sandbox gate is the single policy authority.
//
// Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0. We handle exactly
// what a client needs: initialize, notifications/initialized, tools/list,
// tools/call, and ping. stdout carries ONLY protocol messages; anything else
// goes to stderr.

import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "submit_plan",
    description:
      "Submit your implementation plan for human review. Call this when you've " +
      "finished investigating and are ready to propose a plan. The session stays " +
      "read-only until a human approves the plan; on approval you'll be asked to " +
      "proceed, on rejection you'll get feedback to revise. Pass the full plan as " +
      "the `plan` argument (a concise numbered list of steps, the files/areas " +
      "you'd touch, and how you'd verify it) — do not just describe it in prose.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The implementation plan, as markdown." },
      },
      required: ["plan"],
      additionalProperties: false,
    },
  },
  {
    name: "enter_plan_mode",
    description:
      "Switch this session into read-only plan mode: you may only investigate " +
      "(Read/Grep/Glob) — edits, shell commands, and subagents are blocked — and " +
      "must call submit_plan with your plan before anything can change. Use this " +
      "when a task is complex enough to warrant proposing a plan first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ask_user_question",
    description:
      "Ask the operator a multiple-choice question and BLOCK until they answer — " +
      "use this instead of asking in prose whenever you need the user to choose " +
      "between options or confirm a decision you can't resolve yourself. Their " +
      "answer comes back as the next user message. (This is the headless " +
      "equivalent of the native AskUserQuestion tool.) Provide 1-4 questions, each " +
      "with 2-4 concrete options.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The full question to ask." },
              header: { type: "string", description: "Short label/chip for the question (<=12 chars)." },
              multiSelect: { type: "boolean", description: "Allow selecting multiple options." },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "The choice text." },
                    description: { type: "string", description: "What this option means / its trade-off." },
                  },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
            },
            required: ["question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg) {
  // Notifications have no id and expect no response.
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize": {
      const clientProto = msg.params?.protocolVersion;
      reply(msg.id, {
        // Echo the client's protocol version when provided so we never mismatch.
        protocolVersion: typeof clientProto === "string" ? clientProto : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "hoop-tools", version: "0.1.0" },
      });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return; // notification, no reply
    case "ping":
      if (!isNotification) reply(msg.id, {});
      return;
    case "tools/list":
      reply(msg.id, { tools: TOOLS });
      return;
    case "tools/call": {
      // Normally unreachable — the gate denies the call before dispatch. If it
      // does run, return a harmless ack rather than erroring.
      const name = msg.params?.name;
      const text =
        name === "submit_plan"
          ? "Plan received."
          : name === "enter_plan_mode"
            ? "Plan mode requested."
            : name === "ask_user_question"
              ? "Question received."
              : `Unknown tool: ${name}`;
      reply(msg.id, { content: [{ type: "text", text }] });
      return;
    }
    default:
      if (!isNotification) replyError(msg.id, -32601, `method not found: ${msg.method}`);
      return;
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON lines
  }
  try {
    handle(msg);
  } catch (e) {
    process.stderr.write(`[hoop-plan] handler error: ${String(e?.message ?? e)}\n`);
    if (msg && msg.id != null) replyError(msg.id, -32603, "internal error");
  }
});
rl.on("close", () => process.exit(0));
