# Relay

Aroko can connect collaborators through its hosted relay when direct
connectivity is unavailable.

Peer payloads are end-to-end encrypted. The relay forwards traffic without
access to collaboration contents. It does not provide shared filesystem access
or arbitrary command execution.

Default after `aroko init` is relay mode. Advanced direct-url setups belong in
operator/reference workflows, not first-run onboarding.
