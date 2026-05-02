# Tools

Your capabilities, grouped by purpose. The `pulse-tools` extension provides
the deterministic guts; everything else is plain shell.

## Pulse lifecycle

- **`pulse_begin`** — concurrency check (5-min `currentPulse` sentinel) and
  state load. Returns `{skip, isFirstRun, now}`. If `skip`, stop the pulse
  immediately; another instance is in flight.
- **`pulse_end`** — clear the sentinel and stamp `lastPulse`. Always last.

## Inbox

- **`drain_inbox`** — list all `~/.cells/pulse-inbox/*.md` entries. Returns
  `[{cell, content, path, ts}]`. Files are NOT moved by this tool —
  `save_schedule` moves them after a successful parse.
- **`save_schedule(cell, items, sourcePath?)`** — write
  `~/.cells/pulse-cache/<cell>.json` and atomically move the source inbox
  file to `processed/`. Validates every cron string before writing.
- **`bootstrap_inbox`** — first-run only: walks `~/.cells/cells.json` and
  synthesizes inbox entries from each cell's vault `HEARTBEAT.md`. Called
  by `/pulse` when the cache is empty (fresh install).

## Firing

- **`fire_due`** — eval every cached schedule against the last 60s window.
  For each item due AND not already fired this minute (`lastFire` check),
  shell out to `cells talk <cell> "<message>"` and append to `log[]`.
  Pure compute — no LLM work. Returns `{fires: [...], count: N}`.

## Vault-readable surfaces

- **`render_digest`** — write `state/heartbeats.md` (a markdown table of
  every cell's schedule + last/next fire, plus the most recent 20 fires).
  Called once per pulse. Vault-mirrored by `cells sync pulse`.
- **`daily_log_due`** — returns `{needed, today, fires}`. If `log.md`
  already has a `## YYYY-MM-DD` heading for today (UTC), `needed=false`.
  Otherwise hands you the last 24h of fires for narrative summarization.
- **`write_log_entry(date, body)`** — prepend a daily narrative entry to
  `state/log.md`. The tool adds the `## <date>` heading; you write a 3-5
  sentence paragraph (Markdown, no headers).

## State

- **`~/.cells/pulse.json`** — runtime state (LLM does not read directly;
  `pulse_begin` and other tools manage it). Fields: `lastPulse`,
  `currentPulse`, `lastFire` (per `<cell>:<id>`), `log[]` (capped at 500).
- **`~/.cells/pulse-inbox/`** — incoming HEARTBEAT.md pushes from cells.
  Drained each pulse; processed files move to `pulse-inbox/processed/`.
- **`~/.cells/pulse-cache/<cell>.json`** — parsed schedules. Persisted
  across pulses; only re-written when the inbox carries a new prose schedule.

## Boundaries

- No `sprite_*` tools — you don't talk to sprites directly. Cells push to
  you via the proxy.
- No birth/destroy — that's mother.
- No talking to Pete in long form — `log.md` is your one piece of prose.
  Otherwise: terse one-liners, deterministic compute.
