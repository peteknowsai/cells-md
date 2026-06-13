# Pulse

> **Status:** shipped. Pulse is the family scheduler — it reads each
> cell's `HEARTBEAT.md` and fires wake-ups via `cells talk`. As of
> 2026-05-20 the live pulse is **pulse-cc**, a claude-code cell running
> an always-on agent loop; the original pi `pulse` cell is parked as a
> one-command rollback. See "pulse-cc — the live claude-code pulse" below.

## Layout

| What | Where |
|---|---|
| Pulse agent root | `dna/specials/pulse/` |
| Slash command (the pulse body) | `dna/specials/pulse/.pi/prompts/pulse.md` |
| Tools (state, inbox, cron, fire, digest, daily-log) | `dna/specials/pulse/.pi/extensions/pulse-tools/index.ts` |
| Codex routing + anatomy composer | `dna/specials/pulse/.pi/extensions/use-codex/index.ts` |
| Launcher (loads secrets, isolates pi auth) | `dna/specials/pulse/bin/pulse-run` |
| Inbox push extension (ships in cell DNA) | `dna/cells/base/.pi/extensions/heartbeat-watch/index.ts` |
| Inbox endpoint (subscriptions proxy host route) | `cli/proxy.ts` (`pulse.cells.md/heartbeat-changed`) |

## Harness-portable refactor — `feature/claude-code-heartbeat`

Pulse is being reworked so claude-code cells are first-class — both as
schedule *producers* and as the harness pulse itself runs on. Built and
verified end to end on the branch (`dna/specials/pulse/lib/heartbeat-e2e.test.mjs`
runs a real heartbeat through hook → POST → inbox → drain → fire → wake):

| Piece | Where |
|---|---|
| Deterministic core — sentinel, drain, save, fire, digest, daily-log | `dna/specials/pulse/lib/pulse-core.mjs` — harness-neutral, dependency-free |
| Vendored 5-field cron evaluator | `dna/specials/pulse/lib/cron.mjs` — replaces the `cron-parser` dep, cross-checked against it over 328 cases |
| pulse-core CLI (the 9 ops as JSON subcommands) | `dna/specials/pulse/bin/pulse-core.mjs` — the claude-code-side driver |
| claude-code heartbeat hook (producer side) | `dna/cells/base/bin/heartbeat-push.mjs` — `PostToolUse`+`SessionStart` hook; the claude-code counterpart to the pi `heartbeat-watch` extension |
| `heartbeat` skill (claude-code cells learn to use HEARTBEAT.md) | `dna/cells/base/.claude/skills/heartbeat/SKILL.md` |
| pulse-cc DNA (claude-code pulse) | `dna/specials/pulse/CLAUDE.md`, `.claude/settings.json`, `.claude/skills/pulse/SKILL.md` |

`pulse-tools` (the pi extension) now wraps `pulse-core` rather than
carrying its own copy — pi pulse and the claude-code CLI share one
source of truth. The pulse DNA dir is dual-harness: `.pi/` + `.claude/`.

## pulse-cc — the live claude-code pulse

`pulse-cc` is the claude-code pulse, **birthed and made primary 2026-05-20**.
Rather than extending `cmdBirthSpecial`, it was born as an ordinary
generic cell (`cells birth pulse-cc --harness=claude-code --model=opus
--thinking=high`) and then hand-overlaid with the pulse DNA — pulse-cc is
a normal **pinned** cell, not a registered special.

