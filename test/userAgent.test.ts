import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createFetchHandler, PKG_VERSION } from "../src/index.js";

// Every public API call the tools make through @hostsmith/sdk identifies the
// MCP server in its User-Agent, ahead of the SDK's own product token.

const userAgents: (string | undefined)[] = [];
const api = createServer((req, res) => {
  userAgents.push(req.headers["user-agent"]);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sites: [] }));
});

before(async () => {
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  process.env.HOSTSMITH_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(async () => {
  delete process.env.HOSTSMITH_BASE_URL;
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

function makeToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.sig`;
}

test("tool calls send User-Agent: hostsmith-mcp-server/<version> hostsmith-js-sdk/<version>", async () => {
  const handler = createFetchHandler({ hostsmithUrl: "https://hostsmith.net", mcpBaseUrl: "http://localhost:3100" });
  const token = makeToken({ sub: "user-1", scope: "sites:read", homePartition: "us", exp: Math.floor(Date.now() / 1000) + 3600 });

  const res = await handler(
    new Request("http://localhost:3100/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sites", arguments: {} } }),
    }),
  );
  await res.text();

  // list_sites without a partition asks every partition; each call counts.
  assert.ok(userAgents.length > 0);
  const escaped = PKG_VERSION.replace(/\./g, "\\.");
  for (const userAgent of userAgents) {
    assert.match(userAgent ?? "", new RegExp(`^hostsmith-mcp-server/${escaped} hostsmith-js-sdk/\\S+$`));
  }
});
