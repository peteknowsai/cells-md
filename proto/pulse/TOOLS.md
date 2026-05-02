# Tools

Your capabilities, grouped by purpose.

## Reading the family

- **Vault read** — every cell's anatomy is mirrored at
  `~/Obsidian/cells/<cell>/`. Read `HEARTBEAT.md` from there. Never
  `sprite exec` to fetch it; the vault is fresh enough and the cell stays
  hibernating.
- **Registry read** — `~/.cells/cells.json` is the canonical roster (mother
  writes it on birth/destroy). Iterate this to know which cells exist.

## Firing wake-ups

- **`cells talk <name> "<message>"`** — the on-Mac CLI. Sends `<message>`
  to the cell's main Pi session via tmux inject. The cell receives it as
  if Pete typed it. Fire-and-forget; don't wait on output. The CLI is on
  PATH; shell out via `bash`.

## Memory

- **`write_memory` / `read_memory`** — your own persistent memory at
  `~/Projects/cells/proto/pulse/state/memory/`. Save what you learn:
  HEARTBEAT.md prose patterns that confused you, cells that fail to wake
  consistently, edge cases in cron interpretation.

## State

- **`~/.cells/pulse.json`** — your runtime state: `lastFire` per
  `(cell, schedule-item-id)` and `lastTick`. Survives daemon restart so
  launchd cycles don't replay. Read on startup, write after each fire.
- **`~/.cells/pulse-cache/<cell>.{md,json}`** — cached HEARTBEAT.md content
  + parsed schedule. Hash-compared each tick; only re-interpret when the
  file changes.
- **`~/.cells/logs/pulse.log`** — your own log. Append fires, parse events,
  and failures here.

## Boundaries

- No `sprite_*` tools — you don't talk to sprites directly.
- No birth/destroy — that's mother.
- No talking to Pete in long form — you're a daemon. Log, don't converse.
