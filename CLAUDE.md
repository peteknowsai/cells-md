# CLAUDE.md — working on the `cells` repo

This file is for an agent working **on the cells codebase** on Pete's Mac. It is not
the prompt a cell runs with — that's `dna/cells/base/CELLS.md`.

## What cells is

A fleet of always-on AI agents, each living inside its own Linux VM, addressable by
name. You hand it a problem; it builds a team — a Chief of Staff with specialist cells
under it. Everything runs locally on a Mac, routing LLM calls through Pete's own
Claude Max / ChatGPT subscriptions instead of API billing.

Three layers, top to bottom:

- **cells** (this repo) — the agent layer: the CLI, the birth ritual, agent-to-agent
  channels, per-cell Cloudflare presence, the egg pool.
- **wells** (`~/Projects/wells`, separate repo) — the substrate: a `welld` daemon that
  owns the stateful Linux VMs ("wells") cells live in.
- **the harness** — the coding agent inside each cell: **pi**, **claude-code**,
  **codex**, or **hermes**. All four speak the same channels primitive.

### The wells/cells boundary — a hard rule

Cells **never** reaches below the wells REST API (`127.0.0.1:7878`). VM networking,
DHCP, IP allocation, checkpoint/restore, sealing — all wells. Cells owns the pool,
reconcile, birth ritual, and `/seal`-consumer logic. If a fix wants to touch VM
plumbing, it belongs in the wells repo, not here. Operate cells via the `cells` CLI,
not the `well` CLI.

## Runtime & commands

Runtime is **Bun**, not Node. Everything is TypeScript/TSX, run directly — no build
step for the CLI. There is no root `tsconfig.json`; Bun handles TS/JSX natively.
(Pete's global CLAUDE.md mentions `uv run pytest` — that's for Python projects;
ignore it here.)

```
bun cli/cells.ts <subcommand>     # run the CLI (entry point, shebang: #!/usr/bin/env bun)
bun test cli/lib/                 # run the unit tests — ALWAYS scope the dir
bun test dna/cells/base/lib/      # harness-adapter tests
```

**Never run bare `bun test`** from the repo root — it sweeps 180+ `node_modules`
`*.test.ts` files. Real tests live in `cli/lib/*.test.ts` (variant-signature,
hibernate-ready, reconcile) and `dna/cells/base/lib/harness-adapters.test.ts`.

## Repo layout

```
cli/        Mac-side control plane (the CLI, dashboard, proxy, bridge, Cloudflare worker)
dna/        The genome every cell inherits at birth — base anatomy, specials, skills
colonies/   Multi-cell colony recipes (e.g. jurypool)
projects/   Reference colonies under construction (jury)
proto/      Experimental/retired prototypes — pulse moved out into dna/specials/pulse
scripts/    Birth, egg-bake, deploy, channel-bind, acceptance, harden, eval scripts
docs/       Design docs (HTML-primary), proposals, architectural-decisions, backlog
state/      Local state — state/memory/ holds the fleet activity log
```

### cli/ — the control plane

- **cells.ts** — the main CLI. One big subcommand dispatch (see below). The largest
  file in the repo; most CLI work lands here.
- **proxy.ts** — inbound reverse proxy: wakes cells on traffic, pushes heartbeats,
  routes LLM-fallback, handles Slack/email webhooks.
