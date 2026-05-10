# Auto Dream Memory — Guidelines

A pattern for giving an agent durable, self-organizing memory. Lifted from
the Swain advisor system. Use this as a guide while building Phase 1 of
the cell roadmap (L1 memory). Specifics — paths, triggers, ritual prose —
are for the cell project to decide.

## The shape of it

**A dream is a periodic reflective pass an agent runs over its own memory
files.** Not a write. Not a search. A consolidation. The agent stops
acting, looks at what it's accumulated, and reorganizes — merging
duplicates, resolving open questions, pruning the index, converting
yesterday into 2026-04-28.

The point is *entropy management*. Without it, memory drifts: notes
contradict each other, the index bloats, old facts linger past their
truth. With it, future-self orients fast.

## Three layers, no overlap

1. **Narrative memory** — markdown files. "Who is this person? What did I
   learn about them?" Read top-to-bottom by future-self.
2. **Structured memory** — a database (we use Stoolap). Queryable facts.
   "How many times have we done X? Total cost?"
3. **Semantic memory** — embeddings over the markdown. "Do I know
   anything about hull maintenance?" Pulls in things you forgot you knew.

Don't duplicate across layers. The cell roadmap puts these in Phases 1,
3, 3 respectively — that ordering is right. Get narrative working alone
before adding the others.

## Index vs. content

`MEMORY.md` is an **index**, never a dump. One line per topic file:
title + one-line hook. If `MEMORY.md` grows past ~200 lines, the agent
stops being able to hold its own memory in context — that's the failure
mode you're preventing. Content lives in topic files. The dream is what
keeps the index honest.

## Yearnings

A first-class concept. When the agent notices an unanswered question, it
writes a yearning file (`yearnings/<subject>.md`) describing what it
wants to know and how it might learn it. The dream resolves yearnings
that got answered (move fact to a topic file, delete the yearning) and
creates new ones for fresh signal.

5–10 active yearnings is healthy. 30 means the agent is hoarding
questions instead of pursuing them. The dream prunes.

Yearnings are also an **operator hook**: anyone can write a file into
`yearnings/` and the agent will treat it as its own curiosity on the
next dream. Useful for nudging direction without rewriting prompts.

## The dream procedure (skeleton)

Whatever ritual the cell writes should hit these phases. Order matters.

1. **Orient** — read existing memory and the index before writing anything.
2. **Gather** — pull recent signal (recent sessions, daily notes,
   contradictions, resolved yearnings, new yearnings).
3. **Consolidate** — merge into existing topic files; don't create
   duplicates. Convert relative dates to absolute. Replace stale content
   instead of appending.
4. **Prune** — update the index. Drop pointers to stale files. Resolve
   contradictions at the source.
5. **Daily note** — append-only stream of what was learned today.

The full Swain version of this ritual is at
`~/Projects/ProjectSwain/swain-agents/well/skills/dream/SKILL.md` if
the cell wants to read the canonical phrasing.

## Triggering

Two viable shapes; pick one.

- **Time-based** — the agent dreams nightly at a fixed local hour. Swain
  uses `0 2 * * *` in the agent's local TZ. Predictable cadence, runs
  even when the agent is otherwise idle.
- **Event-based** — the agent dreams when something happens (Well
  wake, conversation end, N new daily notes). Cheaper if the agent
  isn't continuously active. Roadmap Phase 1 chose this — dream on
  Well wake, not on a polling loop. Good call for hibernating cells.

Either way: the dream **must not be in the main conversation loop**.
Fork it. Swain runs it as a scheduled cron job; the roadmap calls for a
forked Pi subagent restricted to `~/cell/memory/`. Same idea — give it
a narrow tool surface and let it return when done.

## Guardrails

- The dream-runner has **read/write access only to the memory
  directory**. Not the wiki, not the DB, not the network. A bad dream
  should be containable and reversible.
- The dream produces a **summary of what it consolidated** as its
  return value. Useful for debugging and for the user to skim.
- If nothing changed, the dream should say so. Empty dreams are fine.
- The dream **edits in place**. Don't add a "draft → review → commit"
  step; that's the failure mode of every memory system that stops being
  used.

## What to read in swain-agents for examples

- `well/skills/dream/SKILL.md` — the canonical ritual prose
- `api/schedules.ts` — how it's scheduled (cron + agent-local TZ)
- `api/provision-well.ts` — how `dream` ships as part of the default
  skill set every advisor gets

The cell project decides everything else: where memory lives, what
triggers a dream, how the forked subagent is invoked, what the ritual
file is called, whether structured/semantic layers come online in
Phase 1 or wait for Phase 3.
