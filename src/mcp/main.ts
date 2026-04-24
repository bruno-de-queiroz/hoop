#!/usr/bin/env node

import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server";
import { createHoopMcpServer } from "./server.js";

const { server, gracefulShutdown } = createHoopMcpServer();

// Claude Code closes MCP server stdin after tool discovery in --print mode but
// still needs to call tools via the same stdio pair.  Piping through a
// PassThrough with { end: false } means the transport never sees EOF and stays
// alive to receive tool calls.
const persistentStdin = new PassThrough();
process.stdin.pipe(persistentStdin, { end: false });
const transport = new StdioServerTransport(persistentStdin as any, process.stdout);
await server.connect(transport);

// Keep the event loop alive after stdin closes so tool calls can still arrive.
const _keepAlive = setInterval(() => {}, 2_147_483_647);

let shuttingDown = false;

async function handleShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(_keepAlive);
  try {
    await gracefulShutdown();
  } catch {
    // Best-effort cleanup
  }
  process.exit(0);
}

process.on("SIGTERM", handleShutdown);
process.on("SIGINT", handleShutdown);
process.on("SIGUSR1", handleShutdown);
