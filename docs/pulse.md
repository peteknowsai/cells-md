# Pulse

> **Status:** plan, not yet implemented. Phase 1 of HEARTBEAT.md (declarative
> file at agent root) shipped on `4ba1952`. This doc covers the next phase:
> the agent that reads those files and triggers wake-ups.
>
> **Design has evolved since this was first drafted.** Originally pictured as
> a standalone Bun daemon. Pulse is now a real Pi agent — second proto
> alongside mother, lives at `proto/pulse/`. It reads each cell's HEARTBEAT.md
> from the **vault mirror** (already populated by `cells sync`), not via
> `sprite exec`. The daemon shape below is preserved for reference but the
> "Not a pi instance" claim is obsolete.

## Context

Each cell now ships with a `HEARTBEAT.md` at its agent root declaring its
desired wake-up schedule (default for newborns: nightly 4am dream). The
file is currently documentation-only — the existing
`cells schedule-dreams` launchd plist still drives the actual nightly
dreams, identically for every cell, with no per-cell variation.

The next step is a **pulse**: a long-running process on Pete's
Mac that reads each cell's `HEARTBEAT.md`, interprets it, and triggers
the declared wake-ups via `cells talk <name> "<wake message>"`. Replaces
the launchd-cron-for-dreams with one declarative system that scales to
arbitrary per-cell cadences.

This doc is the implementation plan. Pick it up after fresh context.

## Why a separate agent

- **Cells can't self-wake.** Sprites hibernate when idle; they have no
  cron, no scheduler. Schedules have to be enforced from outside.
- **Mother can't do it either.** Mother is print-mode-invoked per `cells`
  command; she doesn't run continuously. A scheduler needs an
  always-running process.
- **Schedules belong with the cell, enforcement belongs centralized.**
  Each cell declares what it wants in its own `HEARTBEAT.md` (browsable,
  editable, version-controlled in the vault). One central agent reads
  them all and fires them.
- **HEARTBEAT.md is interpretive, not strict cron.** Pete wants to write
  things like "every weekday at 8am, summarize the news" without
  reaching for cron syntax. The pulse is itself an LLM agent —
  it interprets prose schedules into structured fire times.

## Vision: end state

```
┌───────────────────────────────────────────────────────┐
│ Pete's Mac                                            │
│                                                       │
│  ┌───────────────────────────────────────────────┐   │
│  │ pulse daemon (launchd, always-on)         │   │
│  │  • tick loop (every ~60s)                     │   │
│  │  • cache: schedules parsed from HEARTBEAT.md  │   │
│  │  • state: ~/.cells/heartbeat.json             │   │
│  │    (last-fire time per (cell, schedule item)) │   │
│  └────┬─────────────────────────────────────┬────┘   │
│       │ reads HEARTBEAT.md                  │ fires  │
│       │ (sprite exec, ~once per change)     │        │
│       ▼                                     ▼        │
│   each cell                           cells talk     │
│                                                       │
└────────────┬──────────────────────────────────────────┘
             │ sprite exec / cells CLI
             ▼
        cells (remote Sprites)
        ├─ pete: HEARTBEAT.md (4am dream, weekdays 8am news)
        ├─ scott: HEARTBEAT.md (4am dream, hourly poll)
        └─ ...
```

Pete edits a cell's `HEARTBEAT.md` (directly via shell, or by asking the
cell during conversation, or via the vault). Within ~minute the heartbeat
agent notices and updates its schedule cache. The cell wakes when its
declared time arrives.

## Architecture

### Shape

A standalone TypeScript daemon under launchd. **Not** a pi instance —
there's no need for it to be a long-lived agent with its own persona.
It's a scheduler with an LLM call as one of its tools. Most of its
time is spent sleeping; LLM calls are rare.

Lives at `cli/heartbeat.ts` (sibling to `cli/cells.ts` and `cli/proxy.ts`).
Bun runtime, same toolchain.

