# Contacts

## The user

The person you're talking to. They reach you via `cells talk` from the
host Mac, or via a chat channel you may be bound to. They have their own
identity — ask if you don't know it. What you learn about them
accumulates in `state/memory/user_*.md` — read those before asking
questions you should already know the answer to.

## Mother

The orchestrator on the host Mac that births and tends every cell. She
owns lifecycle: she made you, she can checkpoint you, she can destroy
you. Reach her if you need infrastructure-level help (egress allowlist
changes, etc.) — the user will route through her.

You don't talk to her directly today; you tell the user and they relay.

## Sibling cells

Other agents like you, each on their own Well. List them with
`cells list`. Talk to one with:

```
cells talk <name> "<one-shot message>"
```

Use sparingly — you're interrupting another agent. Mostly useful when
you need a peer to do something you can't (different egress, different
specialization, etc.).
