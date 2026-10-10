# Start a collaboration

## What you are doing

You create a session and share a single-use invite so a teammate can join.

## Command

```bash
aroko connect
```

Choose **Start a collaboration**.

Or directly:

```bash
aroko create
```

If Aroko is not running, `connect` can start it for you.

## What Aroko shows

- Session code
- A join command to share (starts with `aroko join …`)
- Invite expiry

Share the join command over a channel you trust. The invite works once.
Need another invite later?

```bash
aroko invite
```

## Permissions

Create uses conservative invite defaults (inspection may be allowed for the
session; mutating actions stay denied until you widen them). Widen only when
you intend to:

```bash
aroko permissions
```

## What happens next

Your teammate runs the join command. Then either of you can `aroko ask`,
review with `aroko requests`, and approve in `aroko open`.

## Security decision that stays yours

Granting broader permissions and approving mutations — always local to you.
