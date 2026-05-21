# Backlog

Known issues and deferred work that aren't blocking but shouldn't be lost.
Newest at top. Clear an item when it's done (git history keeps the record).

---

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

## pi / hermes cells have no `main` session until first conversed with

`cells talk` defaults to forking `main`. claude-code cells get a `main`
session created at birth (bake-egg.sh's claude session-capture warm-up).
pi and hermes cells do not — their `main` is created lazily on the first
real turn. So `cells talk` to a pi/hermes cell that has never been talked
to fails: pi errors `main session not found`, hermes returns empty text.
Seen 2026-05-21 on `wells` (pi) and `hbtest` (hermes).

**Fix:** add a birth-time main-session warm-up for pi and hermes, the same
way claude-code already does it — or make forkAndAsk fall back to a fresh
(empty-fork) session when no `main` exists yet.
