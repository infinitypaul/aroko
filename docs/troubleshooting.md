# Troubleshooting

## Start here

```bash
aroko doctor
```

Fix anything `doctor` flags before debugging collaboration.

## Aroko is not running

```bash
aroko connect
```

Or:

```bash
aroko start
aroko status
aroko control status
```

## Control Center / Inbox will not open

1. Ensure the runtime is up: `aroko start` then `aroko control status`.
2. Open the UI: `aroko open` (loopback browser only).
3. If the browser does not open, copy the Control URL from
   `aroko control status` and open `/control/web` on that host.

Approvals happen in the Control Center — not inside MCP tools.

## Cursor MCP missing

```bash
aroko cursor setup --write
```

Reload Cursor / reopen the project. Confirm `agent` is on `PATH` and you have
run `agent login`.

## Claude / Gemini setup

- Claude: `claude` on `PATH`; see [Claude Code](integrations/claude-code.md)
- Gemini: `gemini` on `PATH`; see [Gemini CLI](integrations/gemini-cli.md)

Then `aroko doctor`.

## Join failed

- Confirm the invite is unused and not expired
- Ask the creator for a fresh `aroko invite`
- In relay mode you usually do not need `--peer`
- Confirm both sides can reach `wss://relay.aroko.dev/`

## Peer unreachable / reconnecting

- Run `aroko doctor` on both machines
- Confirm relay connectivity (default hosted relay)
- Try `aroko restart` after network changes
- Check that the peer’s Aroko runtime is still running

## Proposal waiting forever

Open the receiver Control Center / Inbox:

```bash
aroko open
```

Approve Once or Deny there. The requester cannot approve apply on the
receiver’s machine.

## Permission denied

Grants are explicit. On the receiver:

```bash
aroko permissions
aroko permissions pending
```

See [Permissions](collaboration/permissions.md).

## Cancel a stuck action

```bash
aroko action pending
aroko action cancel <id>
```

## Updates

Only the local owner updates Aroko:

```bash
aroko update check
```

Peers cannot push software updates to your machine.
