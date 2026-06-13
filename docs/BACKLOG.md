# Backlog

Known issues and deferred work that aren't blocking but shouldn't be lost.
Newest at top. Clear an item when it's done (git history keeps the record).

---

## A cell's worker can lag the jobs lane → `cells run` now self-heals it

A `cells run` job is rejected if the cell's `<cell>.cells.md` Worker predates
the jobs lane (its `/debug` has no `jobs` key — an old Durable Object misroutes
`kind:"job"` into the chat path). Surfaced 2026-06-13 by homezero firing Phase B
on a just-born advisor. NOTE: the per-cell Worker is deployed at BIRTH
(`birth-postwork.sh` → `deploy-cell-worker.sh`), NOT baked into pool eggs
(`bake-egg.sh` deploys no Worker) — so the original "eggs bake a stale Worker"
framing was wrong. The real gap was a fresh birth's Worker not being live/
propagated when the job fired, plus old cells carrying pre-jobs-lane Workers.

**Fixed (2026-06-13):** `cells run`, on a failed jobs-lane probe, now redeploys
the current Worker once and re-probes before submitting — self-healing instead
of dead-ending the operator with a manual command.

**Residual (low):** birth doesn't *verify* the Worker is job-capable before
finishing, and `birth-postwork`'s `worker_deploy` step is best-effort — a
silently-failed deploy still leaves a non-job-ready cell until the next
`cells run` self-heals it. A birth-time `/debug` jobs probe (warn on miss) would
close the gap proactively. Not blocking — the self-heal covers the symptom.

## Crash-failback reconcile for a project pulse

Per-project pulse (shipped 2026-06-13) fails a project's cells back to the
global pulse automatically on a **clean** `cells kill <project>-pulse` — it
re-seeds their schedules from the Mac's last-seen HEARTBEAT.md mirror. A
project pulse that **crashes** (OOM / post-wake wedge — both observed in
practice) never runs the kill path, so its cells silently stop firing until
someone notices and runs `cells heartbeat reseed <project>` by hand.

**Fix:** a Mac-driven reconcile that, on a timer, loads the registry, computes
`pulseOwner` for every cell, and re-seeds any cell whose owner is the global
pulse but which is missing from the global pulse's `pulse-cache`. Fold it into
the existing 30-min steward on mother (agent-first; no new daemon). The manual
`cells heartbeat reseed <project>` handle already exists as the building block.

## `cells heartbeat` digest is global-pulse-only

`cells heartbeat` (no args) prints `dna/specials/pulse/state/heartbeats.md`,
which is the *global* pulse's digest only. Once a project runs its own
`<project>-pulse`, that pulse's schedule rows live in its own well and don't
show up in the digest. (`cells heartbeat --tail` already aggregates fires
across every registered pulse — this is just the digest.) Low severity:
partial observability, not a correctness gap. **Fix:** aggregate per-well
`heartbeats.md` across all registered pulses, or footer-note which projects
run their own pulse and how to read it.

## ~~`cells pool` / `cells egg` with no args silently bake an egg~~ — FIXED 2026-06-13

Both subcommands, run bare, used to *bake a new generic pool egg* (spin up a
real VM as a side effect), so any status-style invocation grew the pool by
one. **Fixed:** bare `cells pool` / `cells egg` now print pool status
(routes to `cmdPoolList`); baking moved behind an explicit `cells pool bake`
(`create` kept as a back-compat alias). Unknown-subcommand usage updated.

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

## ~~forkAndAsk's 150s ceiling kills ritual-length talks~~ — CLOSED by the jobs lane (2026-06-13)

`cells run` (docs/proposals/jobs.html) is the prescribed ack-then-work
shape: submit returns a job id immediately, the work runs in a fresh
detached session under a frame-progress watchdog, completion flows back
durably. Long work belongs on jobs, not on longer talk leashes. (Note the
original entry's "`cells talk --main` is not yet implemented" line was
stale — --main shipped in `f8ca1dc` as envelope `target:"main"`; it's the
durable-conversation path, still leashed, still not for ritual-length work.)
Jobs against mother remain refused — births stay Mac-side via the
deterministic handoff.

## Proxy zero-token stream hang — root cause open (2026-06-13, from homezero)

delta-market's `claude --print --resume <main>` runs wedged at ZERO output
tokens through proxy.cells.md — ESTAB socket to Anthropic, no frames ever,
one process sat 23h40m. A fresh session answered in seconds; the next long
run wedged again, so it's not only a poisoned session. Nothing currently
detects a zero-token stream that stays open (the only filed proxy-hang
artifact was Bun.serve's idleTimeout, fixed earlier). The jobs-lane
watchdog CONTAINS this (kill + retry + visible failure) but does not
explain it. Investigate proxy-side: per-stream first-byte timeout +
logging, upstream connection reuse, Max-OAuth refresh races.

## Eval: add the negative birth row for the Max policy (2026-06-11)

`cells birth ck-pi-opus --harness=pi --model=opus` must fail at parse with
the policy message (see docs/birth-checklist.md §3). Worth a line in
eval-birth/harden-birth so a regression can't reopen the lane silently.

## Clock skew: detect stale chronyd config; close the wake window (2026-06-11)

The advisor outage (buyer messages timing out) had two layers doctor missed:
1. **Stale daemon, fixed disk**: several cells had `makestep 1.0 -1` on disk
   but a chronyd started before the fix — running with stock step-3-then-slew
   semantics, silently re-accumulating hours of skew per hibernate/wake cycle.
   Doctor compares clocks only on RUNNING cells, and these failed exactly at
   wake. Cheap detection: flag `chronyd start time < chrony.conf mtime` on any
   running cell (config changed under a live daemon = restart needed).
2. **The wake window**: chrony corrects 10–60s after wake; the wake-triggering
   inbound message is always processed inside that window. Cells-side this is
   unfixable — wells owns restore and was asked (2026-06-11) to step the guest
   clock before resuming delivery. Track that ask.
