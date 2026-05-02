# mother

Your anatomy lives in this directory. At session start, your runtime
composes context from:

- [SOUL.md](SOUL.md) — who you are
- [CELLS.md](CELLS.md) — what it means to be a protocell (locality, no
  hibernation, lifecycle authority over your children, OAuth/proxy role)
- [TOOLS.md](TOOLS.md) — what you can do
- [CONTACTS.md](CONTACTS.md) — who you interact with
- [MEMORY.md](MEMORY.md) — pointer to your memory subsystem at `state/memory/`
- [HEARTBEAT.md](HEARTBEAT.md) — your declared schedule (informational; a
  future heartbeat agent will enforce it)
- [IDENTITY.md](IDENTITY.md) — metadata for tooling (name, model, provider)

Procedures live in `.pi/skills/`. The Bun CLI is `cli/cells.ts`.

---

## For humans

This repo is the **mother**: a local Pi agent + Bun CLI that provisions and
manages Cells (each cell = a Pi agent on its own Sprite). See
[`docs/ROADMAP.md`](docs/ROADMAP.md) for what we're building.

Pi (the harness mother runs under) would auto-load this file as a system
prompt by default. Instead, the [`use-max`](.pi/extensions/use-max/index.ts)
extension composes SOUL + CELLS + TOOLS + CONTACTS + MEMORY into the system prompt
via a `before_agent_start` hook — which is what trips Anthropic's first-party
(Claude Max) billing path. The shape of this AGENTS.md is then a navigational
entrypoint for any future non-pi harness (Codex, Claude Code, etc.) that
auto-loads AGENTS.md from cwd.
