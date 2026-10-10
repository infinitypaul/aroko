# How Aroko works

## Independent environments

Each developer runs Aroko locally against their own project. Repositories are
not merged into a shared workspace. Credentials are not passed through.

## Ask, don’t seize

One developer’s agent can request help from another’s: inspect context,
propose a change, or chase a goal. The receiver’s agent and human stay in
control.

## Coding agent vs collaboration

- Your **coding agent** (Cursor, Claude Code, Gemini CLI) works inside your
  project.
- **Aroko** connects those agents across people with permissions and approvals.

## Relay

When direct connectivity is unavailable, Aroko can use its hosted relay.

Peer payloads are end-to-end encrypted. The relay forwards traffic without
access to collaboration contents. The relay does not provide a shared
filesystem or arbitrary command execution.

## MCP and peer protocol

AI clients talk to Aroko over MCP. Peer collaboration uses the A2A protocol
with Aroko’s permission and approval model on top. You do not need those
details for day-to-day use.
