# Backlog

Known issues and deferred work that aren't blocking but shouldn't be lost.
Newest at top. Clear an item when it's done (git history keeps the record).

---

## `cells pool` / `cells egg` with no args silently bake an egg

Both subcommands, run bare, *bake a new generic pool egg* — they spin up a
real VM as a side effect. There's no read-only "show me the pool" form, so
anyone (or any agent) reaching for an obvious status command instead grows
the pool by one VM per call. Surfaced 2026-05-22 when a debugging session
ran `cells pool` and `cells egg` expecting a listing and created two stray
eggs.

**Fix:** no-arg `pool`/`egg` should print pool status (counts by
standing/power, ages); move baking behind an explicit `pool bake` /
`egg bake` subcommand. Harmless spare eggs get claimed or culled, but the
footgun shouldn't exist.

## pi fork-and-ask is slow and gets slower over time

`cells talk` (agent-comms) forks the peer's `main` session read-only so it
answers as itself, with full memory. pi `--fork` replays the *entire*
`main.jsonl` as context before the first token. A long-lived cell's main
grows without bound — cells-narrator's was 2.3 MB / 4.8k lines on
2026-05-21 — so fork prefill on gpt-5.5 measures 28–90s with a fat tail.
Reasoning effort barely matters (high/low/minimal all ~30s); it's the
context size. claude-code cells are unaffected (sub-5s forks).

Mitigated 2026-05-21 (`13c2249`) by raising timeouts (pi forkAndAsk
90s→150s, talk CLI default 120s→180s) — a ceiling bump, not a cure. The
cost scales with cell lifetime: every talk gets slower forever.

**Durable fix:** cap or compact fork context — fork from a recent tail of
`main`, or compact `main.jsonl` periodically. Replaying *some* context is
correct (the peer should answer as itself); replaying *all* of it forever
is not.

## hermes cells return empty text when there's no `main` session

`cells talk` defaults to forking `main`. claude-code cells get a `main`
session at birth (bake-egg.sh's session-capture warm-up); pi and hermes
create it lazily on the first real turn.

pi was fixed 2026-05-21 (`3a98e89`): forkAndAsk drops `--fork` when no
main exists and runs a fresh session. hermes still returns empty text in
the same situation (seen on the now-deleted `hbtest`).

**Fix:** give the hermes adapter the same no-main fallback, or add a
birth-time main-session warm-up for hermes the way claude-code has one.
