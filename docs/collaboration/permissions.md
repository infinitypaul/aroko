# Permissions

Pairing is not blanket access. Each capability is granted explicitly by the
receiver.

## View current grants

```bash
aroko permissions
```

## Grant or tighten

```bash
aroko permissions grant <peer> <capability>
aroko permissions revoke <peer> <capability>
aroko permissions require-approval <peer> <capability>
```

Common capabilities use names such as `repository.inspect` and
`change.propose`. Mutating actions typically need Inbox approval even when
policy allows them.

## Approvals

When something needs your decision:

```bash
aroko requests
aroko open
```

Approve Once or Deny in the local Inbox — not from a remote peer’s machine.

## Rule of thumb

Paul asks Kelvin. Kelvin decides what Kelvin’s agent may do.
