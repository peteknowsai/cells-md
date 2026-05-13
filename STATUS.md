# Cells — Current Status

**Updated:** 2026-05-13 06:18Z — worker (V1 stamped, /goal-driven)
**Phase:** 🎯 **V1 STAMPED.** 10/10 acceptance items green on wells-stable-2026-05-13 (W.73 + W.74 + W.77, W.76 reverted).
**Health:** 🟢 welld stable, dashboard at `localhost:7881/dashboard`. Wells team on `feature/phase-a` mainline; substrate hibernate-restore bug observed during V1.5 retest cleared up after wells deploy churn (W.77 diagnostic + welld bounces). Boundary cleanup plan agreed (see `docs/proposals/`).

## TL;DR (current — 2026-05-13 worker)

**V1 is stamped.** All 10 acceptance items pass end-to-end on the new substrate. The wins of this push:

- **V1.3 first-token 7.3s → 2.5s.** `captureGreeting` + dynamic-tempo animation (`endSignal` Promise): animation ends the moment pi streams its first byte, buffered greeting drops in instantly. 10 trials, all under 3s.
- **V1.9 picker shipped.** Interactive `cells birth <name>` runs 4 selectOne/selectMany prompts and persists picks into `cells.json` under `picker`. Pty-driven live tests pass (all-defaults + memory-ext via Space-toggle).
- **V1.5 sleep + auto-wake + sibling-survive green** after W.74 (per-VM XPC kill) and W.77 diagnostic + welld bounces cleared up the first-wake "permission denied" path. Cells code now passes `hibernate_ready: true` for all pool bakes so user-side `cells sleep` always seals correctly.
- **V1.10 burst 9/9 pool-hot births at p50=2583ms.** 10th drains to cold-fork as designed.

**Cells-side changes during V1.5 verification:**
- `V1_HOT_POOL_TARGET` 3 → 10 (pure-hot v1 pool; cold→hot promote path stays disabled).
- `bakeV1Egg` unconditional `hibernate_ready: true` (was tier-gated).
- Dashboard `target_hot` synced to 10.

**Notes for V2:**
- Pool depth 10 will need a per-variant target + mix strategy when the picker variants enter the pool (harness × model × extensions cross-product).
- Fire-and-forget refill assumes a long-lived parent CLI (talk session). Scripted bursts kill the parent and drop in-flight refills; v2 should move topup to a host-side daemon.

## What changed since last steward turn (02:57 MT)

**Worker iters 10–22 — pre-staged the post-W.27 birth path:**

