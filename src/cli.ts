#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serve } from "@hono/node-server";
import { buildServer, createFetchHandler } from "./index.js";

async function startStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3100", 10);
  const hostsmithUrl = process.env.HOSTSMITH_URL ?? "https://hostsmith.net";
  const mcpBaseUrl = process.env.MCP_BASE_URL ?? `http://localhost:${port}`;

  const handler = createFetchHandler({ hostsmithUrl, mcpBaseUrl });

  serve({ fetch: handler, port }, () => {
    console.log(`Hostsmith MCP server listening on ${mcpBaseUrl}/mcp`);
  });
}

const mode = process.argv[2] ?? process.env.MCP_TRANSPORT ?? "stdio";

if (mode === "http") {
  startHttp().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
} else {
  startStdio().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
