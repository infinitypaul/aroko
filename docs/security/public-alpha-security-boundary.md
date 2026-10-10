# Public alpha security boundary

**Status:** Active for the Aroko public alpha.  
**Not a sandbox.** Aroko coordinates permissioned collaboration; it does not isolate the receiver’s operating system.

## What Aroko is (alpha)

Aroko is a trust layer for collaboration between coding agents owned by different
developers. Each person keeps their own machine, provider credentials, and
repository. Collaboration is invitation-based and permissioned.

Aroko is **not**:

- a remote shell or shared filesystem
- a credential proxy or shared login
- an unsupervised multi-agent swarm
- a guarantee of sandbox isolation on the receiver’s host

## Trust model

1. Two developers each run Aroko in their own project.
2. One starts a collaboration and shares a single-use invite.
3. The other joins with that invite.
4. Capability grants bound what a peer may request (inspect, propose a change, and similar).
5. Generating a structured proposal does **not** mutate the receiver’s repository.
6. Applying a change requires the receiver’s explicit approval of the exact proposed material in the local Inbox.

## Receiver authority

The receiving developer controls:

- coding-agent provider and authentication
- workspace / repository path
- capability grants and approvals
- repository mutations (including apply of approved proposals)
- local process and path policy for sensitive actions

## Peers cannot (by design)

- obtain the receiver’s provider credentials
- choose the receiver’s provider, model, executable, or flags
- choose arbitrary filesystem paths on the receiver
- approve their own mutations
- run arbitrary shell commands by default
- trigger Aroko software updates on someone else’s machine
- perform transitive delegation by default

## Progress privacy

Operational progress may cross the collaboration boundary so peers can see useful
status. Private chain-of-thought and provider reasoning traces must not.

## Alpha limitations

- Aroko is early software. Expect rough edges; see [Known limitations](../known-limitations.md).
- Hosted relay and local networking modes have different operational trade-offs; relay mode is the default happy path.
- Provider integrations differ (for example, structured proposals are not available for every coding agent yet).
- This document describes product intent and current controls; it is not a formal audit report or certification.

## Reporting vulnerabilities

Do not post credentials, tokens, or private source in public issues.

Include:

- `aroko version --json`
- Redacted `aroko doctor` output
- Steps to reproduce (without secrets)

While this repository is **private**, report security issues only through an
already-established private channel with the repository owner.

Once this repository is **public**, use GitHub Private Vulnerability Reporting on
this repository (the operator must enable the feature).

No public security email address is published here. Do not invent one.

See also [SECURITY.md](../../SECURITY.md).
