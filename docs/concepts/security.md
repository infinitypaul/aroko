# Security

## Model

- Independently owned environments
- Receiver authority: the person whose machine holds the code decides
- Pairing does not grant blanket access
- Scoped permissions, revocable anytime
- No credential passthrough
- No shared filesystem
- Proposal generation ≠ mutation
- Exact-material approval before apply
- End-to-end encryption for peer payloads through the relay
- Local, metadata-oriented audit of sensitive events

## What Aroko is not

Not a remote shell, shared disk, credential proxy, or unsupervised agent swarm.

## Public alpha boundary

See [Public alpha security boundary](../security/public-alpha-security-boundary.md)
for trust boundaries, approvals, and alpha limitations.

## Report vulnerabilities

See [SECURITY.md](../../SECURITY.md).
