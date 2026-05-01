# Security Policy

## Reporting a Vulnerability

If you believe you've found a security issue in `@hostsmith/mcp-server`, please report it privately.

Email: **security@ops42.org**

Please include:

- A description of the issue and its impact
- Steps to reproduce, ideally a minimal proof-of-concept
- The package version (`@hostsmith/mcp-server` from `package.json`) and Node.js version
- The transport used (stdio / HTTP) and the auth mode (OAuth / static access token)
- Whether the issue affects the published package only, or also the hosted MCP server at `mcp.hostsmith.net` or the Hostsmith platform itself

We aim to acknowledge reports within 5 business days and to provide a status update within 14 days. Coordinated disclosure is appreciated - please give us reasonable time to ship a fix before publishing details.

## Threat Model

This package is an MCP server that holds a Hostsmith OAuth 2.0 access token (or accepts one per request via the MCP HTTP transport) and calls the Hostsmith Public API on the user's behalf.

- **Tokens are sensitive.** Storing or logging an access token can give an attacker the same permissions the user granted. Do not log tokens, do not commit them, and prefer environment-variable storage in CI.
- **HTTP mode is local-only by default.** The HTTP transport listens on `localhost:$PORT`; do not expose it to the public internet without an authenticating reverse proxy.
- **Network trust.** All upstream requests go to `https://*.api.hostsmith.net` over TLS. Custom `HOSTSMITH_API_DOMAIN` / `HOSTSMITH_BASE_URL` overrides are intended for development; using them against production is unsupported.
- **Out of scope.** Vulnerabilities in the Hostsmith platform (the API itself, the dashboard, the deployment runtime) are not handled in this repo - report those to the same address but indicate that the report is platform-related.

## Supported Versions

We provide security fixes for the latest minor version on npm. Older versions are best-effort.
