// Smoke test: import createFetchHandler from the built package, hit the
// protected-resource discovery doc as a synthetic Web Standard Request.
// No network or sockets - pure in-process. Exits non-zero on any failure.

import { createFetchHandler, getProtectedResourceMetadata, getServerCard, MCP_SERVER_CARD_PATH, OAUTH_SCOPES, SERVER_INSTRUCTIONS } from "../dist/index.js";

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

// Server instructions sanity: must exist, be reasonably short, and cover the
// rules the model is expected to follow cross-tool.
if (typeof SERVER_INSTRUCTIONS !== "string" || SERVER_INSTRUCTIONS.length === 0) {
  throw new Error("SERVER_INSTRUCTIONS export empty");
}
if (SERVER_INSTRUCTIONS.length > 4000) {
  throw new Error(`SERVER_INSTRUCTIONS too long: ${SERVER_INSTRUCTIONS.length} chars (target <=4000)`);
}
for (const phrase of ["get_account", "list_domains", "deploy_files", "deploy_create_upload", "deploy_finalize", "delete_site", "partition"]) {
  if (!SERVER_INSTRUCTIONS.includes(phrase)) {
    throw new Error(`SERVER_INSTRUCTIONS missing expected phrase: ${phrase}`);
  }
}

// Server card via HTTP route (handler).
const cardRes = await handler(new Request(`${baseUrl}${MCP_SERVER_CARD_PATH}`));
if (cardRes.status !== 200) {
  throw new Error(`server-card route returned ${cardRes.status}`);
}
if (!(cardRes.headers.get("content-type") ?? "").includes("application/json")) {
  throw new Error(`server-card content-type: ${cardRes.headers.get("content-type")}`);
}
const cacheControl = cardRes.headers.get("cache-control") ?? "";
if (!cacheControl.includes("public") || !cacheControl.includes("max-age=") || !cacheControl.includes("stale-while-revalidate=")) {
  throw new Error(`server-card cache-control missing directives: ${cacheControl}`);
}
const card = await cardRes.json();
if (card.name !== "io.github.hostsmith/mcp-server") throw new Error(`card name mismatch: ${card.name}`);
if (!card.version) throw new Error("card version missing");
if (!Array.isArray(card.transports) || card.transports[0]?.type !== "streamable-http" || card.transports[0]?.url !== `${baseUrl}/mcp`) {
  throw new Error(`card transports mismatch: ${JSON.stringify(card.transports)}`);
}
if (!card.auth || card.auth.type !== "oauth2") throw new Error("card auth missing or wrong type");
if (card.auth.protectedResourceMetadata !== `${baseUrl}/.well-known/oauth-protected-resource`) {
  throw new Error(`card auth.protectedResourceMetadata mismatch: ${card.auth.protectedResourceMetadata}`);
}
if (!Array.isArray(card.auth.scopesSupported) || card.auth.scopesSupported.length !== OAUTH_SCOPES.length) {
  throw new Error("card auth.scopesSupported mismatch");
}

// Helper directly: prod and dev base URLs.
for (const [mcpBaseUrl, hostsmithUrl] of [
  ["https://mcp.hostsmith.net", "https://hostsmith.net"],
  ["https://mcp.hostsmith-dev.com", "https://hostsmith-dev.com"],
]) {
  const c = getServerCard({ mcpBaseUrl, hostsmithUrl });
  if (c.transports[0].url !== `${mcpBaseUrl}/mcp`) throw new Error(`getServerCard transport url mismatch for ${mcpBaseUrl}`);
  if (c.auth.protectedResourceMetadata !== `${mcpBaseUrl}/.well-known/oauth-protected-resource`) {
    throw new Error(`getServerCard auth.protectedResourceMetadata mismatch for ${mcpBaseUrl}`);
  }
  if (c.auth.scopesSupported.length !== OAUTH_SCOPES.length) throw new Error("getServerCard scopesSupported length mismatch");
  if (!c.icons?.[0]?.src?.startsWith(hostsmithUrl)) throw new Error(`getServerCard icon src mismatch for ${hostsmithUrl}`);
}

console.log("smoke OK:", body.resource, OAUTH_SCOPES.length, "scopes,", SERVER_INSTRUCTIONS.length, "chars instructions, card", card.version);
