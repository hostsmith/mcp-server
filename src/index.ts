#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Hostsmith, ApiError } from "@hostsmith/sdk";
import type { Partition } from "@hostsmith/sdk";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, posix, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import express from "express";
import { readFileSync } from "node:fs";

const PKG_VERSION: string = (() => {
  // Resolve package.json relative to the compiled dist/ or source src/ dir
  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version;
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOSTSMITH_URL = process.env.HOSTSMITH_URL ?? "https://hostsmith.net";

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

// ---------------------------------------------------------------------------
// Resolve access token: from authInfo (HTTP/OAuth) or env var (stdio)
// ---------------------------------------------------------------------------

function getToken(extra: { authInfo?: AuthInfo }): string {
  if (extra.authInfo?.token) return extra.authInfo.token;
  const envToken = process.env.HOSTSMITH_ACCESS_TOKEN;
  if (envToken) return envToken;
  throw new Error(
    "No access token available. Set HOSTSMITH_ACCESS_TOKEN or use OAuth.",
  );
}

// ---------------------------------------------------------------------------
// MCP server & tools
// ---------------------------------------------------------------------------

function buildServer(): McpServer {
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

// ---------------------------------------------------------------------------
// Stdio transport (local usage with HOSTSMITH_ACCESS_TOKEN env var)
// ---------------------------------------------------------------------------

async function startStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// HTTP transport with OAuth (remote/hosted usage)
// ---------------------------------------------------------------------------

async function startHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3100", 10);
  const baseUrl = process.env.MCP_BASE_URL ?? `http://localhost:${port}`;

  const provider = new ProxyOAuthServerProvider({
    endpoints: {
      authorizationUrl: `${HOSTSMITH_URL}/api/oauth/authorize`,
      tokenUrl: `${HOSTSMITH_URL}/api/oauth/token`,
      registrationUrl: `${HOSTSMITH_URL}/api/oauth/register`,
      revocationUrl: `${HOSTSMITH_URL}/api/oauth/revoke`,
    },
    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      const claims = decodeJwtPayload(token);
      return {
        token,
        clientId: (claims.client_id as string) ?? "",
        scopes: ((claims.scope as string) ?? "").split(" ").filter(Boolean),
        expiresAt: claims.exp as number | undefined,
      };
    },
    getClient: async (
      clientId: string,
    ): Promise<OAuthClientInformationFull | undefined> => {
      try {
        const res = await fetch(
          `${HOSTSMITH_URL}/api/oauth/client-info?client_id=${encodeURIComponent(clientId)}`,
        );
        if (!res.ok) return undefined;
        return (await res.json()) as OAuthClientInformationFull;
      } catch {
        return undefined;
      }
    },
  });

  const app = express();

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(HOSTSMITH_URL),
      baseUrl: new URL(baseUrl),
      scopesSupported: ["sites:read", "sites:write", "domains:read", "files:write", "account:read"],
      serviceDocumentationUrl: new URL(
        "https://hostsmith.net/docs/developers/authentication",
      ),
    }),
  );

  const bearerAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${baseUrl}/.well-known/oauth-protected-resource`,
  });

  // Session management for stateful transport
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", bearerAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };

    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    if (transport.sessionId) {
      transports.set(transport.sessionId, transport);
    }
  });

  app.get("/mcp", bearerAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", bearerAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  const httpServer = createServer(app);
  httpServer.listen(port, () => {
    console.log(`Hostsmith MCP server listening on ${baseUrl}/mcp`);
  });
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const mode = process.argv[2] ?? process.env.MCP_TRANSPORT ?? "stdio";

if (mode === "http") {
  startHttp().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
} else {
  startStdio().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
