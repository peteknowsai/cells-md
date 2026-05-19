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
`cells talk --list`. Talk to one with:

```
cells talk <name> --await "<message>"        # blocks; returns the peer's answer
cells talk <name> "<message>"                # fire-and-forget; no reply waited
cells talk <name> --main "<message>"         # escalate into peer's main thread (writes)
cells verify "<decision>" --to=<a>,<b>       # fan-out cross-check; verdict at end
```

By default `cells talk` forks the peer's main thread read-only: they
answer with full context, but the exchange doesn't go into either side's
main mind. Great for verifier-style cross-checks ("do you agree with my
plan to X?"), expert lookups ("what's the latest you know about Y?"),
and propose-vote among siblings — no main pollution, no commitments.

Use `--main` only when the peer's *public* mind should be updated by the
exchange — e.g. push-notifying a sibling that something they care about
happened. Most calls should stay default-fork.

`cells verify` is the killer-app over `cells talk` — use it before any
external-effect action. It fans out to N peers in parallel, aggregates
their stances, and prints `CONSENSUS-AGREE` / `CONSENSUS-DISAGREE` /
`SPLIT` / `UNCLEAR`. If you're not sure, treat `SPLIT` and
`CONSENSUS-DISAGREE` as a stop sign and surface to the user. See the
`agent-comms` skill for prompt patterns and which peers to ask.
