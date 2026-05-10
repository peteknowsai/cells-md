# Session Handoff — 2026-05-10

**For next-session-me: load this first to pick up where the prior session ended.**

## UPDATE — 2026-05-10 01:44 MT (substrate restored)

Wells shipped fix on `splites feature/phase-a` HEAD `b0a5382` (patch commit `7d30cb6 phase A: lume graceful stop fixes save+fork write loss`). Stable welld restarted 01:44:33 MT (07:44 UTC), listening on `:7878`. Root cause: lume's stop was Apple's forceful `VZ.stop()` — discarded in-flight VirtIO writes before host fsync. Patch sends ACPI, polls until guest halts, falls back to forceful only after 30s. Wells team smoke-verified write/save/fork preservation end-to-end. Findings: `/Users/pete/Projects/splites/docs/findings-graceful-stop.md`.

**Status now:** ping #2 obsolete (`.claude/sent-pings/wells-ping-2-2026-05-10.md` annotated). Pete Loop restarted at 01:44 MT. Steward auto-fire cron INSTALLED via CronCreate (`23 */2 * * *`, durable). Silence window until 07:35 MT preserved — Pete is asleep, NEEDS_PETE.md writes only. Worker resuming P1.2a verify (rebake cell-base, fork-verify §2).

## TL;DR (historical — pre-fix)

- Wells team is investigating ping #2 (image save → fork drops all post-boot writes). Phase 1 blocked until they ship.
- Pete Loop is halted at iteration 27 (no substrate-independent work left). Restart via `/start-pete-loop` only when substrate's back or new work surfaces.
- Steward auto-fire cron (23 */2 * * *) was claimed armed but was NOT installed in crontab/launchd. Now installed via CronCreate (durable).
- /compact cron (47 */3 * * *) was claimed armed; not installed. Not auto-installed by this session — manual call later if wanted.
- Three batches of work are code-complete pending substrate fix: P1.2a (cells migration to /cell), Phase 2 (magical-first-talk wedge), Phase 3 (eggs CLI surface).
- Pete and the wells team converged: they're investigating; cells side has nothing to push.

## State of the world

### Where we are blocked

`cells bake` runs, validates, saves a 6055 MB image. Forks from that image have **none** of the bake's post-boot writes — user `cell` missing, /cell missing, /etc/profile.d entries missing, pi patches missing. Same with validate=false. Same on the SOURCE well after stop+restart. Even the OLD pre-migration cell-base image is empty on fork. The bake has been silently broken — write persistence itself is broken regardless of /home.

Wells team has ping #2 (full repro) and is investigating. Archived at `.claude/sent-pings/wells-ping-2-2026-05-10.md`.

### Filesystem layout (settled, blocked on substrate)

- User `cell` with HOME=/cell. SSH lands directly in /cell.
- Dotfiles VISIBLE — harness state lives in dotfiles. `alias ls='ls -A'` in /cell/.bashrc.
- Top-level: `/cell/identity/`, `/cell/code/`, `/cell/memory/`, README + dotfiles.
- /etc/profile.d/cells-env.sh replaces bashrc.d.
- Doc: `docs/cell-filesystem.md`.

### What shipped tonight (code-complete, untested)

- **P1.2a bake migration** to /cell + user `cell` (cli/cells.ts cmdBake): bakeCreateCellUser, pushLocalDirToWellAsCell, bakeWriteProfileD, sync-before-save. ~280 lines, 13 commits on `night/2026-05-09`.
- **Phase 2 magical-first-talk wedge**: `--seed=<text>` flag, DEFAULT_SEED ("introduce yourself in one sentence and tell me what you can help with"), `--seed=off` opts out. Wired through slow-birth + egg-hatch.
- **Phase 3 eggs**: `cells egg refill`, `cells egg drain [-y]`, `cells schedule-egg-refill`, `cells unschedule-egg-refill` (launchd, 10-min cadence). Initial pool: gpt-5.5 ×3, gpt-5.5+memory ×2, deepseek-v4-pro ×1.
- **P4.1 paper design**: `docs/in-flight-install.md` — schema for `/cell/.pi/in-flight.json`, agent-side in-flight-watch extension, flock concurrency.
- **Night-branch review pending**: `night/2026-05-09` is 18 commits ahead of main. Steward flagged it; silence window is suppressing the touch.

### What's deferred, on purpose

- 16 remaining `~/agent` → `/cell` references in cli/cells.ts. NOT swept yet because they'd break running cells today. Sweep after substrate fix lands.

## When substrate is back: next planned cycle

1. Worker re-runs P1.2a verify (fork bake-verify from rebaked cell-base, run §2).
2. If §2 passes, sweep the remaining 16 `~/agent` → `/cell` refs.
3. Phase 1 matrix (P1.3–P1.16) and Phase 1b (P1b.*) execute against fresh births.
4. Phase 2 perf measurement (P2.4) records baseline birth-to-greeting.
5. Phase 3 hatch + refill agent get exercised end-to-end.

## Important rules / context

- Birth and death stay LLM-routed. Don't migrate steps into TS for speed.
- Birth reliability > speed. 99% success across the option matrix is the target.
- Wells team owns the integration. Be responsive, not directive.
- /home gets wiped by wells's rinseGuest by design. Cells moved DNA out of /home (to /cell) rather than ask wells to narrow rinse. (Then a deeper bug — write persistence — surfaced under that.)
- Anthropic OAuth fingerprint: pi on cell IPs gets terminated. Opus/sonnet/haiku excluded from variant pool until Claude Code harness ships.
- Pete's terminology: cell = the agent. well = the Linux box the agent lives in.

## Key files to read on resume

- `STATUS.md` — current snapshot (rewritten by steward at session end, commit 7116d22)
- `BOARD.md` — phase tracker
- `JOURNAL.md` — iteration log (Pete Loop halted at iter 27 with full rationale)
- `docs/cell-filesystem.md` — settled layout
- `docs/eggs-spec.md`, `docs/eggs-variants.md`, `docs/in-flight-install.md` — phase 3/4 design
- `.claude/sent-pings/wells-ping-2-2026-05-10.md` — what wells is investigating
- `.claude/loops/steward.md`, `.claude/loops/worker.md` — loop bodies
- `~/.claude/projects/-Users-pete-Projects-cells/memory/MEMORY.md` — auto-memory index

## What to do on resume

If Pete starts a new session and asks what's going on: read STATUS.md and this file, then answer briefly. Don't re-do work that's already shipped. If wells has shipped a fix, the path forward is verify P1.2a then unblock Phase 1.

If Pete redirects with new tasks: the loops, branch, and code state are all consistent. Just pick up the new direction.
