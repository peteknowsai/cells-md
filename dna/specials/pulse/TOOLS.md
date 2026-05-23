# Tools

Your capabilities, grouped by purpose. `bin/pulse-core.mjs` is the
deterministic CLI; you only ever call it from the `pulse` skill via
`node bin/pulse-core.mjs <subcommand>`.

## Pulse lifecycle

- **`begin`** — concurrency check (5-min `currentPulse` sentinel) and
  state load. Returns `{skip, isFirstRun, now}`. If `skip`, stop the
  tick immediately; another instance is in flight.
- **`end`** — clear the sentinel and stamp `lastPulse`. Always last.

## Inbox

- **`drain`** — list all `~/.cells/pulse-inbox/*.md` entries. Returns
  `[{cell, content, path, ts}]`. Re-pushes with unchanged content are
  auto-archived and not returned. Files are NOT moved by this command —
  `save-schedule` moves them after a successful save.
- **`save-schedule`** (stdin: `{cell, items, sourcePath?}`) — write
  `~/.cells/pulse-cache/<cell>.json`, atomically rewrite the cell's
  block in `/etc/cron.d/pulse-schedules`, and move the source inbox
  file to `processed/`. Validates every cron string before writing.
- **`bootstrap`** — first-run only: walks `~/.cells/cells.json` and
  synthesizes inbox entries from each cell's vault `HEARTBEAT.md`.
  Called by `/pulse` when the cache is empty (fresh install).

## Vault-readable surface

- **`render`** — write `state/heartbeats.md` (a markdown table of every
  cell's schedule + next-fire time). Called once per tick. Vault-mirrored
  by `cells sync pulse`. No firing record here — cron owns that.

## Maintenance

- **`forget <cell>`** — drop cache + crontab block for a cell. Called
  by `cells destroy` (via the host CLI's `evictPulseStateForCell`).
- **`sync-crontab`** — rebuild `/etc/cron.d/pulse-schedules` from every
  `pulse-cache/<cell>.json`. Used at first install and as a manual
  recovery handle if the cron file drifts.

## State

- **`~/.cells/pulse.json`** — runtime state. Fields: `lastPulse`,
  `currentPulse`. Managed by `begin`/`end`; you don't read it directly.
- **`~/.cells/pulse-inbox/`** — incoming HEARTBEAT.md pushes from cells.
  Drained each tick; processed files move to `pulse-inbox/processed/`.
- **`~/.cells/pulse-cache/<cell>.json`** — parsed schedules. Persisted
  across ticks; only re-written when the inbox carries new prose.
- **`/etc/cron.d/pulse-schedules`** — the crontab file the Linux cron
  daemon evaluates. Owned by `save-schedule` / `forget` / `sync-crontab`.
  Each cell has a `# BEGIN pulse:<cell>` … `# END pulse:<cell>` block.
- **`/root/.cells/logs/cron-fires.log`** — every crontab line tees here.
  Read it to see what actually fired.

## Boundaries

- You no longer fire wakes. Cron does. If you find yourself about to
  shell out to `cells talk` from a tick, stop — you're doing the wrong
  job.
- No `well_*` tools — you don't talk to wells directly. Cells push to
  you via the proxy.
- No birth/destroy — that's mother.
