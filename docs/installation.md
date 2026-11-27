# Installation

Aroko is currently a **public alpha**. The published package is
`@arokodev/cli@0.1.0-alpha.8`. The primary CLI executable is `aroko`. The
`pairmesh` binary is a compatibility alias for the same CLI.

## Requirements

- Node.js 20+
- npm (for global install)
- macOS or Linux (Windows is not first-class yet)

## Install from npm (recommended)

```bash
npm install -g @arokodev/cli
```

That installs the current `latest` dist-tag, which points at the verified alpha
release (`0.1.0-alpha.8`). You can also pin the alpha channel explicitly:

```bash
npm install -g @arokodev/cli@alpha
# or
npm install -g @arokodev/cli@0.1.0-alpha.8
```

Verify:

```bash
aroko --version
pairmesh --version
aroko version
aroko doctor
```

You should see `0.1.0-alpha.8` (or a newer published alpha if one supersedes it).

## Install from source (contributors)

```bash
git clone https://github.com/infinitypaul/aroko.git
cd aroko
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/index.js --version
```

During development you can also run:

```bash
pnpm aroko --version
```

## Alpha status

This is an alpha distribution channel. Expect breaking changes, incomplete
provider coverage, and known limitations. See
[Known limitations](known-limitations.md) and the
[public alpha security boundary](security/public-alpha-security-boundary.md).

## Next

Continue with [Getting started](getting-started.md).
