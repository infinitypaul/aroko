# Install Aroko

**Status:** Active (S23-5)  
**Audience:** Developers installing the CLI on their own machine

## Prerequisites

- **Node.js 20+** (enforced at CLI startup)
- **npm** (used for global install of the staged/public CLI package)
- **macOS or Linux** — first-alpha supported platforms
- **Windows** — not first-class; process.execute validation and PATH behavior may differ

Optional:

- Cursor CLI (`agent` on PATH) for Cursor ACP inspection and structured
  `change.propose` (read-only proposal generation; apply is separate)
- Claude Code / Gemini CLI for those providers (Gemini propose unsupported)

## Canonical install model

Public alpha is designed around one Node CLI package:

```bash
npm install -g @arokodev/cli
```

Until public npm publication (not part of S23-5), install from a **staged** artifact
produced by the release pack:

```bash
npm install -g /path/to/aroko-cli-<version>.tgz
```

Isolated prefix (recommended for testing):

```bash
npm install -g /path/to/aroko-cli-<version>.tgz --prefix ~/.aroko-global
export PATH="$HOME/.aroko-global/bin:$PATH"
```

Primary command: `aroko`  
Legacy alias: `pairmesh` (same binary — do not install separately)

## Verify

```bash
aroko --version
aroko version
aroko version --json
```

`version --json` exposes product, package version, releaseId, gitCommit, gitTag,
build timestamp, protocol version, state schema version, build mode, and
artifactSha256 when embedded.

Confirm the binary is not resolving into a monorepo checkout:

```bash
aroko doctor
```

## Connect local environment

```bash
cd my-project
aroko init
aroko config set --key codingAgent.provider --value cursor   # or claude-code / gemini-cli
aroko cursor setup --write   # Cursor ACP / MCP when applicable
aroko start
```

Cursor / Claude MCP identity written by setup:

- Server key: `mcpServers.aroko` (canonical)
- Command: `aroko` with args `mcp` (installed mode)
- Legacy `mcpServers.pairmesh` entries are still recognized for migration;
  `cursor setup --write --force` consolidates to the canonical `aroko` key

Production alpha relay:

```bash
aroko config set --key connectivity.mode --value relay
aroko config set --key connectivity.relayUrl --value wss://relay.aroko.dev/
```

Workspace state remains under `.pairmesh/` (compatibility path — not renamed).

See also: [`docs/known-limitations.md`](known-limitations.md) ·
[`docs/security/public-alpha-security-boundary.md`](security/public-alpha-security-boundary.md) ·
[`docs/integrations/alpha-providers.md`](integrations/alpha-providers.md)

## Uninstall

```bash
npm uninstall -g @arokodev/cli
# or with a prefix:
npm uninstall -g @arokodev/cli --prefix ~/.aroko-global
```

Uninstalling the CLI **does not** delete `.pairmesh/` project state or `~/.pairmesh`
home data. Remove those only if you intentionally want to destroy local session
and identity data — that is irreversible without backups.

## PATH troubleshooting

- Ensure the npm global `bin` directory is on `PATH`
- `aroko doctor` prints the install path of the running CLI
- If both `aroko` and `pairmesh` exist, they must be the same install (same package)
