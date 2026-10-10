# Upgrade and rollback

Only the local owner can update Aroko. Peers, MCP tools, and remote agents
cannot change your install.

## Check for updates

```bash
aroko update check
```

## Install an update

```bash
aroko update
```

Aroko confirms before changing your install. You can roll back if needed.

## Safety

- Updates use a trusted release channel and integrity checks
- Peer sessions cannot trigger updates
- Prefer reviewing release notes before upgrading in the middle of live work

See also [Known limitations](known-limitations.md).
