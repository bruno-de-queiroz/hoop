#!/usr/bin/env node
// Minimal MCP server that proves whether Claude Code supports the
// server-initiated elicitation/create flow.  One tool: `probe_elicit`.
// When invoked, the server pushes an elicitInput request back to the client
// and logs the result (or error) to stderr.  Stderr is plumbed to the
// caller, so we can see exactly how Claude Code answers.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const log = (...a) => console.error("[probe]", ...a);

const mcp = new McpServer({ name: "elicit-probe", version: "0.0.1" });

mcp.registerTool(
  "probe_elicit",
  {
    description: "Probe Claude Code's elicitation client support. Pushes an elicitInput request and returns the verbatim response.",
    inputSchema: z.object({}),
  },
  async () => {
    log("about to call server.elicitInput(...)");
    try {
      const result = await mcp.server.elicitInput({
        message: "Probe: do you accept this elicitation? (any answer is fine)",
        requestedSchema: {
          type: "object",
          properties: {
            accept: { type: "boolean", description: "Accept the probe" },
            note:   { type: "string",  description: "Optional note" },
          },
          required: ["accept"],
        },
      });
      log("elicitInput returned:", JSON.stringify(result));
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, result }) }],
      };
    } catch (err) {
      log("elicitInput threw:", err?.name, err?.message, err?.code);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: { name: err?.name, message: err?.message, code: err?.code },
          }),
        }],
      };
    }
  },
);

await mcp.connect(new StdioServerTransport());
log("server connected");
