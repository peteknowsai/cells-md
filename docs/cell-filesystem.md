# Cell filesystem layout

**STATUS: shipped 2026-05-10** in `night/2026-05-09` (commits `ebfc908`, `5043c09`, `20139d4`, `beb8768`). `cells bake --force` produces a `cell-base` (6059 MB) whose forks have user `cell` (uid 1002, sudo), `/cell/` tree, `/etc/profile.d/cells-env.sh` shim, `/cell/bin/cells` (cell:cell 0755), and pi patches landed (URL→proxy.cells.md ×23, codex extractAccountId stub, THINKING_LEVELS adaptive, model fallback chain). Verified end-to-end via fork+SSH §2 checks. Pre-migration cells (`smoke-8`, `mother`, etc.) stay on the old `/home/well/agent` layout — kill-and-rebirth, no in-place migration. Open follow-ups under "What didn't ship" below.

The well is the box. The cell is the inhabitant. SSH'ing in lands you directly inside the cell — not in some intermediate user home you have to `cd` out of.

## The whole layout (as shipped)

```
/cell/                       ← HOME for user `cell`. SSH lands here.
├── .pi/                     ← pi harness state (settings.json, extensions/, status.json)
├── .bashrc                  ← shell init (aliases ls -A)
├── .gitignore
├── .profile
├── .ssh/                    ← authorized_keys
├── .tmux.conf               ← per-cell terminal chip (filled at birth)
├── AGENTS.md SOUL.md IDENTITY.md CELLS.md CONTACTS.md HEARTBEAT.md MEMORY.md TOOLS.md
├── bin/                     ← /cell/bin on PATH via /etc/profile.d/cells-env.sh
├── bun.lock package.json node_modules/
├── scripts/                 ← apply-pi-patches.sh, cell-color.sh, etc.
└── site/                    ← Bun web server for <name>.cells.md
```

**Flat-at-root**, not subdirected into `identity/code/memory/` — the original plan called for that grouping; ship reality is flat so pi's working dir of `/cell` finds `.pi/`, `package.json`, `node_modules/` directly without nesting. The DNA template at `dna/cells/base/` mirrors this.

The system-wide env shim lives at `/etc/profile.d/cells-env.sh` (root-owned 0644, written by `cells bake`'s `bakeWriteProfileD`). It re-exports `CELLS_PROXY_SECRET` from `/etc/environment` as `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_CODEX_API_KEY` and prepends `/cell/bin` to `PATH`.

`ls` (with the aliased `-A`) shows everything except `.` and `..`. The cell's substance and its harness state are both visible because they're both *what the cell is*. Hiding the dotfiles behind `ls -a` would be lying about the contents of the cell.

`/home/` does not exist (or contains only the wells substrate's bookkeeping if wells's well-firstboot insists on it — but no cells content lives there).

## User

The login user is **`cell`**, not `well`. Wells's substrate keeps `well` for its own boot/identity machinery if it needs to; cells doesn't care. SSH in lands you as `cell`, in /cell, with HOME=/cell.

## Why this shape

1. **One tenant, one folder.** A well exists to host one cell. The filesystem should say that. /cell at top level is honest about what the box is.
2. **No two-step.** SSH directly into the substance. No `cd /cell` after login.
3. **Harness dotfiles are content, not noise.** `.pi/` is where the agent thinks. Hiding it would be hiding the cell's brain.
4. **Wells's rinse can do whatever it wants to /home.** Cells's content lives outside /home, so wells's per-fork identity reset (which apparently scopes to /home) doesn't wipe cells's image content. Layer cleanly.
5. **No competing paths.** Pi expects `~/.pi`. With HOME=/cell, `~/.pi` is `/cell/.pi` for free. No env-var override, no symlink dance.

## Migration mechanics (shipped)

**From cells's side — done:**

- Bake script (`cli/cells.ts cmdBake`): pushes DNA to `/cell/` directly via `pushLocalDirToWellAsCell`, creates user `cell` with `bakeCreateCellUser` (`useradd -d /cell -m -s /bin/bash cell` + sudo group), chowns `/cell` to `cell:cell`. Force-fsyncs (`sync && sync`) before save (W.20 finding) so wells's stop+save preserves writes.
- `/etc/profile.d/cells-env.sh` (`bakeWriteProfileD`) replaces the old `~/.bashrc.d/` shims. System-wide, sourced by every login shell.
- DNA template at `dna/cells/base/` is **flat** (not `identity/code/memory/` subdirs) — the on-disk `/cell` layout matches.
- Birth skills (`dna/proto/mother/.pi/skills/birth/SKILL.md`, `birth-egg/SKILL.md`) swept `~/agent` → `/cell` and `~/.bashrc.d/*` → `source /etc/profile.d/cells-env.sh` in step 4b verify.
- CLI heredocs in `cli/cells.ts` swept (17 refs across tmux launch, dream tool, extension push/remove, pullMarkdown, post-install).

**Still open from cells's side:**

- `well exec --user=cell` flag — wells team hasn't shipped a non-default-user flag. Reads from `/cell` work because mode is 0755 (others can read). Writes to `/cell/.pi/` etc. by default-`well`-user `well exec` will fail with EACCES. Workaround until shipped: prepend `sudo -u cell` to write commands. `wellExecCapture` (used widely in `cli/cells.ts`) currently has no user-param. Birth's per-cell substitution sed runs from mother (where mother itself runs); not a worker-side issue.
- Mother-v2 cutover: mother still on `/home/well/agent` (pre-migration). Plan unchanged: birth a new mother from rebaked cell-base, cut over, retire old mother. Not yet executed.

**From wells's side (still open asks):**

- `well exec --user=<user>` flag (cells writes to `/cell` default to fail under default well user).
- (W.27) `well create --env KEY=VAL` should propagate to `/etc/environment` on the forked well. Currently `well-firstboot` reads `$SEED/well.env` but doesn't write `/etc/environment` — birth's step-1 verify catches this. Filed 2026-05-10 02:38 MT.

## Pre-migration cells

- `smoke-8`, `smoke-6`, `mother`, etc. on `/home/well/agent`. Kill-and-rebirth from new cell-base; no in-place migration. Pre-migration cells are write-offs by design.

## Acceptance — passed 2026-05-10 02:14 MT (P1.2a §2 verify)

A bake-verify well forked from the new `cell-base` shows:

- `id cell` → `uid=1002(cell) gid=1002(cell) groups=1002(cell),27(sudo)` ✅
- `ls -la /cell/` → DNA at root: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `CELLS.md`, `CONTACTS.md`, `HEARTBEAT.md`, `MEMORY.md`, `TOOLS.md`, `.pi/`, `.ssh/`, `.tmux.conf`, `bin/`, `node_modules/` (148 entries), `package.json`, `bun.lock`, `scripts/`, `site/` ✅
- `stat /cell` → `cell:cell 0755` ✅
- `stat /cell/bin/cells` → `cell:cell 0755` ✅
- `head /etc/profile.d/cells-env.sh` → re-exports `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_CODEX_API_KEY` from `CELLS_PROXY_SECRET`, prepends `/cell/bin` to PATH ✅
- pi patches landed: `proxy.cells.md` ×23 in `models.generated.js`, `extractAccountId` stub, `THINKING_LEVELS` includes `"adaptive"`, model fallback chain markers ✅

`pi --version` from /cell working dir not yet measured — gated on P1.3 birth. /etc/environment seeding gated on W.27.
