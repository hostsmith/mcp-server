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
npm run smoke       # build, import createApp, start on a free port, hit the discovery doc
npm run dev         # tsx --env-file=.env src/cli.ts http
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

Releases are automated from `main` via GitHub Actions. See **Releases** below for the full flow.

## Releases

### Stable release (merge to `main`)

1. Conventional commits land on `main` via PR merge.
2. `cog bump --auto` computes the next version. Pre-bump hooks stamp `package.json` + `server.json` (only the `@hostsmith/mcp-server` entry under `packages[]`) and update `CHANGELOG.md`.
3. cog creates a single `chore(version): vX.Y.Z` commit and tags it.
4. CI pushes the bump commit + tag to `main` using a **GitHub App token** (the App has bypass on `main`'s branch protection). The retriggered workflow run sees `chore(version):` as the head commit and skips the release job - so build/publish only run once.
5. CI builds, publishes the tarball to npm under dist-tag `latest`, creates a GitHub Release, and publishes `server.json` to the official MCP registry.

`git checkout main` and `git checkout vX.Y.Z` both show the real version - they're the same commit.

### Prerelease (manual, from a feature branch)

`workflow_dispatch` on `release.yml` from any branch other than `main` cuts a prerelease:

1. Computes `X.Y.Z-rc.<short-sha>` (cog `--auto --pre rc.<short-sha>`, used for version computation only).
2. Stamps the version into the workspace only - **no commit, no tag, no `git push`** anywhere. The branch HEAD is unchanged.
3. Publishes to npm under dist-tag `rc`.
4. Exits.

`<short-sha>` is the real `git rev-parse --short HEAD` of the feature branch tip; `git checkout <short-sha>` reproduces the source the rc was built from (with `version` reset to whatever main had).

Prereleases are **not** published to the MCP registry. Use `npm install @hostsmith/mcp-server@rc` to test prereleases. The MCP registry tracks stable versions only.

### Required secrets

`release.yml` needs two repo secrets for the bump-commit push:

- `RELEASE_APP_CLIENT_ID` - the GitHub App's client ID
- `RELEASE_APP_PRIVATE_KEY` - the GitHub App's private key (PEM)

The App must be installed on this repo with `contents: write` and listed as a bypass actor for `main`'s branch protection ruleset. Branch protection still applies to humans and to other automation.

### MCP registry authentication

`mcp-publisher` authenticates via GitHub Actions OIDC (`mcp-publisher login github-oidc`). No long-lived credentials. The job declares `permissions: id-token: write`. The OIDC flow only works because `server.json` `name` (`io.github.hostsmith/mcp-server`) is in a namespace bound to this repository - if you ever rename the namespace, re-claim it on the registry first.

## Pull requests

- Open a PR against `main`
- CI must pass (`typecheck` + `build`)
- Keep PRs focused; small is better than complete
- Reference an issue in the description if one exists

## Reporting security issues

Please don't open public issues for security reports. See [SECURITY.md](./SECURITY.md).
