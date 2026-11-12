import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createFetchHandler } from "../src/index.js";

// A redirect host is a site created with kind "redirect": create_site passes
// the kind on, and the deploy tools answer the API's refusal unchanged.

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

const api = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    seen.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : undefined });
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

test("create_site takes the kind of site", async () => {
  const { tools } = await rpc("tools/list", {});
  const createSite = tools.find((tool: { name: string }) => tool.name === "create_site");
  assert.deepEqual(createSite.inputSchema.properties.kind.enum, ["site", "redirect"]);
  assert.ok(!createSite.inputSchema.required.includes("kind"));
});

test("create_site sends the kind of a redirect host, and no kind when omitted", async () => {
  reply = { status: 201, body: { siteId: "h1" } };
  await callTool("create_site", { domain: "example.com", subdomain: "go", kind: "redirect" });
  await callTool("create_site", { domain: "example.com", subdomain: "www" });

  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/v1/sites");
  assert.deepEqual(seen[0].body, { domain: "example.com", subdomain: "go", kind: "redirect" });
  assert.deepEqual(seen[1].body, { domain: "example.com", subdomain: "www" });
});

test("a redirect host on a shared domain is refused with the API's code", async () => {
  reply = { status: 409, body: { error: "CustomDomainRequired", message: "Redirect hosts work only on the organization's own custom domains" } };
  const result = await callTool("create_site", { domain: "us.hostsmith.link", subdomain: "go", kind: "redirect" });

  assert.equal(result.isError, true);
  assert.equal(result.text, "API error 409 (CustomDomainRequired): Redirect hosts work only on the organization's own custom domains");
});

test("deploy_files to a redirect host answers RedirectHostHasNoFiles", async () => {
  reply = { status: 409, body: { error: "RedirectHostHasNoFiles", message: "Redirect hosts have no files: change their redirect rules instead" } };
  const result = await callTool("deploy_files", { siteId: "h1", files: [{ fileName: "index.html", content: "<h1>Hi</h1>" }] });

  assert.equal(seen[0].url, "/v1/sites/h1/uploads");
  assert.equal(result.isError, true);
  assert.equal(result.text, "API error 409 (RedirectHostHasNoFiles): Redirect hosts have no files: change their redirect rules instead");
});
