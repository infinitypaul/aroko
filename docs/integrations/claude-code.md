# Claude Code

## Setup

```bash
aroko init --provider claude-code
aroko claude setup --write
```

Receiver awareness helps Claude Code surface pending requests. Approvals still
happen in the local Aroko Inbox — not through an MCP approve tool.

## What you can do

- Collaborate through Aroko with inspection and related flows
- Review pending work with `aroko requests` / `aroko open`

## Compatibility

Requires a working `claude` CLI on PATH. Use `aroko doctor` to verify.
