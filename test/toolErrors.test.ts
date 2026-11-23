import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createFetchHandler } from "../src/index.js";

// Every tool error is logged as one JSON line: the tool, the API's status
// and code, the site id and the org id prefix, never the message. The
// agent gets the API's message and fields as they are.

let reply: { status: number; body: unknown } = { status: 200, body: {} };

const api = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  });
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

beforeEach(() => {
  reply = { status: 200, body: {} };
});

function makeToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.sig`;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const handler = createFetchHandler({ hostsmithUrl: "https://hostsmith.net", mcpBaseUrl: "http://localhost:3100" });
  const token = makeToken({
    sub: "user-1",
    org: "81c3b617-0000-4000-8000-000000000000",
    scope: "sites:read sites:write files:write",
    homePartition: "us",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const res = await handler(
    new Request("http://localhost:3100/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const data = (await res.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data, "expected an SSE data line");
  const result = JSON.parse(data.slice("data: ".length)).result;
  return { text: result.content[0].text, isError: result.isError };
}

test("an upload over the plan's limit is logged, and the agent gets the API's explanation", async () => {
  const message =
    "This upload is 12.3 MB. The Free plan takes uploads up to 5 MB; Starter 50 MB. See https://hostsmith.net/pricing/";
  reply = {
    status: 413,
    body: { error: "PayloadTooLarge", message, limitBytes: 5242880, requestedBytes: 12897484, plan: "Free" },
  };
  const warn = mock.method(console, "warn", () => {});
  try {
    const result = await callTool("deploy_create_upload", {
      siteId: "db1a8c5c-site",
      files: [{ fileName: "holiday-photos.zip", fileSize: 12897484 }],
    });

    assert.equal(result.isError, true);
    assert.ok(result.text.startsWith(`API error 413 (PayloadTooLarge): ${message}`));
    assert.match(result.text, /"limitBytes": 5242880/);

    const lines = warn.mock.calls.map((call) => String(call.arguments[0]));
    const line = lines.find((l) => l.includes('"tool error"'));
    assert.ok(line, "expected a tool error line");
    assert.deepEqual(JSON.parse(line), {
      level: "warn",
      msg: "tool error",
      tool: "deploy_create_upload",
      status: 413,
      code: "PayloadTooLarge",
      siteId: "db1a8c5c-site",
      orgIdPrefix: "81c3b617",
    });
    assert.ok(!line.includes("holiday"), "no file names");
    assert.ok(!line.includes("12.3 MB"), "no message");
  } finally {
    warn.mock.restore();
  }
});
