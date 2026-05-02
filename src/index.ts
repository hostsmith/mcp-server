import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { Hostsmith, ApiError } from "@hostsmith/sdk";
import type { Partition } from "@hostsmith/sdk";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, posix, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Hono } from "hono";
import { readFileSync } from "node:fs";

export const PKG_VERSION: string = (() => {
  // Resolve package.json relative to the compiled dist/ or source src/ dir
  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version;
})();

const ALL_PARTITIONS: Partition[] = ["us", "eu"];

const partitionSchema = z
  .enum(["us", "eu"])
  .describe('Hostsmith data partition: "us" (United States) or "eu" (European Union)');

// HOSTSMITH_API_DOMAIN overrides the SDK's hardcoded hostsmith.net domain
// across both partitions (e.g. "hostsmith.net" →
// "https://us.api.hostsmith.net", "https://eu.api.hostsmith.net").
// Falls back to HOSTSMITH_BASE_URL for a single-host override, then to the
// SDK's built-in prod URLs.
function partitionUrlsFromEnv(): Partial<Record<Partition, string>> | undefined {
  const apiDomain = process.env.HOSTSMITH_API_DOMAIN;
  if (!apiDomain) return undefined;
  return {
    us: `https://us.api.${apiDomain}`,
    eu: `https://eu.api.${apiDomain}`,
  };
}

