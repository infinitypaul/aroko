# CLI commands

Canonical command: `aroko`. The legacy `pairmesh` binary remains a compatibility
alias.

## Everyday

| Command | Purpose |
|---------|---------|
| `aroko init` | Initialize a project (default provider: Cursor) |
| `aroko cursor setup --write` | Wire Cursor MCP |
| `aroko connect` | Start / join / invite |
| `aroko ask <peer> "…"` | Request help from a peer |
| `aroko requests` | List pending requests |
| `aroko open` | Open local Inbox |
| `aroko status` | Session overview |
| `aroko doctor` | Diagnose setup |

## Session

| Command | Purpose |
|---------|---------|
| `aroko create` | Start a collaboration |
| `aroko join …` | Join with invite |
| `aroko invite` | Issue another invite |
| `aroko leave` | Leave local session |

## Permissions & power

| Command | Purpose |
|---------|---------|
| `aroko permissions …` | Grant / revoke / approve policy |
| `aroko action …` | Lower-level action control |
| `aroko start` / `stop` / `restart` | Runtime control |

Run `aroko` with no arguments for full help.
