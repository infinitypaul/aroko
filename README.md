# Aroko

Connect your local coding agent with a teammate’s — securely, without copying
repositories or sharing credentials.

Paul asks Kelvin. Kelvin stays in control of Kelvin’s machine, provider, and
approvals.

**Status:** public alpha. The npm package `@arokodev/cli` is **not published
yet**. Install from source for now. The primary executable is `aroko`;
`pairmesh` is a compatibility alias for the same CLI after packaging.

## Why Aroko

Developers already use coding agents in their own projects. Collaboration
usually means sharing a repo, a shell, or broad access. Aroko keeps each
developer’s environment independent and asks before anything sensitive happens.

## Quick start (from source)

```bash
git clone https://github.com/infinitypaul/aroko.git
cd aroko
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
pnpm build

# Primary CLI (verified on a clean checkout)
node apps/cli/dist/index.js --version

# Optional: convenient wrapper while developing from this repo
alias aroko='node '"$PWD"'/apps/cli/dist/index.js'

cd /path/to/my-project
aroko init
aroko cursor setup --write
aroko connect
```

`aroko init` defaults to Cursor. Prefer Claude Code or Gemini CLI? Pass
`--provider claude-code` or `--provider gemini-cli` on init, or see the
integration guides.

Full install notes: [Installation](docs/installation.md).

## npm install (not available yet)

```bash
# NOT AVAILABLE YET — @arokodev/cli is not on the npm registry
# npm install -g @arokodev/cli
```

## How collaboration works

1. You and a teammate each run Aroko in your own project.
2. One of you starts a collaboration and shares a single-use invite.
3. The other joins with that invite.
4. Requests (inspect, propose a change, …) need explicit permissions.
5. Mutations require the receiver’s exact approval in the local Inbox.

## Supported coding agents

| Agent | Role |
|-------|------|
| [Cursor](docs/integrations/cursor.md) | Inspection, progress, structured change proposals |
| [Claude Code](docs/integrations/claude-code.md) | Inspection and collaboration via MCP |
| [Gemini CLI](docs/integrations/gemini-cli.md) | Inspection; change proposals not supported yet |

## Security

- Peer payloads are end-to-end encrypted (relay forwards ciphertext only)
- No repository copying or credential sharing
- Pairing does not grant blanket access
- Receiver-controlled permissions and approvals
- Proposal generation is separate from applying changes

See [Security](docs/concepts/security.md), the
[public alpha security boundary](docs/security/public-alpha-security-boundary.md),
and [SECURITY.md](SECURITY.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [Installation](docs/installation.md)
- [Start a collaboration](docs/collaboration/start-a-collaboration.md)
- [Join a collaboration](docs/collaboration/join-a-collaboration.md)
- [Permissions](docs/collaboration/permissions.md)
- [How Aroko works](docs/concepts/how-aroko-works.md)
- [CLI reference](docs/cli/commands.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Known limitations](docs/known-limitations.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE)
