#!/usr/bin/env node
// Stdio entry point — for Claude Desktop and other local stdio MCP clients.
// Reads config from process.env (CLIENT_ID, CLIENT_SECRET, ORG_ID, SANDBOX_NAME, …).

import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, getConfig, describeMissingConfig } from "./server.js";

const config = getConfig();
const missing = describeMissingConfig(config);
if (missing.length) {
  console.error(`[exd-mcp] ⚠️  Missing required env vars: ${missing.join(", ")}`);
  console.error(`[exd-mcp]    Server will start anyway; tool calls will fail until these are set or passed as headers.`);
}

const server    = buildMcpServer(config);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[exd-mcp] stdio transport ready (sandbox: ${config.SANDBOX_NAME || "unset"})`);
