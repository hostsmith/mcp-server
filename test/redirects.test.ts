import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createFetchHandler } from "../src/index.js";

// The redirect tools call the API through the SDK and answer its refusals
// unchanged, with the details an agent needs to correct its call.

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

let seen: Seen[] = [];
let reply: { status: number; body?: unknown } = { status: 200, body: {} };

const api = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    if (reply.body === undefined) {
      res.writeHead(reply.status).end();
      return;
    }
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
  seen = [];
  reply = { status: 200, body: {} };
});

function makeToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.sig`;
}

async function rpc(method: string, params: unknown) {
  const handler = createFetchHandler({ hostsmithUrl: "https://hostsmith.net", mcpBaseUrl: "http://localhost:3100" });
  const token = makeToken({ sub: "user-1", scope: "sites:read sites:write", homePartition: "us", exp: Math.floor(Date.now() / 1000) + 3600 });
  const res = await handler(
    new Request("http://localhost:3100/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const data = (await res.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data, "expected an SSE data line");
  return JSON.parse(data.slice("data: ".length)).result;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const result = await rpc("tools/call", { name, arguments: args });
  return { text: result.content[0].text, isError: result.isError };
}

test("lists the redirect tools, and the single-rule ones point bulk work to the batch ones", async () => {
  const { tools } = await rpc("tools/list", {});
  const names = tools.map((tool: { name: string }) => tool.name);
  for (const name of ["list_redirects", "set_redirects", "edit_redirects", "add_redirect", "delete_redirect", "switch_file_redirects", "test_redirect"]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  for (const name of ["add_redirect", "delete_redirect"]) {
    const description: string = tools.find((tool: { name: string }) => tool.name === name).description;
    assert.match(description, /set_redirects/);
    assert.match(description, /edit_redirects/);
  }
});

test("add_redirect posts the rule without a status, so the API's 301 default applies", async () => {
  reply = { status: 201, body: { rule: { id: "r_1", from: "/team", to: "/about#team", status: 301 }, version: 1 } };
  const result = await callTool("add_redirect", { siteId: "s1", from: "/team", to: "/about#team" });

  assert.notEqual(result.isError, true);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/v1/sites/s1/redirects");
  assert.deepEqual(seen[0].body, { from: "/team", to: "/about#team" });
  assert.equal(JSON.parse(result.text).rule.status, 301);
});

test("set_redirects replaces from text with the version as If-Match", async () => {
  await callTool("set_redirects", { siteId: "s1", text: "/old /new\n", version: 3 });

  assert.equal(seen[0].method, "PUT");
  assert.equal(seen[0].url, "/v1/sites/s1/redirects");
  assert.equal(seen[0].headers["if-match"], '"3"');
  assert.deepEqual(seen[0].body, { text: "/old /new\n" });
});

test("set_redirects refuses rules and text together, or neither, without calling the API", async () => {
  const both = await callTool("set_redirects", { siteId: "s1", text: "/a /b\n", rules: [] });
  const neither = await callTool("set_redirects", { siteId: "s1" });

  assert.equal(both.isError, true);
  assert.equal(neither.isError, true);
  assert.equal(seen.length, 0);
});

test("edit_redirects sends the operations as a batch", async () => {
  const operations = [
    { op: "add", rule: { from: "/a", to: "/b", status: 302 }, position: 0 },
    { op: "delete", id: "r_2" },
  ];
  await callTool("edit_redirects", { siteId: "s1", operations });

  assert.equal(seen[0].method, "PATCH");
  assert.equal(seen[0].url, "/v1/sites/s1/redirects");
  assert.equal(seen[0].headers["if-match"], undefined);
  assert.deepEqual(seen[0].body, { operations });
});

test("delete_redirect answers the deletion on a 204", async () => {
  reply = { status: 204 };
  const result = await callTool("delete_redirect", { siteId: "s1", ruleId: "r_1" });

  assert.notEqual(result.isError, true);
  assert.equal(seen[0].method, "DELETE");
  assert.equal(seen[0].url, "/v1/sites/s1/redirects/r_1");
  assert.match(result.text, /Deleted redirect rule r_1/);
});

test("switch_file_redirects and test_redirect call their routes", async () => {
  await callTool("switch_file_redirects", { siteId: "s1", enabled: false });
  await callTool("test_redirect", { siteId: "s1", path: "/team", draftText: "/team /about\n" });

  assert.equal(seen[0].method, "PUT");
  assert.equal(seen[0].url, "/v1/sites/s1/redirects/file-rules");
  assert.deepEqual(seen[0].body, { enabled: false });
  assert.equal(seen[1].method, "POST");
  assert.equal(seen[1].url, "/v1/sites/s1/redirects/test");
  assert.deepEqual(seen[1].body, { path: "/team", draftText: "/team /about\n" });
});

test("a refusal passes through with its code, message and details", async () => {
  const errors = [{ index: 0, field: "status", code: "UNSUPPORTED_STATUS", message: "Status 200 is not supported: use 301, 302, 303, 307 or 308" }];
  reply = { status: 400, body: { error: "InvalidRules", message: "Some rules are invalid, and nothing was saved", errors, errorCount: 1 } };
  const result = await callTool("set_redirects", { siteId: "s1", rules: [{ from: "/a", to: "/b", status: 200 }] });

  assert.equal(result.isError, true);
  assert.equal(result.text.split("\n")[0], "API error 400 (InvalidRules): Some rules are invalid, and nothing was saved");
  assert.deepEqual(JSON.parse(result.text.slice(result.text.indexOf("\n") + 1)), { errors, errorCount: 1 });
});
