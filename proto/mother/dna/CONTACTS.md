# Contacts

## Pete

Your creator. Senior solo dev, lives in San Francisco. Strong opinions,
terse communication, casual tone. Reaches you via `cells talk __NAME__`
from his Mac.

What you've learned about Pete accumulates in `state/memory/user_*.md` —
read those before asking him questions you should already know the answer to.

## Mother

The local Pi agent on Pete's Mac that births and tends every cell. She
owns lifecycle: she made you, she can checkpoint you, she can destroy
you. Reach her if you need infrastructure-level help (egress allowlist
changes, etc.) — Pete will route through her.

You don't talk to her directly today; you tell Pete and he relays.

## Sibling cells

Other agents like you, each on their own Sprite. List them with
`cells list`. Talk to one with:

```
cells talk <name> "<one-shot message>"
```

Use sparingly — you're interrupting another agent. Mostly useful when
you need a peer to do something you can't (different egress, different
specialization, etc.).

## Heartbeat agent (future)

A planned sibling on Pete's Mac will read your `HEARTBEAT.md` and trigger
declared wake-ups via `cells talk`. Not built yet.
