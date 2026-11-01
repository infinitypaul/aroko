# Installation

Aroko is currently an **alpha**. The primary CLI executable is `aroko`. The
`pairmesh` binary is a compatibility alias for the same CLI.

## Requirements

- Node.js 20+
- [pnpm](https://pnpm.io) 10.15.1 (via Corepack is fine)
- macOS or Linux (Windows is not first-class yet)

## npm registry (not available yet)

`@arokodev/cli` has **not** been published to the npm registry.

```bash
# NOT AVAILABLE YET — do not run; this will fail until publication
# npm install -g @arokodev/cli
```

When a public npm release is authorized, install docs will be updated to make
that path the recommended option.

## Install from source (current)

These commands were verified on a clean checkout of this repository:

```bash
git clone https://github.com/infinitypaul/aroko.git
cd aroko
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/index.js --version
```

You should see `0.1.0-alpha.7` (or the version in this checkout).

During development you can also run:

```bash
pnpm aroko --version
```

The compatibility alias is the same binary after packaging; from a source
checkout, invoke `node apps/cli/dist/index.js` (or `pnpm aroko`) as `aroko`.

## Verify

```bash
node apps/cli/dist/index.js doctor
```

Doctor checks project config, runtime health, and coding-agent availability.

## Next

Continue with [Getting started](getting-started.md).
