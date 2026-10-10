# Contributing

Thanks for helping improve Aroko.

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
```

## Guidelines

- Keep MCP as the AI-client boundary and A2A as the peer protocol
- Do not weaken receiver authority or approval requirements
- Prefer clear user-facing language in CLI and docs
- Add tests for behavior changes

## Pull requests

Open PRs against this repository. Maintainers integrate changes through the
project’s release process.
