# Security Policy

Aroko is not a sandbox. See
[`docs/security/public-alpha-security-boundary.md`](docs/security/public-alpha-security-boundary.md)
for the public-alpha security boundary.

## Reporting a vulnerability

**While this repository is private:** report security issues only through an
already-established private channel with the repository owner. Do not file
public issues that contain secrets, credentials, or private source.

**Once this repository is public:** use GitHub Private Vulnerability Reporting
on this repository (operator must enable the feature). That channel is the
intended public-alpha security reporting path.

No public security email address is published here. Do not invent one.

## What to include

- `aroko version --json`
- Redacted `aroko doctor` output
- Steps to reproduce (without secrets)
- Impact assessment if known

## Out of scope for this file

Operator configuration of GitHub Private Vulnerability Reporting, npm trusted
publishing, and repository visibility are external to the product codebase.