### Tick loop

```
every 60 seconds:
  registry = read ~/.cells/cells.json
  for cell in registry.cells:
    raw = read ~/.cells/heartbeat-cache/<cell>.md (last-known content)
    fresh = sprite exec <cell> -- cat /home/sprite/agent/HEARTBEAT.md
    if hash(fresh) != hash(raw):
      schedule = interpretViaLLM(fresh, cell)  // pi -p with a parser prompt
      save schedule to ~/.cells/heartbeat-cache/<cell>.json
      save fresh to ~/.cells/heartbeat-cache/<cell>.md
    schedule = read ~/.cells/heartbeat-cache/<cell>.json
    state = read ~/.cells/heartbeat.json
    for item in schedule:
      if item is due now AND state.lastFire[(cell, item.id)] < item.dueAt:
        cells talk <cell> "<wake message from item>"
        state.lastFire[(cell, item.id)] = now
    save state
```

Polling cells via sprite exec is cheap (~100ms; doesn't wake the cell
because sprite exec runs against persistent storage, not the Pi
process). With 60s ticks and ~10 cells, that's ~600 short reads/min —
trivial.

### LLM interpretation

The tick loop only invokes the LLM when a `HEARTBEAT.md` actually
changes (hash compare). The prompt:

> Given this `HEARTBEAT.md`, return a JSON array of schedule items.
> Each item: `{id, cron, message}` where `cron` is a five-field crontab
> string and `message` is what to send via `cells talk` when the item
> fires.

Returned schedule gets cached. Tick-time becomes pure compute (cron-eval +
state-compare). Re-interpretation only on file change → low API cost.

Use `pi -p` for the call so it goes through use-max → Pete's Max sub.
No extra-usage charges.

### Firing

Heartbeat daemon shells out to `cells talk <name> "<msg>"`. The on-Mac
`cells` CLI is on PATH. Same path mother uses; no new mechanism.

The `<msg>` is the natural-language phrase from the schedule item. Cell
receives it via its main Pi session (visible to Pete in his tmux), responds
or executes. Treats it the same as if Pete typed it.

### State

`~/.cells/heartbeat.json`:

```json
{
  "lastFire": {
    "pete:nightly-dream": "2026-05-02T04:00:12Z",
    "pete:weekday-news": "2026-05-01T08:00:08Z",
    "scott:nightly-dream": "2026-05-02T04:00:18Z"
  },
  "lastTick": "2026-05-02T11:23:00Z"
}
```

Schedule cache: `~/.cells/heartbeat-cache/<cell>.{md,json}` — raw + parsed.

State files survive daemon restart so a launchd cycle doesn't replay.

### launchd

`cells schedule-heartbeat` installs a launchd plist that runs the daemon
under `KeepAlive=true`. Replaces (eventually) `cells schedule-dreams`,
which becomes redundant.

Migration: keep `schedule-dreams` plist functional through Phase 2; only
remove it in Phase 3 once the pulse is proven for nightly dreams.

## Phases

### Phase 1 — minimum viable daemon

- `cli/heartbeat.ts`: tick loop, cron eval, state file, launchd plist
- Hardcoded schedule per cell: nightly 4am dream (matches today's
  `cells schedule-dreams` behavior)
- No HEARTBEAT.md interpretation yet — proves the daemon shape works
- `cells schedule-heartbeat` and `cells unschedule-heartbeat` commands
- Run alongside existing `schedule-dreams` for a week; compare logs

### Phase 2 — HEARTBEAT.md interpretation

- Polling loop reads each cell's HEARTBEAT.md, hash-compares
- LLM interpretation on change → cached schedule
- Fire from cached schedule
- Retire `schedule-dreams` once Phase 2 proves stable

### Phase 3 — nice-to-haves

