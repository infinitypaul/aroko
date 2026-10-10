# Getting started

Get from install to a live collaboration with a teammate.

## 1. Install

Aroko is an alpha. `@arokodev/cli` is **not** on the npm registry yet.

Follow the verified source install in [Installation](installation.md), then
confirm the CLI:

```bash
node /path/to/aroko/apps/cli/dist/index.js --version
# or, from the Aroko repo: pnpm aroko --version
```

The examples below use `aroko` as the primary command name. After packaging,
`pairmesh` is a compatibility alias for the same CLI. Until then, use the
`node …/apps/cli/dist/index.js` (or `pnpm aroko`) form from Installation.

## 2. Initialize your project

```bash
cd my-project
aroko init
```

This creates local project state under `.pairmesh/` (compatibility path) and
defaults the coding agent to Cursor. To use another provider:

```bash
aroko init --provider claude-code
# or
aroko init --provider gemini-cli
```

## 3. Connect your coding agent

For Cursor:

```bash
aroko cursor setup --write
```

Then open the project in Cursor so MCP can load Aroko.

Claude Code and Gemini: see the [integrations](integrations/cursor.md) docs.

## 4. Collaborate

```bash
aroko connect
```

Aroko asks what you want to do:

1. Start a collaboration
2. Join a collaboration
3. Invite another teammate
4. Cancel

If Aroko is not running yet, it can start for you.

## 5. Work together

Typical next commands:

```bash
aroko ask <peer> "Why does checkout retry lose the reference?"
aroko requests
aroko open
aroko status
```

- **ask** — request inspection or a proposal from a peer’s agent  
- **requests** — see pending work  
- **open** — open the local Inbox to Approve Once or Deny  
- **status** — session and peer overview  

Permissions stay explicit. Widen access only with
`aroko permissions` when you intend to.

## What stays yours

Your teammate cannot:

- read your files without permission you grant
- apply changes without your approval
- run arbitrary commands on your machine by default
- update Aroko software on your machine

## Next

- [Start a collaboration](collaboration/start-a-collaboration.md)
- [Join a collaboration](collaboration/join-a-collaboration.md)
- [Permissions](collaboration/permissions.md)
- [Security](concepts/security.md)
