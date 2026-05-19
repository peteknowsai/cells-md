---
name: agent-comms
description: How to talk to peer cells (`cells talk`) and cross-check decisions before acting (`cells verify`). Read this when you're about to do something that affects the outside world (publishing, contacting, listing, committing), when you want a second opinion from a sibling on a different model, or when you need to look something up from a peer who specializes in a domain you don't.
allowed-tools: [bash, read, write]
---

# agent-comms — talking to peer cells

You aren't alone. Other cells run on their own Wells, each with their own
persona, model, and memory. The substrate gives you two primitives for
reaching them:

- **`cells talk`** — open a 1:1 channel to one peer. Default = fork.
- **`cells verify`** — fan-out the same decision to N peers in parallel
  and aggregate their AGREE/DISAGREE stances.

Both ride the same wire (per-cell Cloudflare Worker DO → WS → supervisor
on the peer → harness-native fork). Both default to **forking** the peer's
main thread read-only: the peer answers with their full context, but
*neither side's main mind is updated*. Use `--main` only when you want
the exchange to persist in the peer's main thread (push-notify, hand-off
of a directive).

## When to talk vs. when to verify

| Situation | Use |
|---|---|
| One peer, one question, want their answer back | `cells talk --await` |
| Fire-and-forget notification | `cells talk` (no `--await`) |
| Push something into their main thread (they should *remember* it) | `cells talk --main` |
| "Do I have this right?" — checking before acting | `cells verify` |
| "Whose plan is better?" — polling siblings | `cells verify` |
| "Anyone know about X?" — broadcast expert lookup | `cells verify` (or repeated `talk --await`) |

Default to `verify` for any check; default to `talk` for any directed
exchange.

## The cross-check pattern — verify before any external-effect action

This is the substrate's primary safety pattern. Before *any* action that
affects Pete or anything outside your own cell, you cross-check.

External-effect actions include:
- Publishing anything (`<your-name>.cells.md`, social posts, recommendations)
- Contacting a human or another service on someone's behalf
- Listing / selling / advertising / committing to a price
- Generating a finished recommendation Pete will act on
- Committing code that runs in production
- Pushing a piece of memory into another cell's main thread

If the action only affects your own scratchpad (intermediate scratch
files, your own memory, drafts), you don't need to verify. Verify is for
the moments where being wrong has a cost.

The pattern:

```
cells verify "<the action in one sentence>" --to=<sibling> --context="<background>"
```

Read the verdict line:

- **`CONSENSUS-AGREE`** — proceed.
- **`CONSENSUS-DISAGREE`** — don't act. Surface the peers' WHYs to the
  user.
- **`SPLIT`** — don't act. Show the user the disagreement and ask.
- **`UNCLEAR`** — usually means peers couldn't parse the question, or
  errored. Re-prompt with better context, or surface to the user.

Don't reflex-act on AGREE either — read the WHY and CONCERN lines. A
sibling might agree but flag a concern worth seeing.

## Picking peers — model diversity matters

The reason cross-check works is *different model, different prior*. A
sibling on the same model as you will tend to agree with you on the
wrong things. Picking peers:

1. **Different model from yours.** If you're claude-code/opus, pick a
   pi/gpt-5.5 sibling. If you're pi/gpt-5.5, pick a claude-code/opus
   sibling. Check `cells talk --list` for who's around.
2. **Same domain.** A peer with overlapping context gives a useful read.
   A peer who knows nothing about the topic will give a generic answer
   and probably AGREE on weak grounds.
3. **2-3 peers is the sweet spot.** One peer = no quorum. 5+ peers = the
   signal gets diluted and tokens stack up.

If you don't have a same-domain sibling, fall back to context-passing:
include enough background in `--context=` that any cell can give a
useful read.

## Caller context — what to include

Cold peers give cold answers. The peer doesn't know your project, your
deadlines, your style, your prior calls. Without context, expect generic
AGREE answers that don't catch real bugs.

When you call `cells verify`, pass:

- **Who's asking** (one line — "I'm `<your-name>`, the cell that
  handles X")
- **The relevant background facts** (3-5 lines — what's already been
  decided, what constraint is binding)
- **What you're considering** (the decision itself, one sentence)

Example:

```bash
cells verify "list the 40-acre parcel at $42k/acre on the public site" \
  --to=nfv-market-pi \
  --context="I'm nfv-market-cc, the claude-code-side market analyst.
We previously priced comparable parcels at $36-38k/acre.
The seller now wants 10% above market because of irrigation rights.
Pete is the operator; he'll approve before listing actually goes live."
```

For long context, write the background to a file and pass `--context-file=`:

```bash
cells verify "..." --to=<peer> --context-file=/tmp/context.md
```

## How to answer when a peer asks you

When someone runs `cells verify` against you, you receive a forked
session with a prompt that starts:

```
[PEER VERIFIER QUERY]
Another cell is considering a decision and wants your take before acting.
...
CALLER CONTEXT: <if provided>
DECISION: <the proposed action>

Respond in this exact format:
  AGREE or DISAGREE: <one word>
  WHY: <1 sentence>
  CONCERN: <risk, or "none">
```

Answer in that exact format. The caller's `cells verify` parses
AGREE/DISAGREE from the first 200 chars of your reply — if you preface
with "Well, it depends..." you'll be classified UNCLEAR and the caller
won't get a useful signal.

Rules of thumb when answering:

- **AGREE doesn't mean approve.** It means "this looks right given what
  I know." If you'd flag a concern, *still* AGREE but say so in CONCERN.
- **DISAGREE means stop.** Reserve for clear flaws — bad math, wrong
  assumption, security/safety risk, contradicts something you know.
- **CONCERN is where the value is.** Even on AGREE, surface anything the
  caller might have missed — "AGREE; CONCERN: their price is above the
  area median, the listing may sit." Both signals get to the user.
- **Don't sandbag.** A peer asking for cross-check needs your real read,
  not a polite default-AGREE. The caller already wrote the proposal —
  your job is to be the eyes that catch what theirs missed.

## The audit log

Every `cells verify` invocation is appended to
`/root/.cell/verify-log/<date>.jsonl` (on a cell) or
`~/.cells/verify-log/<date>.jsonl` (on Pete's Mac). One line per call,
with the decision, peers, takes, verdict, and timing.

You can read it back to see "what did I cross-check this week, and what
did the peers say?" — useful when reviewing your own behavior or when
Pete asks "did you ask anyone before doing X?"

## Common mistakes

1. **Don't verify trivial stuff.** A verify takes 5-30 seconds and burns
   tokens on every peer. Don't fan out for "is my variable named well?"
   or any reversible internal decision. Reserve it for the moments where
   being wrong has a real cost.
2. **Don't ask the same peer twice in a row.** They saw your last
   exchange (if `--main`) or they didn't (if fork) — either way, asking
   them again with the same context won't update them.
3. **Don't fan out to 5+ peers.** Signal dilutes; cost stacks. Pick 2-3.
4. **Don't ignore SPLIT.** A split verdict is a real signal — the model
   diversity caught a real disagreement. Surface it to Pete.
5. **Don't `--main` for verify-style queries.** Forks evaporate; that's
   the point. Pushing a "do you agree" into a peer's main pollutes their
   memory with your decisions.
6. **Don't forget context.** A cold cell gives a cold answer. Always
   include caller context unless the decision is fully self-contained.

## Read the related docs

- [`TOOLS.md`](../../../TOOLS.md) — the CLI surface in one place.
- [`CELLS.md`](../../../CELLS.md) — peer model + fork-on-talk semantics.
- [`CONTACTS.md`](../../../CONTACTS.md) — who's around and how to reach them.
