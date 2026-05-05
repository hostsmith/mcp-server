import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { Hostsmith, ApiError } from "@hostsmith/sdk";
import type { Partition } from "@hostsmith/sdk";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, posix, basename } from "node:path";
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
  .describe(
    'Hostsmith data partition: "us" (United States) or "eu" (European Union)',
  );

// HOSTSMITH_API_DOMAIN overrides the SDK's hardcoded hostsmith.net domain
// across both partitions (e.g. "hostsmith.net" →
// "https://us.api.hostsmith.net", "https://eu.api.hostsmith.net").
// Falls back to HOSTSMITH_BASE_URL for a single-host override, then to the
// SDK's built-in prod URLs.
function partitionUrlsFromEnv():
  | Partial<Record<Partition, string>>
  | undefined {
  const apiDomain = process.env.HOSTSMITH_API_DOMAIN;
  if (!apiDomain) return undefined;
  return {
    us: `https://us.api.${apiDomain}`,
    eu: `https://eu.api.${apiDomain}`,
  };
}

function createClient(token: string, partition?: Partition): Hostsmith {
  const baseUrl = process.env.HOSTSMITH_BASE_URL;
  if (baseUrl) {
    return new Hostsmith({ accessToken: token, baseUrl });
  }
  // When `partition` is omitted, the SDK infers it from the access
  // token's `homePartition` claim.
  const partitionUrls = partitionUrlsFromEnv();
  return new Hostsmith({
    accessToken: token,
    ...(partition ? { partition } : {}),
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

export const SERVER_INSTRUCTIONS = `
Hostsmith MCP server: publish, share, and host files or static sites.

Context bootstrap:
- On first use in a session, call get_account and list_domains once to learn the user's account, homePartition, plan limits, and available domains. Cache and reuse these for the rest of the session; only re-call if the user asks for a refresh or you have reason to suspect the data changed (e.g. a domain was just claimed).
- list_sites changes frequently (any create/delete mutates it). Always re-call before acting on a site reference rather than relying on a cached result.

Partition selection:
- Pass partition: "eu" when the user signals EU residency or GDPR; otherwise omit partition and let it default to the user's home partition. Ask if unsure.

Plans and limits:
- Free, Basic, and Standard plans only allow sites in the user's home partition. Creating a site in a non-home partition on those plans returns the API error "Site limit reached for current plan" — only Premium and above can host sites across partitions. Do not pre-emptively refuse cross-partition requests; attempt the call and surface that error verbatim so the user knows they need to upgrade.

Deploying content:
- Use deploy_files for content you generated in-memory (HTML, JSON, reports).
- Use deploy_path for files or folders that already live on the user's disk.
- The site must exist first; call create_site if no siteId is available.
- Inside a VS Code extension or other sandboxed client where directory access is restricted, prefer reading individual file contents and calling deploy_files over passing a directory to deploy_path.

Naming:
- Site subdomains are lowercase alphanumeric with hyphens; no dots, no uppercase, no underscores.

Resolving the user's site reference:
- Infer the intended FQDN from how the user described the site:
  - A name that looks like an FQDN (e.g. \`blog.example.com\`) → split into subdomain + domain and validate against list_domains.
  - A bare string that doesn't look like an FQDN (e.g. "my-blog") → assume it's a subdomain on a shared domain in the user's home partition.
  - Phrases like "my company homepage" on a domain the user owns with \`enableApexDomain: true\` → apex/\`www\` site.
  - When genuinely ambiguous, ask the user.
- After resolving, look up the FQDN in the latest list_sites result to determine whether this is a new or existing site, and validate the domain/subdomain against list_domains.
- Before performing any create/deploy/delete action, show the user the resolved info — full FQDN, partition, and whether the site is new or existing — and ask for confirmation.

Destructive actions (require explicit user confirmation; never call speculatively):
- delete_site is irreversible — the URL goes dark immediately and content cannot be recovered.
- deploy_path and deploy_files against an existing site overwrite its current content. If the resolved FQDN matches an existing site, confirm with the user that they want to overwrite it before deploying.
`.trim();

export function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: "hostsmith",
      version: PKG_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.tool(
    "list_sites",
    'List Hostsmith sites in the user\'s account. Returns each site\'s `siteId`, `subdomain`, `domain`, and current status — feed `siteId` into `get_site`, `deploy_path`, `deploy_files`, or `delete_site`. This is the source of truth for "does the user already have a site at FQDN X" — call it before any create/deploy/delete to resolve the user\'s site reference. By default queries all data partitions and merges the results; pass `partition: "us"` or `"eu"` to limit the query.',
    {
      partition: partitionSchema
        .optional()
        .describe("Filter by data partition. Omit to query all partitions."),
    },
    async ({ partition }, extra) => {
      try {
        const token = getToken(extra);
        const partitions: Partition[] = partition
          ? [partition]
          : ALL_PARTITIONS;

        const results = await Promise.all(
          partitions.map(async (p) => {
            const client = createClient(token, p);
            const { sites } = await client.sites.list();
            return sites;
          }),
        );

        const sites = results.flat();
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
    "List domains the user can host sites under. Returns shared hosting domains (e.g. `hostsmith.link`, available to everyone) and custom domains owned by the user's organization. Use this to pick a `domain` value before calling `create_site`. By default queries all partitions and merges; pass `partition` or `shared` to narrow.",
    {
      partition: partitionSchema
        .optional()
        .describe("Filter by data partition. Omit to query all partitions."),
      shared: z
        .boolean()
        .optional()
        .describe(
          "Filter by domain type: true for shared only, false for custom only. Omit for both.",
        ),
    },
    async ({ partition, shared }, extra) => {
      try {
        const token = getToken(extra);
        const listParams = shared !== undefined ? { shared } : undefined;
        const partitions: Partition[] = partition
          ? [partition]
          : ALL_PARTITIONS;

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
    "Get the user's account: organization details, current subscription plan with its limits (max sites, max domains, storage, bandwidth), and current usage counts. Use to check how much headroom the user has before creating new sites or to confirm plan-tier features. Usage is summed across all partitions.",
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
    "Get full details of a specific Hostsmith site by ID, including its public URL (`https://<subdomain>.<domain>`), current deployment status, and configuration. Use after `list_sites` to inspect a single site, or after `deploy_path` / `deploy_files` to confirm the site is live and grab the URL to share with the user. Defaults to the user's home partition; pass `partition` explicitly when the site lives in a different one (visible in `list_sites` output).",
    {
      siteId: z
        .string()
        .describe("The site ID returned by `list_sites` or `create_site`."),
      partition: partitionSchema
        .optional()
        .describe(
          "Data partition the site lives in (visible in list_sites output). Omit to use the user's home partition.",
        ),
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
    `Create a new Hostsmith site and return its \`siteId\`, full URL, and configuration. Use when the user wants to publish or host new content and no suitable site already exists. After creation, deploy content with \`deploy_path\` (local file or folder) or \`deploy_files\` (inline content). The site-resolution and confirmation flow is described in the global server instructions; the rules below are specific to this tool's parameters.

\`domain\` MUST be one of the domains returned by \`list_domains\` for this user — never invent or assume one. The selected domain must be in \`active\` status; if it isn't, surface the problem to the user instead of attempting creation. \`partition\` passed to this tool MUST match the partition of the selected domain.

Subdomain selection must respect the domain's capabilities from \`list_domains\`. To serve the bare apex, pass \`subdomain: "www"\` — only valid when the domain has \`enableApexDomain: true\` (typically custom domains the user owns). For any other subdomain, the domain must have \`enableSubdomains: true\`; shared hosting domains (e.g. \`*.hostsmith.link\`) and most custom domains have \`enableApexDomain: false\`, so a non-apex subdomain is required there. If the chosen domain doesn't support the kind of site the user asked for (apex vs subdomain), surface the conflict rather than silently picking something else.`,
    {
      domain: z
        .string()
        .describe(
          'Parent domain for the site, MUST be one returned by `list_domains` for this user. Examples: "us.hostsmith.link", "eu.hostsmith.link", or a custom domain the user owns. Do not invent domains.',
        ),
      subdomain: z
        .string()
        .regex(
          /^[a-z0-9-]+$/,
          "Subdomain must be lowercase alphanumeric with hyphens; no dots, uppercase, or underscores.",
        )
        .optional()
        .describe(
          'Subdomain prefix; auto-generated if omitted. Lowercase alphanumeric with hyphens only — no dots, uppercase, or underscores. Pass `subdomain: "www"` only when the chosen `domain` has `enableApexDomain: true` in `list_domains` (creates the canonical site at `www.<apex>` with the bare apex redirecting to it). For any other subdomain the chosen `domain` must have `enableSubdomains: true`.',
        ),
      partition: partitionSchema
        .optional()
        .describe(
          "Data partition for the new site. Must match the partition of the selected domain.",
        ),
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
    "Permanently delete a Hostsmith site and all of its deployed files. **Destructive — only call after explicit user confirmation.** The site URL becomes unreachable immediately and the content cannot be recovered. The user must pass `confirm: true` for the deletion to proceed; otherwise the call returns an error explaining the safeguard.",
    {
      siteId: z
        .string()
        .describe("The site ID to delete (from `list_sites` or `get_site`)."),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Set to true only after the user has explicitly confirmed they want to permanently delete this site. Required safeguard — never pass true speculatively.",
        ),
      partition: partitionSchema
        .optional()
        .describe(
          "Data partition the site lives in. Omit to use the user's home partition.",
        ),
    },
    async ({ siteId, confirm, partition }, extra) => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: `Refusing to delete site ${siteId}: confirmation required. Confirm with the user that they want to permanently delete this site and its content, then call again with confirm: true.`,
            },
          ],
          isError: true,
        };
      }
      try {
        const client = createClient(getToken(extra), partition);
        const site = await client.sites.get(siteId);
        const url = `https://${site.subdomain}.${site.domain}`;
        await client.sites.delete(siteId);
        return {
          content: [
            {
              type: "text",
              text: `Deleted site ${siteId} (${url}). The URL is no longer reachable and content cannot be recovered.`,
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
    "deploy_path",
    "Publish a local file or folder to a Hostsmith site at a public HTTPS URL. Use when the user wants to share or deploy something they have on disk (HTML, PDF, image, static-site folder). Returns the live URL on success. The site must already exist — call `create_site` first if you do not have a `siteId`. For folders larger than 50 files, zip first. Deploying to a site that already has content overwrites it — confirm overwrite with the user first.",
    {
      siteId: z
        .string()
        .describe(
          "The site ID to deploy to (from `list_sites` or `create_site`).",
        ),
      path: z
        .string()
        .describe("Absolute path to a local file or directory to deploy."),
      partition: partitionSchema
        .optional()
        .describe(
          "Data partition the site lives in. Omit to use the user's home partition.",
        ),
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
    "Publish in-memory file contents to a Hostsmith site without writing to disk. Use when you have just generated content (an HTML page, a report, JSON data) and the user wants it live. Returns the deployment version and status; call `get_site` afterwards if you need the public URL to share. The site must already exist — call `create_site` first if you do not have a `siteId`. Deploying to a site that already has content overwrites it — confirm overwrite with the user first.",
    {
      siteId: z
        .string()
        .describe(
          "The site ID to deploy to (from `list_sites` or `create_site`).",
        ),
      files: z
        .array(
          z.object({
            fileName: z
              .string()
              .describe(
                "File path relative to site root (e.g. `index.html`, `assets/style.css`).",
              ),
            content: z.string().describe("The file content as a string."),
          }),
        )
        .describe(
          "Files to deploy. For an HTML site, include an `index.html` as the entry point; otherwise any single file (PDF, image, JSON, etc.) works on its own.",
        ),
      partition: partitionSchema
        .optional()
        .describe(
          "Data partition the site lives in. Omit to use the user's home partition.",
        ),
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
    resource_documentation:
      "https://hostsmith.net/docs/developers/authentication",
  };
}

export interface CreateFetchHandlerOptions {
  /** Hostsmith app URL providing the OAuth endpoints (e.g. "https://hostsmith.net"). */
  hostsmithUrl: string;
  /** Public URL where this MCP server is reachable (e.g. "https://mcp.hostsmith.net"). */
  mcpBaseUrl: string;
}

function buildBearerError(
  mcpBaseUrl: string,
  error: string,
  status = 401,
): Response {
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
  const protectedResourceMetadata = getProtectedResourceMetadata({
    mcpBaseUrl,
    hostsmithUrl,
  });

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(protectedResourceMetadata),
  );

  function readAuthInfo(
    authorization: string | undefined,
  ): AuthInfo | Response {
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

  // Stateless mode: every request stands alone. No session ID is generated
  // or tracked, so this works correctly across Lambda containers and other
  // ephemeral runtimes where a per-process session map would lose entries.
  // Trade-off: the server-initiated SSE channel on `GET /mcp` is unavailable
  // (no session to attach to), and tools that rely on per-session state
  // would need to be rebuilt. The current Hostsmith tools are pure
  // request/response, so neither limitation matters today. Re-enable
  // sessions when adding streaming-progress or sampling flows, paired with
  // an external session store.
  app.all("/mcp", async (c) => {
    const auth = readAuthInfo(c.req.header("authorization"));
    if (auth instanceof Response) return auth;

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = buildServer();
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, { authInfo: auth });
  });

  return async (req: Request) => app.fetch(req);
}
