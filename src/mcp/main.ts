#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server";
import { createHoopMcpServer } from "./server.js";

const { server, gracefulShutdown } = createHoopMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);

let shuttingDown = false;

async function handleShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
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
