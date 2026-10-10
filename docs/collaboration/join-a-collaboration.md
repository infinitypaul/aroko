# Join a collaboration

## What you are doing

You join a teammate’s session with a single-use invite they shared.

## Command

```bash
aroko connect
```

Choose **Join a collaboration**, then paste the join command (or session code
plus invite secret).

Or directly:

```bash
aroko join <session-code> --invite <secret>
```

Relay mode (default after `aroko init`) does not need a peer URL. Direct
connectivity may require `--peer <url>`.

## What Aroko asks

- Join command or session code
- Invite secret (if not embedded in the paste)
- Peer URL only when needed (blank for relay)

## What happens next

You see session status and peers. Your teammate remains the authority for
their environment; you remain the authority for yours.

## Security decision that stays yours

Accepting the invite applies that invite’s grant template only. Further access
still requires explicit grants and approvals on each side.