function createClient(token: string, partition?: Partition): Hostsmith {
  const p = partition ?? (process.env.HOSTSMITH_PARTITION as Partition) ?? "us";
  const baseUrl = process.env.HOSTSMITH_BASE_URL;
  if (baseUrl) {
    return new Hostsmith({ accessToken: token, baseUrl });
  }
  const partitionUrls = partitionUrlsFromEnv();
  return new Hostsmith({
    accessToken: token,
    partition: p,
    ...(partitionUrls ? { partitionUrls } : {}),
  });
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    return `API error ${err.status} (${err.errorCode}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function readDirectory(
  dirPath: string,
): Promise<{ fileName: string; content: Buffer }[]> {
  const entries = await readdir(dirPath, {
    recursive: true,
    withFileTypes: true,
  });
  const files: { fileName: string; content: Buffer }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = join(entry.parentPath, entry.name);
    const relativePath = relative(dirPath, fullPath);
    const fileName = relativePath.split("\\").join(posix.sep);
    const content = await readFile(fullPath);
    files.push({ fileName, content });
  }
  return files;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const payload = Buffer.from(parts[1], "base64url").toString();
  return JSON.parse(payload);
}

function getToken(extra: { authInfo?: AuthInfo }): string {
  if (extra.authInfo?.token) return extra.authInfo.token;
  const envToken = process.env.HOSTSMITH_ACCESS_TOKEN;
  if (envToken) return envToken;
  throw new Error(
    "No access token available. Set HOSTSMITH_ACCESS_TOKEN or use OAuth.",
  );
}

export function buildServer(): McpServer {
  const server = new McpServer({
    name: "hostsmith",
    version: PKG_VERSION,
  });

  server.tool(
    "list_sites",
    "List all sites in your Hostsmith account in a given data partition (us or eu).",
    { partition: partitionSchema },
    async ({ partition }, extra) => {
      try {
        const client = createClient(getToken(extra), partition);
        const { sites } = await client.sites.list();
        return {
          content: [{ type: "text", text: JSON.stringify(sites, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "list_domains",
    "List available domains. Returns shared hosting domains (available to all) and custom domains owned by your organization. When partition is omitted, queries all data partitions and merges results. Use the shared filter to narrow results. Each domain includes `canonicalServedUrl` (the URL where the site is actually served - for apex-enabled domains this is `https://www.<apex>` because the bare apex 301-redirects via apex-link) and `bareApexCovered` (whether the bare apex form is reachable; true only when `enableApexDomain` is true).",
    {
      partition: partitionSchema
        .optional()
        .describe('Filter by data partition. Omit to query all partitions.'),
      shared: z
        .boolean()
        .optional()
        .describe("Filter by domain type: true for shared only, false for custom only. Omit for both."),
    },
    async ({ partition, shared }, extra) => {
      try {
        const token = getToken(extra);
        const listParams = shared !== undefined ? { shared } : undefined;
        const partitions: Partition[] = partition ? [partition] : ALL_PARTITIONS;

        const results = await Promise.all(
          partitions.map(async (p) => {
            const client = createClient(token, p);
            const { domains } = await client.domains.list(listParams);
            return domains;
          }),
        );

        const domains = results.flat();
        return {
          content: [{ type: "text", text: JSON.stringify(domains, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_account",
    "Get account info including organization details, subscription plan with limits, and usage counts aggregated across all data partitions.",
    {},
    async (_params, extra) => {
      try {
        const token = getToken(extra);

        const results = await Promise.all(
          ALL_PARTITIONS.map(async (p) => {
            const client = createClient(token, p);
            return client.account.get();
          }),
        );

        // Use the first partition's account as base, sum usage across partitions.
        // Drop `partition` on the merged view since usage is aggregated across all of them.
        const base = results[0].account;
        for (let i = 1; i < results.length; i++) {
          base.usage.sites += results[i].account.usage.sites;
          base.usage.domains += results[i].account.usage.domains;
        }
        base.partition = null;

        return {
          content: [{ type: "text", text: JSON.stringify(base, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_site",
    "Get details of a specific site in a given data partition",
    {
      siteId: z.string().describe("The site ID"),
      partition: partitionSchema,
    },
    async ({ siteId, partition }, extra) => {
      try {
        const client = createClient(getToken(extra), partition);
        const site = await client.sites.get(siteId);
        return {
          content: [{ type: "text", text: JSON.stringify(site, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "create_site",
    "Create a new site on Hostsmith in a specific data partition (us or eu)",
    {
      domain: z
        .string()
        .describe(
          'The domain for the site (e.g. "us.hostsmith.link" or "eu.hostsmith.link")',
        ),
      subdomain: z
        .string()
        .optional()
        .describe('Optional subdomain (auto-generated if omitted). To create a site at the apex of an apex-enabled custom domain, pass `subdomain: "www"` — the canonical served hostname for any apex domain is `www.<apex>` (the bare apex itself is served via apex-link redirect to the www form).'),
      partition: partitionSchema,
    },
    async ({ domain, subdomain, partition }, extra) => {
      try {
        const client = createClient(getToken(extra), partition);
        const result = await client.sites.create({ domain, subdomain });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "delete_site",
    "Delete a site from Hostsmith. Pass the data partition the site lives in.",
    {
      siteId: z.string().describe("The site ID to delete"),
      partition: partitionSchema,
    },
    async ({ siteId, partition }, extra) => {
      try {
        const client = createClient(getToken(extra), partition);
        const result = await client.sites.delete(siteId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "deploy_path",
    "Deploy a local file or directory to a Hostsmith site. If path is a file, uploads that single file. If path is a directory, reads all files recursively and uploads them. For large directories, consider compressing to a zip first.",
    {
      siteId: z.string().describe("The site ID to deploy to"),
      path: z
        .string()
        .describe("Absolute path to a file or directory to deploy"),
      partition: partitionSchema,
    },
    async ({ siteId, path: path, partition }, extra) => {
      try {
        const client = createClient(getToken(extra), partition);
        const info = await stat(path);
        let files: { fileName: string; content: Buffer }[];

        if (info.isFile()) {
          files = [
            {
              fileName: basename(path),
              content: await readFile(path),
            },
          ];
        } else {
          files = await readDirectory(path);
        }

        if (files.length === 0) {
          return {
            content: [{ type: "text", text: "No files found in: " + path }],
            isError: true,
          };
        }

        const totalSize = files.reduce((sum, f) => sum + f.content.length, 0);
        if (files.length > 50) {
          return {
            content: [
              {
                type: "text",
                text: `Directory contains ${files.length} files (${(totalSize / 1024 / 1024).toFixed(1)} MB). Consider compressing to a zip file first for faster uploads.`,
              },
            ],
            isError: true,
          };
        }

        const result = await client.sites.deploy(siteId, files);
        const site = await client.sites.get(siteId);
        const url = `https://${site.subdomain}.${site.domain}`;
        return {
          content: [
            {
              type: "text",
              text: `Deployed ${files.length} file(s) to ${url}. Version: ${result.versionId}, Status: ${result.status}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "deploy_files",
    "Deploy inline file contents to a Hostsmith site. Useful for deploying generated content without writing to disk.",
    {
      siteId: z.string().describe("The site ID to deploy to"),
      files: z
        .array(
          z.object({
            fileName: z
              .string()
              .describe("File path relative to site root (e.g. index.html)"),
            content: z.string().describe("The file content as a string"),
          }),
        )
        .describe("Array of files to deploy"),
      partition: partitionSchema,
    },
    async ({ siteId, files, partition }, extra) => {
      try {
        const client = createClient(getToken(extra), partition);
        const deployFiles = files.map((f) => ({
          fileName: f.fileName,
          content: Buffer.from(f.content),
        }));
        const result = await client.sites.deploy(siteId, deployFiles);
        return {
          content: [
            {
              type: "text",
              text: `Deployed ${files.length} file(s). Version: ${result.versionId}, Status: ${result.status}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

/** Supported OAuth scopes for the Hostsmith MCP server. */
export const OAUTH_SCOPES = [
  "sites:read",
  "sites:write",
  "domains:read",
  "files:write",
  "account:read",
] as const;

export interface MetadataOptions {
  /** Public URL where this MCP server is reachable (e.g. "https://mcp.hostsmith.net"). */
  mcpBaseUrl: string;
  /** Hostsmith app URL acting as the OAuth authorization server. */
  hostsmithUrl: string;
}

/**
 * RFC 9728 protected-resource metadata. Mount the result at
 * `/.well-known/oauth-protected-resource` from the consumer side.
 */
export function getProtectedResourceMetadata(opts: MetadataOptions) {
  return {
    resource: opts.mcpBaseUrl,
    authorization_servers: [opts.hostsmithUrl],
    scopes_supported: [...OAUTH_SCOPES],
    resource_documentation: "https://hostsmith.net/docs/developers/authentication",
  };
}

export interface CreateFetchHandlerOptions {
  /** Hostsmith app URL providing the OAuth endpoints (e.g. "https://hostsmith.net"). */
  hostsmithUrl: string;
  /** Public URL where this MCP server is reachable (e.g. "https://mcp.hostsmith.net"). */
  mcpBaseUrl: string;
}

function buildBearerError(mcpBaseUrl: string, error: string, status = 401): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata="${mcpBaseUrl}/.well-known/oauth-protected-resource"`,
    },
  });
}

/**
 * Build a Web-Standard fetch handler exposing the Hostsmith MCP HTTP transport.
 *
 * Callers (CLI, Lambda wrapper, etc.) supply configuration explicitly. The
 * factory does not read process.env — env-derived defaults belong in callers.
 *
 * Mounts:
 *   - GET /.well-known/oauth-protected-resource  (RFC 9728 metadata)
 *   - POST/GET/DELETE /mcp                       (Streamable HTTP transport)
 *
 * Auth-server metadata (RFC 8414) is NOT served here; clients fetch it from
 * the issuer host (`hostsmithUrl`) directly.
 */
export function createFetchHandler(
  opts: CreateFetchHandlerOptions,
): (req: Request) => Promise<Response> {
  const { hostsmithUrl, mcpBaseUrl } = opts;

  const app = new Hono();
  const protectedResourceMetadata = getProtectedResourceMetadata({ mcpBaseUrl, hostsmithUrl });

  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata));

  // Session map for stateful Streamable HTTP transport. Each session ID maps
  // to a transport bound to a single MCP server instance.
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  function readAuthInfo(authorization: string | undefined): AuthInfo | Response {
    if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) {
      return buildBearerError(mcpBaseUrl, "unauthorized");
    }
    const token = authorization.slice("bearer ".length).trim();
    let claims: Record<string, unknown>;
    try {
      claims = decodeJwtPayload(token);
    } catch {
      return buildBearerError(mcpBaseUrl, "invalid_token");
    }
    const exp = claims.exp as number | undefined;
    if (exp && exp * 1000 < Date.now()) {
      return buildBearerError(mcpBaseUrl, "token_expired");
    }
    return {
      token,
      clientId: (claims.client_id as string) ?? "",
      scopes: ((claims.scope as string) ?? "").split(" ").filter(Boolean),
      expiresAt: exp,
    };
  }

  app.post("/mcp", async (c) => {
    const auth = readAuthInfo(c.req.header("authorization"));
    if (auth instanceof Response) return auth;

    const sessionId = c.req.header("mcp-session-id");
    const existing = sessionId ? transports.get(sessionId) : undefined;
    if (existing) {
      return existing.handleRequest(c.req.raw, { authInfo: auth });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };

    const server = buildServer();
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw, { authInfo: auth });
    if (transport.sessionId) transports.set(transport.sessionId, transport);
    return response;
  });

  app.get("/mcp", async (c) => {
    const auth = readAuthInfo(c.req.header("authorization"));
    if (auth instanceof Response) return auth;
    const sessionId = c.req.header("mcp-session-id");
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      return c.json({ error: "Invalid or missing session ID" }, 400);
    }
    return transport.handleRequest(c.req.raw, { authInfo: auth });
  });

  app.delete("/mcp", async (c) => {
    const auth = readAuthInfo(c.req.header("authorization"));
    if (auth instanceof Response) return auth;
    const sessionId = c.req.header("mcp-session-id");
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      return c.json({ error: "Invalid or missing session ID" }, 400);
    }
    return transport.handleRequest(c.req.raw, { authInfo: auth });
  });

  return async (req: Request) => app.fetch(req);
}
