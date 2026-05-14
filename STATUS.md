# Cells — Current Status

**Updated:** 2026-05-14 — post-V1-stamp + boundary-cleanup retro
**Phase:** 🎯 **V1 STAMPED + wells/cells boundary cleanup CLOSED.** Ready for V2 design.
**Health:** 🟢 welld at `46d7e5e` on Pi3+/seal+W.78 binary. Dashboard at `localhost:7881/dashboard`. Pool clean, reconcile no-op.

## TL;DR

V1 is the magical generic cell flow: `cells birth` → ~3s animation → talk prompt → LLM-streamed response from a generic cell. All 10 acceptance items shipped. The wells/cells substrate boundary was then refactored over a five-hour Pi2 + Pi3 + /seal coordination cycle — wells deleted -2455 LOC of cells-shaped invariants, cells took over pool ownership end-to-end. Both sides now have clean primitives and zero crossed-over state.

## What's running

- **cells CLI** (`bun cli/cells.ts ...`): pool-first birth, sleep/wake/talk, reconcile, doctor
- **welld** (`md.cells.welld` launchd, port `:7878`): substrate primitives only
- **host-bridge** (`com.pete.cells-host-bridge`): pi spawn-on-talk via SSH
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

**Birth flow** (`cmdCreateV1Fast`):
- `reconcilePool` (lazy guard) → `claimV1PoolMember` → `wakePoolMember` → `markPoolMemberLive` → registry write → `process.exit(0)` (non-TTY mode, since the 2026-05-13 fix)
- Wall-clock alive: ~70-100ms warm-path

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

## What's next

**V2 — Personality + identity layers.** When the user wants a CoS / Researcher / paired-coder, layer the personality + per-instance bind on top of the generic cell. Streams in during turn 1, takes effect from turn 2. See `PLAN.md` Phase v2.

**V3 — Cloud lifecycle polish.** Per-cell `wss://<n>.cells.md`, Slack binding, vault sync, multi-device access. Pi3's `wss` shape is verified to work; V3 is mostly mother+CF-Worker plumbing.

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
