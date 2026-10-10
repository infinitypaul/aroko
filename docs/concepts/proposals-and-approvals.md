# Proposals and approvals

## Propose is not apply

A peer may ask your agent to **propose** a change. Proposal generation is
read-oriented: it produces an artifact for you to review. It does not write
your tree by itself.

Applying a change is a separate, receiver-controlled action.

## Exact approval

Before a mutation runs, you approve the exact material in your local Inbox:

```bash
aroko open
```

Approve Once applies that request. Deny rejects it. Remote peers cannot approve
on your behalf.

## Typical flow

1. Peer: `aroko ask <you> --propose "…"`
2. Your agent produces a proposal artifact
3. You review and Approve Once (or Deny)
4. Only then may apply proceed under your policy
