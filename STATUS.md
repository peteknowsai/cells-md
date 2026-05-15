# Cells — Current Status

**Updated:** 2026-05-14 — birth rework (multi-harness, generic pool, eval loop)
**Phase:** ✅ **Birth rework shipped + codex harness added.** All 4 birth-rework phases done; the codex harness landed as a follow-on. All three harnesses (pi + claude-code + codex) birth, talk, and tui green.
**Health:** 🟢 welld + host-bridge healthy. Pool refills clean. Smoke eval green 3/3.

## TL;DR

V1 shipped the magical generic cell flow, then the wells/cells substrate boundary was refactored (wells deleted -2455 LOC of cells-shaped invariants; cells took over pool ownership end-to-end). The **birth rework** is the current epoch: the two divergent birth flows collapse into one linear `cmdCreate` (claim a generic egg → JSON config blob → mother runs the birthing ritual), kill drops its mother round-trip for a deterministic teardown, the DNA `settings.json` becomes a real placeholder template so model/thinking/chain variations actually apply, and the eval loop (`scripts/eval-birth.ts` + `scripts/harden-birth.ts`) is reworked to verify the matrix. A second harness — `claude-code` — is wired through the egg DNA, the birthing ritual, and host-bridge's new `HarnessAdapter`; a third — `codex` (the OpenAI coding machine on the ChatGPT subscription) — followed, adding a per-turn adapter mode.

## What's running

- **cells CLI** (`bun cli/cells.ts ...`): pool-first birth, deterministic kill, sleep/wake/talk, reconcile, doctor
- **welld** (`md.cells.welld` launchd, port `:7878`): substrate primitives only
- **host-bridge** (`com.pete.cells-host-bridge`): harness spawn-on-talk via SSH — `HarnessAdapter` branches pi / claude-code (persistent) and codex (per-turn)
- **eval loop** (`scripts/eval-birth.ts` targeted, `scripts/harden-birth.ts` matrix sweep): birth/kill verification across the variation matrix
- **dashboard** (port `:7881`, optional): pool + cells observability
- **cloudflared tunnel**: per-cell `wss://<n>.cells.md` dispatch

## Pool architecture (post-boundary-cleanup)

The pool is a **cells concept**, full stop. Wells doesn't know it exists.

**Storage:** `~/.cells/pool.json` (renamed from `eggs.json` 2026-05-13). PoolMember entries with `state ∈ {warm, claimed, live, culling}` and `tier ∈ {2, 4}`. Lock file `~/.cells/.pool.lock`.

**Bake flow** (`bakePoolMember`):
1. `POST /v1/wells` (ubuntu-base, no `hibernate_ready` field — Pi3 deleted it)
2. `setWellAuthPublic` + `disableAutoSleep`
3. `waitForCloudInit` (with non-transient error early-bail)
4. `provisionCellInWell` (DNA install over SSH)
5. **`sealWell`** — calls wells's `POST /v1/wells/{name}/seal` to halt, restart without cidata, flip `runtime.hibernate_ready=true`. This is the post-Pi3 explicit warming primitive.
6. If Tier 2: `POST /v1/wells/{name}/hibernate` (gate now accepts because seal flipped the flag)
7. Atomic append to `pool.json`

**Birth flow** (`cmdCreate` — one linear path, post-rework):
1. Resolve config — interactive 6-question picker or flags/defaults; harness ∈ {pi, claude-code, codex}
2. Build the JSON config blob — `{harness, model, provider, thinking, extensions, packages, channels, chain}`
3. Claim a generic egg — `reconcilePool` → `claimGenericEgg` → `wakePoolMember` → `ensureWellHasIp` → `restoreEggPristine`
4. Hand off — `runPiWithOutcome("cell-create", [name, eggWell, blob])`; mother reads `docs/birthing-ritual.html` and follows it top to bottom
5. On success — `markPoolMemberLive`, registry push (incl. `harness`), `prewarmHostBridge`, refill, talk UX

**Kill flow** (`cmdDestroyOne` — deterministic, no mother): resolve the well locally → `well destroy --force` → sweep registry/pulse/channels/worker/vault/pool → journal the `destroyed` line. ~9s.

**Refill:** launchd `com.pete.cells-pool-refill` every 10 min + lazy refill after each consume
**Reconcile:** launchd `com.pete.cells-pool-reconcile` every 5 min (available; not auto-installed) + lazy guard in pool list/refill/birth

## Acceptance metrics (last verified 2026-05-13)

| Test | Result | Target |
|---|---|---|
| V1.3 first-token | p50 = 2.5s | ≤ 5s |
| V1.5 sleep | 589–991ms | < 2s |
| V1.5 sibling-survive | ✓ clean | (W.74 invariant) |
| V1.5 wake | 380–438ms | < 3s |
| V1.10 warm-path birth | p50 = 69–96.5ms | < 3s |
| Pi3 operator create | 6447ms | ~6-8s |
| /seal cycle | ~7s | (target = pre-Pi3 warming cost) |
| Reconcile post-bounce | 0 evictions (W.78 holds) | accurate sync |

## Birth rework — progress

| Phase | State |
|---|---|
| 1 — Pi birth rework (collapsed `cmdCreate`, DNA placeholder template, deterministic kill, retired the old egg-baker skills) | ✅ shipped + verified (birth → talk → kill all green) |
| 2 — Eval loop (eval scripts reworked to gpt-5.5/low baseline, dead sprites API → `well` CLI) | ✅ shipped; smoke combo 3/3 green; axis sweep substantiated |
| 3 — claude-code harness (`.claude/` egg DNA, ritual branch, host-bridge `HarnessAdapter`) | ✅ shipped + verified — birth, `cells talk` (one-shot + interactive + multi-turn), `cells tui` all green |
| 4 — Doc sweep | ✅ done |
| + codex harness (follow-on — `.codex/` egg DNA, ritual codex branch, host-bridge per-turn `codexAdapter`) | ✅ shipped + verified — birth, `cells talk` (one-shot + interactive + multi-turn), `cells tui` all green |

## What's next

The birth rework is shipped and all three harnesses (pi, claude-code, codex) birth, talk, and tui. Next:

**V2 — Personality + identity layers.** When the user wants a CoS / Researcher / paired-coder, layer the personality + per-instance bind on top of the generic cell. See `PLAN.md` Phase v2.

**V3 — Cloud lifecycle polish.** Per-cell `wss://<n>.cells.md`, Slack binding, vault sync, multi-device access.

## Pointers

- Plan: [`PLAN.md`](PLAN.md)
- Board: [`BOARD.md`](BOARD.md) (V1 done, V2 todo, wells follow-ups, cells follow-ups)
- Journal: [`JOURNAL.md`](JOURNAL.md) (append-only history)
- Pete's decisions: [`NEEDS_PETE.md`](NEEDS_PETE.md) (currently empty)
- Architecture: `docs/wells.md` (substrate surface), `docs/cell-filesystem.md` (cell layout)
- Pool: `docs/pool.md` (operator runbook — renamed from `eggs.md` 2026-05-14)
- Perf: `docs/perf/birth-to-greeting.md`
- Boundary cleanup retrospective: `docs/proposals/piece-2-audit-cells-side.html`
- Memory: `~/.claude/projects/-Users-pete-Projects-cells/memory/`
