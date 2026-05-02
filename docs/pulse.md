# Pulse

> **Status:** shipped. Pulse is the family scheduler — a print-mode pi
> agent that ticks every 60s under launchd, reads each cell's
> `HEARTBEAT.md`, and fires wake-ups via `cells talk`.

## Layout

| What | Where |
|---|---|
| Pulse agent root | `proto/pulse/` |
| Slash command (the tick body) | `proto/pulse/.pi/prompts/pulse.md` |
| Tools (state, inbox, cron, fire, digest, daily-log) | `proto/pulse/.pi/extensions/pulse-tools/index.ts` |
| Codex routing + anatomy composer | `proto/pulse/.pi/extensions/use-codex/index.ts` |
| Launcher (loads secrets, isolates pi auth) | `proto/pulse/bin/pulse-tick` |
| Inbox push extension (ships in cell DNA) | `proto/mother/dna/.pi/extensions/heartbeat-watch/index.ts` |
| Inbox endpoint (mother proxy host route) | `cli/proxy.ts` (`pulse.cells.md/heartbeat-changed`) |

## Runtime state (on Pete's Mac)

| Path | Purpose |
|---|---|
| `~/.cells/pulse.json` | `lastTick`, `currentTick`, `lastFire` per `<cell>:<id>`, `log[]` (capped 500) |
| `~/.cells/pulse-inbox/` | HEARTBEAT.md pushes from cells, drained each tick |
| `~/.cells/pulse-inbox/processed/` | Archive of drained inbox files |
| `~/.cells/pulse-cache/<cell>.json` | Parsed schedule per cell (`{id, cron, message}[]`) |
| `~/.cells/logs/pulse.{log,err}` | launchd-captured stdout/stderr per tick |
| `~/.cells/pulse-agent/` | Isolated `PI_CODING_AGENT_DIR` so pulse's auth doesn't collide with mother's |

## Vault-readable surfaces

`cells sync pulse` mirrors `proto/pulse/state/` to `~/Obsidian/cells/pulse/state/`:

| File | Updated by | Contents |
|---|---|---|
| `state/heartbeats.md` | `render_digest` (every tick) | Markdown table: every cell's schedule + last/next fire + recent 20 fires |
| `state/log.md` | `write_log_entry` (once per UTC day) | LLM-written narrative summarizing the prior 24h, prepended |

Inspect from terminal: `cells heartbeat`, `cells heartbeat <cell>`, `cells heartbeat --tail`.

## Tick semantics

Each tick is a fresh `pi -p /pulse` invocation; nothing persists in pi
context across ticks. The slash command is deterministic:

1. `tick_begin` — acquires the 5-min `currentTick` sentinel (concurrency
   guard for crash + overlap recovery). On first run with empty cache,
   calls `bootstrap_inbox` to synthesize inbox entries from each cell's
   vault `HEARTBEAT.md`.
2. `drain_inbox` — for each pushed HEARTBEAT.md, the LLM parses prose into
   `[{id, cron, message}]` and `save_schedule` writes the cache + moves
   the source to `processed/`. (Only LLM step on most ticks.)
3. `fire_due` — pure compute: cron-eval against the last 60s window and
   shell out `cells talk <cell> "<message>"` for each due item not
   already fired this minute. Records to `log[]` and `lastFire`.
4. `daily_log_due` → `write_log_entry` — once per UTC day, LLM writes a
   3-5 sentence narrative of the prior 24h's fires. (Other LLM step.)
5. `render_digest` — rewrites `state/heartbeats.md` from cache + state.
6. `tick_end` — clears the sentinel, stamps `lastTick`.

Cheap ticks (no inbox, no daily-log due) cost no LLM tokens — every tool
above except parse-prose-into-cron and write-daily-log is deterministic.

## Push, not poll

Cells notify pulse on HEARTBEAT.md edits via the `heartbeat-watch`
extension shipped in their DNA. The extension `fs.watch`es the file with
a 2s debounce and POSTs the new content to `pulse.cells.md/heartbeat-changed`,
which the mother proxy authenticates (`MOTHER_SECRET` bearer) and writes
to `~/.cells/pulse-inbox/<cell>-<ts>.md`. Pulse drains the inbox each
tick. No `sprite exec` reads — hibernating cells stay hibernating.

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

## Why an LLM at all

Cron is the IR; HEARTBEAT.md is prose. Pete writes *"every weekday at
8am, summarize the news"* and pulse turns that into `0 8 * * 1-5` plus
the wake message. Same prose → same id (stable hash) so re-parses don't
churn `lastFire` and miss-fire.

Pulse runs on `gpt-5.5` medium via Pete's ChatGPT subscription, routed
through mother proxy at `mother.cells.md/codex` — same path cells use for
codex requests. Cheap because the LLM only fires on inbox events (rare)
and the daily-log step (once per UTC day).
