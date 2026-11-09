import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createFetchHandler } from "../src/index.js";

// get_account asks every partition for the account. Each one answers the
// organization's site and storage counts, so they're taken from one answer;
// custom domains are counted per partition, so they're added up.

let accountCalls = 0;
const api = createServer((req, res) => {
  assert.equal(req.url, "/v1/account");
  accountCalls += 1;
  const account = {
    orgId: "org-1",
    orgName: "Acme",
    user: { homePartition: "us" },
    plan: { title: "Pro", sitesLimit: 10, domainsLimit: 5, uploadLimit: 1, storageLimit: 1, dataResidencySelector: true },
    // One custom domain in the first partition to answer, two in the second
    usage: { sites: 4, domains: accountCalls, storage: 1000 },
  };
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ account }));
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

test("get_account takes sites and storage from one partition and adds up domains", async () => {
  const handler = createFetchHandler({ hostsmithUrl: "https://hostsmith.net", mcpBaseUrl: "http://localhost:3100" });
  const token = makeToken({ sub: "user-1", scope: "account:read", homePartition: "us", exp: Math.floor(Date.now() / 1000) + 3600 });

  const res = await handler(
    new Request("http://localhost:3100/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_account", arguments: {} } }),
    }),
  );
  const data = (await res.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data, "expected an SSE data line");
  const result = JSON.parse(data.slice("data: ".length)).result;

  assert.equal(accountCalls, 2);
  assert.notEqual(result.isError, true);
  const account = JSON.parse(result.content[0].text);
  assert.deepEqual(account.usage, { sites: 4, domains: 3, storage: 1000 });
});
