import { readFileSync } from "node:fs";
import { OAUTH_SCOPES } from "./index.js";

export const MCP_SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";

interface ServerJson {
  name: string;
  version: string;
  description: string;
  repository?: { url: string; source: string };
  packages?: Array<{ registryType: string; identifier: string }>;
}

const SERVER_JSON: ServerJson = (() => {
  const path = new URL("../server.json", import.meta.url);
  return JSON.parse(readFileSync(path, "utf-8")) as ServerJson;
})();

export interface ServerCardOptions {
  mcpBaseUrl: string;
  hostsmithUrl: string;
}

export function getServerCard(opts: ServerCardOptions) {
  const { mcpBaseUrl, hostsmithUrl } = opts;
  const packages = (SERVER_JSON.packages ?? []).map((p) => ({
    registry: p.registryType,
    name: p.identifier,
  }));
  return {
    schemaVersion: "2025-07-09",
    name: SERVER_JSON.name,
    displayName: "Hostsmith",
    description: SERVER_JSON.description,
    version: SERVER_JSON.version,
    websiteUrl: `${hostsmithUrl}/docs/mcp/quick-start/`,
    ...(SERVER_JSON.repository ? { repository: SERVER_JSON.repository } : {}),
    icons: [
      {
        src: `${hostsmithUrl}/img/icons/android-chrome-512x512.png`,
        sizes: "512x512",
        type: "image/png",
      },
    ],
    transports: [
      { type: "streamable-http", url: `${mcpBaseUrl}/mcp` },
    ],
    auth: {
      type: "oauth2",
      authorizationServer: hostsmithUrl,
      protectedResourceMetadata: `${mcpBaseUrl}/.well-known/oauth-protected-resource`,
      scopesSupported: [...OAUTH_SCOPES],
    },
    packages,
  };
}
