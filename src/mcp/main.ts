#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server";
import { createHoopMcpServer } from "./server.js";

const { server } = createHoopMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
