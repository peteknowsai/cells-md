# Cell — Roadmap

Cell is a Pi agent living on a Sprite. This is what we build in what order.

## Principle

Always markdown. Every install, ritual, and recovery procedure is a `.md` file —
either a Pi skill, a Pi prompt template, or a doc the cell (or the `cell` CLI)
reads top-to-bottom. The local CLI (Bun on Mac, bash inside markdown on the
Sprite) is the only exception, and exists to be plumbing for the cell's body.

## Phase 0 — Hello, Cell

A minimum-viable cell. No memory, no wiki, no DB, no backup. Just Pi running on
a Sprite, reachable via `cells talk`. Get the substrate working before we put
anything inside it.

**Includes:**

- `cell` CLI: `pi`, `create`, `talk`, `list`, `sleep`, `wake`, `checkpoint`, `destroy`
- Local cell-keeper Pi project (`.pi/agents/self.md` + identity extension + `package.json`) so it bills against Pro/Max via the [first-party billing recipe](~/Projects/cells/PI-FIRST-PARTY-BILLING-RECIPE.md)
- `template/` — recipe-compliant cell-on-Sprite layout that birth pushes onto each Sprite
- `.pi/skills/birth/SKILL.md` — birth ritual the cell-keeper follows:
  - create the Sprite + configure egress (anthropic, bun.sh, npm, github)
  - install Bun on the Sprite
  - tar+push `template/` to `/root/cell`, `sed` substitute `__NAME__`
  - run `bun install` on the Sprite
  - inject `ANTHROPIC_API_KEY` (and other shared keys) from `~/.cell/secrets.json`
  - write the `~/.bashrc` shim that auto-attaches `tmux new-session -A -s cell pi` on `sprite console`
  - take the first checkpoint
- `.pi/prompts/` — slash commands the CLI invokes (`cell-create`, `cell-destroy`, `cell-checkpoint`)

**Done when:** `cells create Pete` works end-to-end. `cells talk Pete` lands me in
a Pi TUI on the Sprite. I have a conversation. I disconnect. The Sprite
hibernates. I come back days later. Conversation is still there. The cell is
the same cell.

**Explicitly NOT in Phase 0:**

- No memory directory, no journaling, no MEMORY.md
- No wiki, no knowledge ingest
- No Stoolap, no DB
- No R2 backup
- No self-modification rituals
- No specialized skills beyond what Pi ships with

## Phase 1 — L1 memory (AutoDream pattern)

The cell gains short-term episodic memory.

- `~/cell/memory/MEMORY.md` — index of topic files, kept under 200 lines
- `~/cell/memory/<topic>.md` — individual notes the cell writes during life
- `rituals/dream.md` — consolidation pass running as a forked Pi subagent,
  restricted to `~/cell/memory/` (read/write only there). Triggered on
  Sprite wake, not on a polling loop.
- Base `AGENTS.md` updated to teach the cell to journal during conversation

## Phase 2 — Obsidian vault sync

One place on the Mac to peruse what's on every cell — memory, persona,
extensions, skills — readable in Obsidian. Replaces the original
"Phase 2 — L2 wiki" plan because cells don't ingest enough material to
need a curated knowledge layer; mirroring their existing markdown is
the actual readable surface Pete wants.

- `cells sync [name]` — pull-only. Mirrors per-cell markdown into a
  single vault at `~/Obsidian/cells/<name>/`. Top-level `README.md`
  is a roster across all cells.
- Per-cell `README.md` is a generated dashboard: live status from the
  Sprites API, persona link, extensions (with their tools), skills,
  memory stats.
- Mechanism: `sprite exec` + tar pipe over allowlist (`AGENTS.md`,
  `memory/`, `yearnings/`, `.pi/agents/`, `.pi/skills/`,
  `.pi/prompts/`, restricted to `*.md` and `SKILL.md`).
- Extension docs are *generated* — `index.ts` is parsed for
  `pi.registerTool({...})` calls; the `.ts` itself never lands in
  the vault.

## Phase 3 — L3 db (Stoolap)

Structured records + semantic search.

- Stoolap installed on the Sprite (single Rust binary, embedded)
- Schema: conversations, events, tasks, anything that benefits from queries
- Vector index over L1 + L2 markdown using Stoolap's built-in EMBED()
  (sentence-transformers, no external API)

## Phase 4 — R2 backup

Offsite cold backup of the cell's body.

- Nightly ritual: tarball `~/cell/` and push to Cloudflare R2
- Versioned bucket — R2 handles history
- Restore ritual for resurrecting the cell onto a fresh Sprite if needed

## Out of scope, for now

- Multi-cell anything (no household, no messaging, no inter-cell awareness)
- HTTP chat shim on port 8080
- Cell kinds / specializations / overlays
- Self-modification beyond memory and wiki
- L2 wiki / Karpathy-style distilled knowledge — earns its keep when a cell has a job; until then `cells sync` (Phase 2) covers the readable-surface need
- Bidirectional vault sync — pull-only for now; if Pete actually wants to edit in Obsidian, we'll add `cells sync push` with a git-style conflict pre-flight

These may come later. For now, we build the singular unit.