- Web UI / status page (extends mother proxy at `mother.cells.md/heartbeat`)
- Per-cell logs viewable via `cells heartbeat status [<name>]`
- Push notifications via the existing mother proxy when an item fires
- Mac notifications (osascript `display notification`) when an item fails

## Critical files (for the implementer)

| Path | Purpose |
|---|---|
| `cli/heartbeat.ts` | NEW — the daemon |
| `cli/cells.ts` | extend with `schedule-heartbeat` / `unschedule-heartbeat` commands; mirror the pattern in `cmdScheduleDreams` (around line 1171) |
| `~/.cells/heartbeat.json` | runtime state (lastFire per item) |
| `~/.cells/heartbeat-cache/<cell>.{md,json}` | schedule interpretation cache |
| `~/Library/LaunchAgents/com.pete.cells-heartbeat.plist` | launchd config |
| `cli/proxy.ts` | optional Phase 3: `/heartbeat` endpoint for status |

Reuse:
- `loadRegistry()` and `cells.json` shape — already in `cli/cells.ts`
- `spriteExecCapture()` — for reading remote HEARTBEAT.md
- `plistPath()` and `buildPlist()` patterns — copy and adapt for heartbeat plist
- `cells talk` — invoke via `Bun.spawn` for firing

Key dependencies for cron eval: a small library like
[`cron-parser`](https://www.npmjs.com/package/cron-parser) handles
"is this cron string due in [now-60s, now]?" cleanly. Don't roll your own.

## Detection of HEARTBEAT.md changes

Phase 2 uses **polling** — every 60s the daemon reads each cell's file
and hash-compares. Considered alternatives:

- **Push via mother proxy.** Cell hits `mother.cells.md/heartbeat` on
  HEARTBEAT.md write, daemon reads file off shared Mac filesystem.
  Lower latency but requires cell-side coordination (a hook or wrapper
  around the file write). Defer to Phase 3 if polling latency hurts.
- **Sync-driven.** Watch the vault for HEARTBEAT.md changes (fs.watch).
  But sync is on-demand, not continuous — bad fit.
- **No detection at all.** Reinterpret HEARTBEAT.md on every tick.
  Burns API calls; rejected.

Polling is cheap at the tick cadence we need (~60s) and on the cell
count we have (~handful). Pete edits HEARTBEAT.md rarely; ~minute
latency on schedule changes is fine.

## Open questions

- **Concurrency.** If a previous tick is still running (slow LLM
  call during cache miss), should the next tick skip or queue?
  Lean: skip. State file records lastTick; if too recent, skip.
- **Failures.** When `cells talk` fails (cell unreachable, sprite
  asleep + slow wake), what happens? Lean: log to
  `~/.cells/logs/heartbeat.log`, retry next tick (cron eval gives a
  small window where the item is still "due").
- **Time zones.** HEARTBEAT.md says "8am" — local Mac time? UTC?
  Lean: local Mac time (where pulse daemon runs). Document this
  in the default HEARTBEAT.md template.
- **What to do on cell destroy?** Clear cached schedule + lastFire
  entries for that cell. Plumb into `cmdKill`.
- **Do we want HEARTBEAT.md content in the agent's systemPrompt?**
  Currently no — it's pure observability for the pulse.
  The cell doesn't need to know its own schedule unless it's going to
  reason about it. Keep out of use-max composer for now.

## Backstop / fallback

If the pulse breaks, cells still wake when Pete uses them
manually (cells talk / cells stream). The only thing missed is
scheduled wake-ups. Failure is recoverable. Worst case for Phase 2:
revert to `schedule-dreams` plist while debugging.

## References

- HEARTBEAT.md split commit: `4ba1952`
- Existing dream cron: `cli/cells.ts:1171` (`cmdScheduleDreams`)
- OpenClaw HEARTBEAT.md inspiration:
  https://docs.openclaw.ai/reference/templates/AGENTS (their version is
  active polling by an always-running agent; ours is reactive +
  externally enforced — see `CELLS.md` discussion in the squash commit).
