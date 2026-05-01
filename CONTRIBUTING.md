# Contributing

Thanks for your interest in `@hostsmith/mcp-server`. This is the official Model Context Protocol server for the [Hostsmith](https://hostsmith.net) hosting platform. Issues and PRs are welcome - please read this short guide first.

## Scope

This repo is the MCP server only. Feature requests for the Hostsmith platform itself (new APIs, billing, dashboard) belong on [hostsmith.net](https://hostsmith.net), not here. Good fits for this repo:

- MCP server bugs (incorrect tool shapes, broken auth flow, regressions)
- DX improvements (better tool descriptions, ergonomic args, clearer errors)
- New tool wrappers around endpoints already exposed by `@hostsmith/sdk`
- Documentation fixes
- Test coverage

New tools that require new Hostsmith API endpoints belong upstream first - get the endpoint added to the public API and the SDK before opening a PR here.

## Development

```bash
git clone https://github.com/hostsmith/mcp-server
cd mcp-server
npm install
git config core.hooksPath .githooks
```

Common commands:

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm run dev         # tsx --env-file=.env src/index.ts http
```

To exercise the server end-to-end, point an MCP client (Claude Desktop, `@modelcontextprotocol/inspector`) at your local build per the README's "Local with access token (stdio)" section.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). The `commit-msg` hook enforces the format - enable it with `git config core.hooksPath .githooks` (the install step above).

| Type                                                       | When                          | Releases? |
| ---------------------------------------------------------- | ----------------------------- | --------- |
| `feat:`                                                    | new functionality             | minor     |
| `fix:`                                                     | bug fix                       | patch     |
| `feat!:` or `BREAKING CHANGE:`                             | breaking API change           | major     |
| `docs:`, `style:`, `refactor:`, `perf:`, `test:`, `chore:` | non-shipping                  | none      |

Releases are automated from `main` via GitHub Actions.

## Pull requests

- Open a PR against `main`
- CI must pass (`typecheck` + `build`)
- Keep PRs focused; small is better than complete
- Reference an issue in the description if one exists

## Reporting security issues

Please don't open public issues for security reports. See [SECURITY.md](./SECURITY.md).
