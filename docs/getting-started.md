# Getting started

Get from install to a live collaboration with a teammate.

**Status:** public alpha (`@arokodev/cli@0.1.0-alpha.8`). Expect breaking changes.
See [Known limitations](known-limitations.md).

## What Aroko does

Aroko lets developers securely connect their **local coding agents** so one
developer’s agent can inspect another developer’s context — without copying
repositories, sharing credentials, or granting blanket access. The receiver
keeps control of permissions and approvals.

## Why use it

- Stay in your own project and agent (Cursor, Claude Code, or Gemini CLI).
- Ask a teammate’s agent for inspection or a proposed change.
- Approve sensitive actions locally (exact Approve Once / Deny).

## Supported AI agents

| Agent | What works in alpha |
|-------|---------------------|
| [Cursor](integrations/cursor.md) | Inspection, progress, structured change proposals (apply is separate) |
| [Claude Code](integrations/claude-code.md) | Inspection and collaboration via MCP; approvals stay local |
| [Gemini CLI](integrations/gemini-cli.md) | Inspection; structured proposals not supported yet |

## Prerequisites

- Node.js 20+ and npm
- macOS or Linux (Windows is not first-class)
- A supported coding-agent CLI on `PATH` (for Cursor: `agent` + `agent login`)

## 1. Install

```bash
npm install -g @arokodev/cli
aroko --version
```

You should see `0.1.0-alpha.8` (or a newer published alpha). The `pairmesh`
binary is a compatibility alias for the same CLI.

Full notes: [Installation](installation.md).

## 2. Initialize your project

```bash
cd my-project
aroko init
```

Defaults to Cursor. For another provider:

```bash
aroko init --provider claude-code
# or
aroko init --provider gemini-cli
```

This creates local state under `.pairmesh/` (compatibility path).

## 3. Connect your coding agent

Cursor:

```bash
aroko cursor setup --write
```

Then open the project in Cursor so MCP can load Aroko.

Claude Code: [integrations/claude-code.md](integrations/claude-code.md)  
Gemini CLI: [integrations/gemini-cli.md](integrations/gemini-cli.md)

Check setup:

```bash
aroko doctor
```

## 4. Start local services and open Control Center

`aroko connect` can start Aroko for you. You can also start explicitly:

```bash
aroko start
aroko doctor
aroko open
```

`aroko open` opens the **local web Control Center** (loopback only) in your
browser — Home, peers, live work, and the approval Inbox. Approvals never happen
over MCP.

## 5. Collaborate with another developer

**Verified on a single machine (this guide):** install → init → setup → start →
open Control Center → doctor.

**Two-machine pairing** (separate developer machines) follows the same CLI, but
end-to-end validation of the current alpha line is tracked for a later mission
(S24-3). Documented procedure:

1. Both developers install and init independently.
2. One runs `aroko connect` → **Start a collaboration** (or `aroko create`).
3. Share the one-time join command with your teammate.
4. The other runs `aroko connect` → **Join** (or `aroko join … --invite …`).
5. Default networking uses the hosted relay (`wss://relay.aroko.dev/`).

Details: [Start a collaboration](collaboration/start-a-collaboration.md) ·
[Join a collaboration](collaboration/join-a-collaboration.md).

## 6. First requests and approvals

```bash
aroko ask <peer> "Why does checkout retry lose the reference?"
aroko requests
aroko open
aroko status
```

- **ask** — request inspection or a proposal from a peer’s agent  
- **requests** — pending work  
- **open** — Control Center / Inbox to Approve Once or Deny  
- **status** — session overview  

Permissions stay explicit. Widen access only with `aroko permissions` when you
intend to. See [Permissions](collaboration/permissions.md) and
[Proposals and approvals](concepts/proposals-and-approvals.md).

## Security boundaries

- Pairing does **not** grant blanket repository access.
- Mutations require the **receiver’s** exact approval.
- Proposal generation is separate from applying changes.
- Aroko is **not** a sandbox, shared filesystem, or remote shell.

See [Security](concepts/security.md) and the
[public alpha security boundary](security/public-alpha-security-boundary.md).

## Troubleshooting

```bash
aroko doctor
```

More: [Troubleshooting](troubleshooting.md).

## Where to get help

- GitHub issues: https://github.com/infinitypaul/aroko/issues  
- Security reports: [SECURITY.md](../SECURITY.md)  
- Product docs in this repository (website marketing surface is separate; see
  maintainer notes if `aroko.dev` is unavailable)

## Next

- [Installation](installation.md)
- [CLI reference](cli/commands.md)
- [How Aroko works](concepts/how-aroko-works.md)
- [Known limitations](known-limitations.md)