- **host-bridge.ts** / **host-forwarder.ts** — Mac↔VM bridge (SSH relay, exec, TCP fwd).
- **dashboard.ts** — realtime fleet UI, served at `cells-dashboard.cells.md`.
- **birth-ui.tsx** — interactive birth prompts (React via Ink).
- **lib/** — tested units: `channels.ts`, `variant-signature.ts` (cell config
  fingerprint), `reconcile.ts` (pool culling), `hibernate-ready.ts`, `resolve.ts`,
  `secrets.ts`.
- **worker/** — per-cell Cloudflare Worker + Durable Object (the `<name>.cells.md`
  presence that survives hibernation), plus dashboard/slack/email/front workers.

### The `cells` CLI subcommands

Lifecycle: `birth`/`create`, `birth-special` (mother/pulse), `kill`/`destroy`,
`sleep`, `wake`, `stop`, `pin`/`unpin`, `checkpoint`.
Talk: `talk` (ask a peer), `verify` (cross-check a decision across peers), `tui`,
`shell`, `exec`, `see`.
Pool: `pool`, `egg`, `bake`, `list`.
Ops: `heartbeat`, `dream`, `sync` (mirror to Obsidian), `refresh-extensions`,
`channel`/`channels`, `schedule-*`/`unschedule-*` (launchd), `doctor`, `menubar`.

## DNA — what every cell inherits

`dna/cells/base/` is the genome cloned into every new cell:

- **CELLS.md** — what it means to be a cell (persistence, hibernation, peers).
  The single most important cell-facing doc.
- **SOUL.md** — personality (overridden per colony/persona).
- **IDENTITY.md / HEARTBEAT.md / TOOLS.md / CONTACTS.md / MEMORY.md** — per-cell state.
- **`.pi/` `.claude/` `.codex/` `.hermes/`** — one config tree per harness. Cells work
  is harness-agnostic: changes usually need to land in all four, or behind an adapter.
- **site/** — the cell's web presence, served via its Worker.

### Skills a cell carries

In `dna/cells/base/.{pi,claude}/skills/`:

- **agent-comms** — how a cell talks to peers (`cells talk`) and cross-checks decisions
  (`cells verify`) before any outside-world action.
- **heartbeat** — how a cell schedules its own recurring work by writing a prose
  schedule into HEARTBEAT.md (a hibernating cell can't wake itself — the heartbeat is
  how it asks).
- **birth** (claude-code) — turns a claimed generic egg into a configured live cell.

Plus pi **extensions** (`dna/cells/base/.pi/extensions/`): `dream`, `memory`,
`mentality`, `wiki`, `thinking`, `use-max`, `heartbeat-watch`, `codex-proxy`, `self`.

`dna/skills/colony/` is the **colony** skill — used by the ephemeral Creator cell to
guide a human through designing a multi-cell colony.

### dna/specials/ — operator agents

- **mother** — the local provisioning agent in `~/.cells/`. Birth is a *skill* she
  runs: hand her a JSON blob via `cells talk mother`, she runs the birthing ritual
  deterministically. She serializes on `mother.lock` — **one birth at a time**.
- **pulse** — the family scheduler. `pulse-cc` (claude-code, always-on) is primary as
  of 2026-05-20: it drains a push inbox of cells' HEARTBEAT.md changes and fires
  `cells talk` at scheduled times.

## Conventions & gotchas

- **Birth = via mother, deterministic handoff. Kill = no mother.** Settled design —
  don't re-propose deterministic birth. Target is 99% birth reliability, not speed.
- **Never run two `cells birth` (or birth+kill) concurrently** — parallel
  mother-orchestrated commands deadlock silently and look like a hung LLM. `pgrep`
  before any birth experiment.
- **User-facing voice never mentions the harness or model.** "Cells are cells" — pi/
  claude-code/codex/hermes are internal implementation details.
- **Harness priority for new substrate work:** claude-code first, pi second, codex/
  hermes secondary.
- Agent-first, not static services: recurring/background work is an agent in a loop,
  not a systemd unit or cron job. A new daemon in a design is a smell.
- Don't commit baked eggs, VM images, or other large generated artifacts.

## Where to look

- **Design docs** — `docs/proposals/` (HTML-primary; `what-is-cells.html` is the
  overview). Architectural decisions in `docs/architectural-decisions/`.
- **Known issues** — `docs/BACKLOG.md`.
- **Open decisions for Pete** — `NEEDS_PETE.md` (append a section when a decision
  surfaces).
- **Runbooks** — `docs/pool.md`, `docs/pulse.md`.
- The `cells` and `wells` Claude Code skills carry the deep operational how-to —
  prefer them over rediscovering CLI flags.