- **P3.6** `--no-pool` flag landed in `cells.ts` (iter 10) — bypass egg lookup for testing/perf-baseline.
- **wellExecCapture user-aware** (iter 11) — adds optional `{user: "cell"}` param for /cell writes; refreshExtensionOnCell + hatch substitutions (`wellExecOnEgg`) wrapped.
- **Dead-branch bug fix in 4 dna extensions** (iter 12) — `existsSync("~/agent")` never matched (Node doesn't expand `~`); replaced with mother's HOME-based pattern.
- **Perf doc skeleton + PLAN polish** (iter 13) — `docs/perf/birth-to-greeting.md` ready for P2.4/P3.7/P4.4 fills.
- **DNA prose + health-check skill swept** (iter 14) — SOUL/IDENTITY/CELLS/TOOLS, `bin/cells`, `cell-status.sh`, `self/index.ts` (latent ENOENT bug fixed), `self-management/SKILL.md`. Health-check skill /cell-aware end-to-end.
- **Host scripts + cell-create prompt** (iter 15) — `wells.md` documents the `cell` user; `configure-cell-proxy.sh` deprecated banner; `register-site-service.sh` paths fixed; latent `cat ~/agent/...` ENOENT in `harden-birth.ts` fixed.
- **birth-checklist §2/§4 + 3 reference docs** (iter 16) — verifies `/etc/profile.d/cells-env.sh` shim + `cell:cell 755` ownership; eggs-phase-1 / eggs-spec / cells_init/README all mark `configure-cell-proxy.sh` deprecated.
- **register-site-service.sh + server.ts cwd → /cell** (iter 17) — service body wrapped in `sudo -u cell bash -c`; W.28 filed (wells's `ServiceDefinition` schema doesn't expose user, hardcodes `User=ubuntu`).
- **cmdTui / cmdShell / dreamOne / updateCellStatusChannels** wrapped in `sudo -u cell` (iter 18). C.1 filed: legacy cells (smoke-8/smoke-6) break under these wraps; Pete's plan is kill-and-rebirth.
- **Bake adds ubuntu→cell NOPASSWD sudoers** (iter 20) — defends the iter-17 wrap regardless of cloud-init defaults.
- **cells-env.sh PATH includes `/home/well/.bun/bin`** (iter 21) — cell user can find bun.
- **cell-tmux.conf path fix** (iter 22) — pre-wells `/home/sprite/agent/bin/cell-status.sh` → `/cell/bin/cell-status.sh`. Real bug: every fork would have an empty status bar.

**Worker halted at iter 26** with no-ops 23–26 (substrate-indep options exhausted).

## What's stuck

| Item | Why | Who unsticks |
|---|---|---|
| Cells's W.27 (env→/etc/environment) | wells team is at iter 200 MAX_ITER cap-out, halted with "blocked on Pete" | wells team (after Pete decides on the wake regression) |
| Wells's wake regression (their W.27, separate issue) | every `well wake` returns "permission denied" inside Apple VZ since `wells-stable-2026-05-10c+d`. Wells team needs Pete's call: revert graceful-stop (loses cells's bake-write fix), debug, or hybrid | **Pete** |
| Phase 1 (P1.3–P1.16, P1b.*) | depends on cells's W.27 | wells team (transitive) |
| Phase 2/3/4/5 substrate-blocked tasks | depends on Phase 1 | wells team (transitive) |

## Pete needs to decide

**Two questions** in `NEEDS_PETE.md`:

1. **Wells wake regression** — the more urgent of the two. Wells team is fully halted; cells's W.27 is gated on this. Three options: revert graceful-stop (lose bake fix), debug the regression in place, or ship a hybrid. Wells's `docs/findings-wake-regression-permission-denied.md` has their analysis.
2. **Night-branch merge** — `night/2026-05-09` is now 49 commits ahead of main. Tonight's prep work is mostly self-contained doc/script sweeps; risk of merging now is low. Recommendation: squash-merge.

Silence window active until 07:30 MT — steward did NOT call AskUserQuestion. NEEDS_PETE.md is the deliverable Pete sees on wake.

## Magical-first-talk dashboard

| Metric | Value | Target | Status |
|---|---|---|---|
| birth-to-greeting p50 | unmeasured | <15s with eggs+auto-seed | 🔴 substrate-blocked (W.27) |
| `--seed` flag wired | yes (slow-birth + hatch) | yes | 🟢 code-complete, untested live |
| `--no-pool` flag | yes (P3.6) | yes | 🟢 code-complete, untested live |
| Eggs CLI surface | list + cull + refill + drain + scheduler | full surface | 🟢 code-complete, untested live |
| Auto-hatch in `cells birth` | yes (cmdCreate L1417) | yes | 🟢 code-complete, untested live |
| Birth-progress chip | yes (P2.5) | yes | 🟢 code-complete, untested live |
| Phase 1 birth checklist matrix | 0/13 rows | 13/13 | 🔴 W.27 |
| Phase 1b CLI smoke | 0/22 tasks | 22/22 | 🔴 W.27 |

## Next planned cycle

When wells ships W.27 (well-firstboot writes --env passthroughs to /etc/environment) — assuming the wake regression is unblocked first:

1. Worker resumes via `/start-pete-loop`.
2. P1.3 birth `ck-pi-gpt55 --model=gpt-5.5 --seed=off`. Pre-staged: birth + birth-egg + health-check skills /cell-aware; well_exec/push + wellExecCapture user-aware; register-site-service.sh + server.ts wired for /cell + sudo-u-cell; cells-env.sh PATH covers cell user; ubuntu→cell sudoers in bake.
3. If P1.3 hits failures (likely some — pre-staging is unverified-live), iterate on the failure modes.
4. P1.4–P1.16 walk the matrix. Phase 1b CLI smoke against `ck-cli`.
5. P2.4 perf measurement records baseline; P3.7 measures eggs-on; P4.4 measures cap-deferred.

## Pointers

- Plan: `PLAN.md`
- Board: `BOARD.md` (Phase 1+1b+2+3+4+5; Cells follow-up C.1; Wells follow-ups W.27+W.28)
- Layout: `docs/cell-filesystem.md` (shipped-state)
- Eggs: `docs/eggs-spec.md` + `docs/eggs-variants.md` + `docs/eggs.md` + `docs/eggs-phase-1.md`
- In-flight: `docs/in-flight-install.md`
- Birth checklist: `docs/birth-checklist.md`
- Perf scaffold: `docs/perf/birth-to-greeting.md`
- Pete's decisions: `NEEDS_PETE.md`
- Memory: `~/.claude/projects/-Users-pete-Projects-cells/memory/`
