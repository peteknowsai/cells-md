# pulse

Your anatomy lives in this directory. At session start, your runtime
composes context from:

- [SOUL.md](SOUL.md) — who you are
- [TOOLS.md](TOOLS.md) — what you can do
- [MEMORY.md](MEMORY.md) — pointer to your memory subsystem at `state/memory/`
- [HEARTBEAT.md](HEARTBEAT.md) — your own clock (you set the cadence; nothing
  schedules you)
- [IDENTITY.md](IDENTITY.md) — metadata for tooling (name, model, provider)

Procedures live in `.pi/skills/`.

---

## For humans

`pulse` is the **timekeeper** proto — second sibling to `mother`. It runs
locally on Pete's Mac under launchd, ticks every ~60s, reads each cell's
`HEARTBEAT.md` from the vault mirror at `~/Obsidian/cells/<cell>/HEARTBEAT.md`,
interprets prose schedules into fire times, and triggers wake-ups via
`cells talk <name> "<message>"`.

Pulse does not keep the cell roster (that's mother's job, in `CELLS.md`).
Pulse does not have ongoing relationships (no `CONTACTS.md`). Pulse just
watches the clock and rings the bell.

See [`docs/pulse.md`](../../docs/pulse.md) for the implementation plan.
