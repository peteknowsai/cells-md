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

`pulse` is the **timekeeper** — sibling to `mother`. It runs as an always-on
cell in its own well (an agent loop, not a Mac launchd job), ticking every
~5min. Each cell's `HEARTBEAT.md` change is **pushed** to pulse's inbox by the
Mac (the proxy on every change; the host on a project-pulse handoff) — pulse
has no registry or vault to read. It drains the inbox, interprets the prose
schedules into cron lines in `/etc/cron.d/pulse-schedules`, and Linux cron
fires the wake-ups via `cells talk <name> "<message>"`.

Pulse is now a role keyed by project: the global `pulse` plus opt-in
`<project>-pulse`. The Mac decides which pulse owns each cell (`pulseOwner`);
the in-well pulse is a dumb drainer of whatever it's handed.

Pulse does not keep the cell roster (that's mother's job, in `CELLS.md`).
Pulse does not have ongoing relationships (no `CONTACTS.md`). Pulse just
watches the clock and rings the bell.

See [`docs/pulse.md`](../../docs/pulse.md) for the full design.
