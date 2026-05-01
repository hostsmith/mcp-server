// Smoke test: import createApp from the built package, start the Express app
// on an ephemeral port, hit the protected-resource discovery doc, shut down.
// Exits non-zero on any failure.

import { createApp } from "../dist/index.js";
import { createServer } from "node:http";

const app = createApp({
  hostsmithUrl: "https://hostsmith.net",
  mcpBaseUrl: "http://localhost:0",
});

const server = createServer(app);
await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();
const baseUrl = `http://localhost:${port}`;

try {
  const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  if (!res.ok) {
    throw new Error(`discovery doc returned ${res.status}`);
  }
  const body = await res.json();
  if (!body.resource) {
    throw new Error("discovery doc missing 'resource' field");
  }
  console.log("smoke OK:", baseUrl, body.resource);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
