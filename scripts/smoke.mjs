// Smoke test: import createFetchHandler from the built package, hit the
// protected-resource discovery doc as a synthetic Web Standard Request.
// No network or sockets — pure in-process. Exits non-zero on any failure.

import { createFetchHandler, getProtectedResourceMetadata, OAUTH_SCOPES } from "../dist/index.js";

const baseUrl = "http://localhost:3100";
const handler = createFetchHandler({
  hostsmithUrl: "https://hostsmith.net",
  mcpBaseUrl: baseUrl,
});

const res = await handler(new Request(`${baseUrl}/.well-known/oauth-protected-resource`));
if (!res.ok) {
  throw new Error(`discovery doc returned ${res.status}`);
}
const body = await res.json();
if (body.resource !== baseUrl) {
  throw new Error(`discovery doc 'resource' mismatch: got ${body.resource}, want ${baseUrl}`);
}
if (!Array.isArray(body.scopes_supported) || body.scopes_supported.length === 0) {
  throw new Error("discovery doc missing scopes_supported");
}

// Helper-export sanity checks.
const meta = getProtectedResourceMetadata({ mcpBaseUrl: baseUrl, hostsmithUrl: "https://hostsmith.net" });
if (meta.resource !== baseUrl) throw new Error("metadata helper resource mismatch");
if (OAUTH_SCOPES.length === 0) throw new Error("OAUTH_SCOPES export empty");

console.log("smoke OK:", body.resource, OAUTH_SCOPES.length, "scopes");
