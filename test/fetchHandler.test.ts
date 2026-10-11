import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createFetchHandler } from "../src/index.js";
import type { OnServerContext } from "../src/index.js";

const BASE = "http://localhost:3100";
const OPTIONS = { hostsmithUrl: "https://hostsmith.net", mcpBaseUrl: BASE };

function makeToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.sig`;
}

const CLAIMS = {
  sub: "user-1",
  client_id: "https://claude.ai/oauth/mcp-client",
  scope: "sites:read",
  homePartition: "eu",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

function toolsList(authorization?: string): Request {
  return new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

/** The JSON-RPC message of a single-response SSE stream. */
async function rpcMessage(res: Response): Promise<any> {
  const data = (await res.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data, "response carries an SSE data line");
  return JSON.parse(data.slice("data: ".length));
}

test("onServer receives the request's server and claims before it handles the request", async () => {
  const calls: { server: McpServer; context: OnServerContext; connected: boolean }[] = [];
  const handler = createFetchHandler({
    ...OPTIONS,
    onServer: async (server, context) => {
      calls.push({ server, context, connected: server.isConnected() });
    },
  });

  const res = await handler(toolsList(`Bearer ${makeToken(CLAIMS)}`));

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].server instanceof McpServer);
  assert.equal(calls[0].connected, false);
  assert.deepEqual(calls[0].context.claims, CLAIMS);
  assert.ok((await rpcMessage(res)).result.tools.length > 0);
});

test("onServer gets a new server per request", async () => {
  const servers: McpServer[] = [];
  const handler = createFetchHandler({ ...OPTIONS, onServer: (server) => void servers.push(server) });

  await (await handler(toolsList(`Bearer ${makeToken(CLAIMS)}`))).text();
  await (await handler(toolsList(`Bearer ${makeToken(CLAIMS)}`))).text();

  assert.equal(servers.length, 2);
  assert.notEqual(servers[0], servers[1]);
});

test("onServer is not called for an unauthenticated request", async () => {
  let called = false;
  const handler = createFetchHandler({ ...OPTIONS, onServer: () => void (called = true) });

  const missing = await handler(toolsList());
  const malformed = await handler(toolsList("Bearer not-a-jwt"));

  assert.equal(missing.status, 401);
  assert.equal(malformed.status, 401);
  assert.equal(called, false);
});

test("a hook that throws leaves the response unchanged", async () => {
  const authorization = `Bearer ${makeToken(CLAIMS)}`;
  const plain = await rpcMessage(await createFetchHandler(OPTIONS)(toolsList(authorization)));
  const throwing = createFetchHandler({
    ...OPTIONS,
    onServer: async () => {
      throw new Error("analytics down");
    },
  });

  const res = await throwing(toolsList(authorization));

  assert.equal(res.status, 200);
  assert.deepEqual(await rpcMessage(res), plain);
});

test("without a hook, tools/list works as before", async () => {
  const res = await createFetchHandler(OPTIONS)(toolsList(`Bearer ${makeToken(CLAIMS)}`));

  assert.equal(res.status, 200);
  const names = (await rpcMessage(res)).result.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("list_sites"));
  assert.ok(names.includes("deploy_files"));
});