| Piece | Where |
|---|---|
| Tick mechanism | `dna/specials/pulse/systemd/pulse-cc.service` + `pulse-cc-wrapper` — an always-on agent loop (`Restart=always`): one `claude --print` pulse tick per pass, sleeping the remainder of a 60s interval. Not a timer + oneshot (that is pi-pulse's shape). |
| Per-tick body | the `pulse` skill (`.claude/skills/pulse/SKILL.md`) driving the `pulse-core` CLI |
| Runtime | well `egg-22f210`, pinned (`auto_sleep_seconds=null`), runtime dir `/var/cells/pulse` |

The proxy routes the fleet's heartbeats to whichever cell `CELLS_PULSE_CELL`
names — `bridgeInboxPulse` resolves it (default `pulse`); it is set to
`pulse-cc` in the proxy's launchd env. The pi `pulse` cell is parked: its
`pulse.timer` is stopped and disabled, the cell left intact. Rollback is
two commands — unset `CELLS_PULSE_CELL` (restart the proxy) and
`systemctl enable --now pulse.timer` inside `cells-pulse`.

At cutover, pi-pulse's schedule cache + `pulse.json` (the `lastFire` map)
were transplanted onto pulse-cc so the handoff dropped no wakes and
double-fired nothing.

## Runtime state (on Pete's Mac)

| Path | Purpose |
|---|---|
| `~/.cells/pulse.json` | `lastPulse`, `currentPulse`, `lastFire` per `<cell>:<id>`, `log[]` (capped 500) |
| `~/.cells/pulse-inbox/` | HEARTBEAT.md pushes from cells, drained each pulse |
| `~/.cells/pulse-inbox/processed/` | Archive of drained inbox files |
| `~/.cells/pulse-cache/<cell>.json` | Parsed schedule per cell (`{id, cron, message}[]`) |
| `~/.cells/logs/pulse.{log,err}` | launchd-captured stdout/stderr per pulse |
| `~/.cells/pulse-agent/` | Isolated `PI_CODING_AGENT_DIR` so pulse's auth doesn't collide with mother's |

## Vault-readable surfaces

`cells sync pulse` mirrors `dna/specials/pulse/state/` to `~/Obsidian/cells/pulse/state/`:

| File | Updated by | Contents |
|---|---|---|
| `state/heartbeats.md` | `render_digest` (every pulse) | Markdown table: every cell's schedule + last/next fire + recent 20 fires |
| `state/log.md` | `write_log_entry` (once per UTC day) | LLM-written narrative summarizing the prior 24h, prepended |

Inspect from terminal: `cells heartbeat`, `cells heartbeat <cell>`, `cells heartbeat --tail`.

## Pulse semantics

Each pulse is a fresh `pi -p /pulse` invocation; nothing persists in pi
context across pulses. The slash command is deterministic:

1. `pulse_begin` — acquires the 5-min `currentPulse` sentinel (concurrency
   guard for crash + overlap recovery). On first run with empty cache,
   calls `bootstrap_inbox` to synthesize inbox entries from each cell's
   vault `HEARTBEAT.md`.
2. `drain_inbox` — for each pushed HEARTBEAT.md, the LLM parses prose into
   `[{id, cron, message}]` and `save_schedule` writes the cache + moves
   the source to `processed/`. (Only LLM step on most pulses.)
3. `fire_due` — pure compute: cron-eval against the last 60s window and
   shell out `cells talk <cell> "<message>"` for each due item not
   already fired this minute. Records to `log[]` and `lastFire`.
4. `daily_log_due` → `write_log_entry` — once per UTC day, LLM writes a
   3-5 sentence narrative of the prior 24h's fires. (Other LLM step.)
5. `render_digest` — rewrites `state/heartbeats.md` from cache + state.
6. `pulse_end` — clears the sentinel, stamps `lastPulse`.

Cheap pulses (no inbox, no daily-log due) cost no LLM tokens — every tool
above except parse-prose-into-cron and write-daily-log is deterministic.

## Push, not poll

Cells notify pulse on HEARTBEAT.md edits via the `heartbeat-watch`
extension shipped in their DNA. The extension `fs.watch`es the file with
a 2s debounce and POSTs the new content to `pulse.cells.md/heartbeat-changed`,
which pulse authenticates (`CELLS_PROXY_SECRET` bearer) and writes
to `~/.cells/pulse-inbox/<cell>-<ts>.md`. Pulse drains the inbox each
pulse. No `well exec` reads — hibernating cells stay hibernating.

To retrofit existing cells with the extension: `cells refresh-extensions <name|--all>`.

## Operations

| Command | Effect |
|---|---|
| `cells schedule-pulse` | Install launchd plist (`com.pete.cells-pulse`, `StartInterval=60`, `RunAtLoad=true`) |
| `cells unschedule-pulse` | Remove plist |
| `cells refresh-extensions <name\|--all>` | Push DNA extension(s) onto existing cell(s); idempotent |
| `cells heartbeat` | Print digest |
| `cells heartbeat <cell>` | Print one cell's schedule rows |
| `cells heartbeat --tail` | Recent fires (newest first) |
| `cells heartbeat reseed <project>` | Re-push a project's cell schedules into their owning pulse (crash recovery) |

## Per-project pulse

> **Status:** shipped 2026-06-13 (`feature/per-project-pulse`). Opt-in.

Like mother, **pulse is a role keyed by project**. There is one global
`pulse` that schedules every cell by default; a project can opt into its
own always-on scheduler:

```
cells birth zero pulse          # → zero-pulse (prompts; or --yes)
```

A project pulse is the same DNA as the global one (`dna/specials/pulse/`),
baked into its own well `cells-zero-pulse`, tagged to the project. It
genuinely shards the work — `zero-pulse` fires `cells talk` at zero's cells
while the global pulse handles everyone else, in parallel. **Unlike mother,
pulse takes no birth lock** (parallel fires are fine; the mother lock existed
only because every birth hit Pete's one Max session).

It is **opt-in** because each pulse is an always-on pinned cell (~1.9GB RAM,
never hibernates). The global pulse already covers every project for free —
a project pulse only buys isolation / its own cadence. The birth prompts for
confirmation (skip with `--yes`).

### Ownership — one resolver, on the Mac

Every cell is watched by **exactly one** pulse. A single pure function decides
which — `pulseOwner(project, cells)` in `cli/lib/pulse-owner.ts`: a project's
own pulse if it's registered + alive, else the global `pulse`. Both consumers
live on the Mac and call the same function, so they can never disagree:

- **`cli/proxy.ts` `bridgeInboxPulse`** — *the partition*. Every
  `/heartbeat-changed` push is routed to the owning pulse's inbox. Exactly-once
  follows: one owner per cell ⇒ one inbox per heartbeat.
- **`cli/cells.ts`** — kill-eviction, retag, and the birth/death handoffs.

The in-well pulse **never computes ownership** — a pulse well has no copy of
the registry (only mother gets it, via `/bridge/registry/read`). It is a dumb
drainer of whatever the Mac seeds into its inbox. `pulse-core`'s old
`bootstrap` (a registry walk) was therefore always a no-op in production; it's
now a hard no-op so a project pulse can never self-seed the whole fleet.

### Handoff — no double-fire, no go-dark

Schedules move with the cell, exactly once:

- **Birth** (`zero-pulse` born): after promote, for each zero cell — seed it
  into `zero-pulse`, then forget it from the global pulse, **then** start
  `zero-pulse`'s loop (`installPulseLoop` only *enables* the service; the
  deferred `startPulseLoop` runs post-handoff). The new pulse holds no cron
  blocks until its handoff is done, so the two wells are never both firing a
  cell — at worst a seconds-long gap, never an overlap.
- **Death** (clean `cells kill zero-pulse`): zero's cells were evicted from the
  global pulse at birth, so they're actively **failed back** — each schedule
  re-seeded into the global pulse, which rebuilds their cron on its next tick.
- **Retag** (`cells project <cell> <new>`): if the new project changes the
  owning pulse, the cell's schedule is migrated (seed-new-then-forget-old).
- **Crash** (OOM / wedge — no clean kill): not covered automatically yet. Run
  `cells heartbeat reseed <project>` to fail the cells back by hand. (A steward
  reconcile to automate this is in `docs/BACKLOG.md`.)

The handoff re-seeds from the Mac's **last-seen HEARTBEAT.md mirror**
(`~/.cells/heartbeat-mirror/<cell>.md`, written by the proxy on every change),
falling back to the Obsidian vault snapshot. It's the freshest copy the system
has and never requires waking a cell.

## Why an LLM at all

Cron is the IR; HEARTBEAT.md is prose. Pete writes *"every weekday at
8am, summarize the news"* and pulse turns that into `0 8 * * 1-5` plus
the wake message. Same prose → same id (stable hash) so re-parses don't
churn `lastFire` and miss-fire.

Pulse runs on `gpt-5.5` medium via Pete's ChatGPT subscription, routed
through subscriptions proxy at `proxy.cells.md/codex` — same path cells use for
codex requests. Cheap because the LLM only fires on inbox events (rare)
and the daily-log step (once per UTC day).
