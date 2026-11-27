# Known limitations

Aroko is a **public alpha** (`npm install -g @arokodev/cli` → currently
`0.1.0-alpha.8`). Expect breaking changes and incomplete coverage.

## Platforms

- macOS and Linux first
- Windows is not first-class yet

## Distribution

- Install from npm: `npm install -g @arokodev/cli`
- `latest` and `alpha` dist-tags currently resolve to `0.1.0-alpha.8`
- Source builds are for contributors (see [Installation](installation.md))

## Providers

- Cursor: inspection, progress, structured proposals (apply is separate; ACP
  proposal generation is read-only)
- Claude Code: collaboration via MCP; approvals stay in the local Control Center /
  Inbox (MCP cannot approve)
- Gemini CLI: inspection; structured proposals not supported yet
- ChatGPT Web / remote “Plane B” requester: deferred

## Collaboration

- Permissions and approvals are explicit by design — that can feel slower than
  “just share the repo”
- Direct networking may need extra configuration; relay mode is the default
  happy path
- Hosted relay: `wss://relay.aroko.dev/` (single-relay alpha envelope)

## Product scope

Aroko is not a shared filesystem, remote shell, unsupervised multi-agent
orchestrator, org/billing platform, or sandbox.

## Compatibility names

- CLI: `aroko` primary; `pairmesh` alias
- Local state path remains `.pairmesh/` in alpha
