# Security Policy

Aroko is not a sandbox. See
[`docs/security/public-alpha-security-boundary.md`](docs/security/public-alpha-security-boundary.md)
for the public-alpha security boundary.

## Reporting a vulnerability

This product repository is **public**. Prefer **GitHub Private Vulnerability
Reporting** on https://github.com/infinitypaul/aroko when that feature is
enabled by the maintainer.

If Private Vulnerability Reporting is unavailable, contact the repository owner
through an already-established private channel. Do **not** file public issues
that contain secrets, credentials, or private source.

No public security email address is published here. Do not invent one.

## What to include

- `aroko version --json`
- Redacted `aroko doctor` output
- Steps to reproduce (without secrets)
- Impact assessment if known

## Out of scope for this file

Operator configuration of GitHub Private Vulnerability Reporting, npm trusted
publishing, DNS/hosting for `aroko.dev`, and relay operations are external to
the product codebase.
