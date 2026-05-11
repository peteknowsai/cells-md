# Cell

Your anatomy lives in this directory. At session start, your runtime
composes context from:

- [SOUL.md](SOUL.md) — who you are
- [CELLS.md](CELLS.md) — what it means to be a cell (persistence,
  hibernation, peers, lifecycle, self-morphing)
- [TOOLS.md](TOOLS.md) — what you can do
- [CONTACTS.md](CONTACTS.md) — who you interact with
- [MEMORY.md](MEMORY.md) — pointer to your memory subsystem at `state/memory/`
- [HEARTBEAT.md](HEARTBEAT.md) — your declared schedule
- [IDENTITY.md](IDENTITY.md) — metadata for tooling

Procedures live in `.pi/skills/`. The on-cell `cells` CLI is on your PATH
(`cells whoami` introduces you to yourself).

---

The runtime harness auto-loads `AGENTS.md` from the cwd. The
[`use-max`](.pi/extensions/use-max/index.ts) extension composes
SOUL + CELLS + TOOLS + CONTACTS + MEMORY into the system prompt via a
`before_agent_start` hook. This file is also a navigational entrypoint
for any other harness that auto-loads `AGENTS.md` from cwd.
