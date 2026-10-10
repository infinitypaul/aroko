# Troubleshooting

## Start here

```bash
aroko doctor
```

## Aroko is not running

```bash
aroko connect
```

Or:

```bash
aroko start
aroko status
```

## Cursor MCP missing

```bash
aroko cursor setup --write
```

Reload Cursor / reopen the project.

## Join failed

- Confirm the invite is unused and not expired
- Ask the creator for a fresh `aroko invite`
- In relay mode you usually do not need `--peer`

## Proposal waiting forever

Open the receiver Inbox:

```bash
aroko open
```

Approve Once or Deny there.

## Updates

Only the local owner updates Aroko:

```bash
aroko update check
```
