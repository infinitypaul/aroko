# Known limitations

Aroko is early. Expect rough edges.

## Platforms

- macOS and Linux first
- Windows is not first-class yet

## Providers

- Cursor: inspection, progress, structured proposals (apply is separate)
- Claude Code: collaboration via MCP; approvals stay in local Inbox
- Gemini CLI: inspection; structured proposals not supported yet

## Collaboration

- Permissions and approvals are explicit by design — that can feel slower than
  “just share the repo”
- Direct networking may need extra configuration; relay mode is the default
  happy path

## Product scope

Aroko is not a shared filesystem, remote shell, or unsupervised multi-agent
orchestrator.
