# Cursor

## Setup

```bash
aroko init
aroko cursor setup --write
```

Open the project in Cursor so the Aroko MCP server loads.

## What you can do

- Ask a peer’s agent to inspect their project
- Follow progress
- Request a structured change proposal

Proposal generation is read-oriented. Applying a change is a separate step
that requires the receiver’s approval in their local Inbox
(`aroko open`).

## Compatibility

Cursor support depends on the Cursor CLI / ACP features available on your
machine. Run `aroko doctor` if setup looks wrong.
