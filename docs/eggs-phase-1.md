# Eggs — Phase 1 implementation plan

## Goal

Build the egg primitive: pre-warmed cells produced once and held in a pool, "hatched" into named cells in 5–15 seconds with capabilities deferred async. **No automation yet** — Pete drives birth, hatch, and cull manually via CLI to validate the alive-fast path is real before Phase 2 (auto-hatch on `cells birth`) and Phase 3 (pulse-driven pool maintenance).

## What we ship

After Phase 1 is done, Pete can:

```bash
# Born once, takes ~5 min — the slow apt+bun+gh+DNA work
cells egg birth opus-mem
  → egg-7f3a created (sprite: egg-opus-mem-7f3a)

# See pool inventory
cells egg list
  → egg-7f3a · variant=opus-mem · state=warm · age=2h

# Hatch into a named cell — ~5–15s to "alive", capabilities converge in background
cells hatch egg-7f3a --as pete --variant 'v1:model=opus,thinking=high,extensions=memory,packages=,channels=slack'
  → pete alive — try `cells talk pete`. (warming: cf worker, slack channel)

# Cells birth still works the old way (no auto-hatch yet)
cells birth foo --model=opus --extensions=memory  # ~5 min, slow path

# Cull a stale egg
cells egg cull egg-7f3a
```

Backwards compat preserved: existing `cells birth`, `cells kill`, `cells talk` all work unchanged.

## Architecture decisions (non-obvious)

These are the calls made up front to avoid mid-build re-architecture:

1. **Hatch is on the Mac, not on mother.** Pure determinism — sed, jq, file writes, a few API calls. Adding mother's LLM overhead would only slow it down without benefit. Per `feedback_skill_structure` memory.
2. **Pi runs on the cell, not on the egg.** Eggs have no pi process — they're sprites with the toolchain installed but no agent running. Pi starts at hatch when the site service registers and CELL_NAME is finally known.
3. **Variant signature is a stable string.** Format: `v1:model=opus,thinking=high,extensions=memory|wiki,packages=pi-web-access,channels=slack`. Multi-value fields use `|`. Empty values written as `key=`. Keys always alphabetical so the string round-trips. A short hash (sha256 first 6 hex) becomes the egg-id suffix.
4. **Eggs bake `--packages` in.** The package install is heavy (`pi install pi-web-access`); doing it at hatch would blow the 15s target. Eggs split by `(model, extensions, packages)`. `thinking` and `channels` are hatch-time-cheap and don't shard the pool.
5. **Atomic claim via filesystem lock.** `eggs.json` writes go through a write-temp-then-rename pattern under a `flock` on a sentinel file. Race losers re-read and pick another egg.
6. **Mother concurrency=1 still applies to `birth-egg` and `cull-egg`.** Per `project_mother_concurrency` memory. Hatch itself is mother-free, so hatch is the only operation that can run concurrently.

## Files to create / modify

### New

- **`docs/eggs.md`** — variant signature spec + architecture overview. Reference doc, not implementation.
- **`cli/lib/variant-signature.ts`** — small parsing/canonicalization library:
  ```ts
  export type Variant = { model, thinking, extensions[], packages[], channels[] }
  export function parseVariant(sig: string): Variant
  export function formatVariant(v: Variant): string  // canonical, sorted
  export function variantHash(v: Variant): string   // 6-hex sha256 prefix
  export function eggSpritePool(v: Variant): string // 'egg-<short-token>' for sprite naming
  ```
  Pure function — no IO. Unit-testable.
- **`proto/mother/.pi/skills/birth-egg/SKILL.md`** — fork of `birth/SKILL.md` minus identity steps:
  - Steps 1, 2, 3, 6, 6b, 6c, 8 — copied verbatim (universal work)
  - Step 4 — push DNA but **don't sed** the placeholders. Substitute `<MODEL>`, `<PROVIDER>`, `<THINKING>` per egg variant; leave `<NAME>` untouched.
  - Step 4b, 4c, 7 — **skipped**. Per-cell color, status file, site-service all run at hatch.
  - Step 5 — install ALL extensions (don't prune; hatch prunes). Install only the egg's `<PACKAGES>`.
  - Step 9 — checkpoint named `pristine-v1`.
  - Step 10 — `report_outcome(success, "egg <SPRITE> ready · variant=<SIG>")`.
  - Skip step 11 (no cells_activity log for eggs).
- **`proto/mother/.pi/skills/cull-egg/SKILL.md`** — `sprite_destroy` + `report_outcome`. ~10 lines.
- **`proto/mother/.pi/prompts/egg-birth.md`** — entry prompt for `birth-egg`. Receives variant signature, parses, calls birth-egg skill with substitutions. Mirrors `cell-create.md`.
- **`proto/mother/.pi/prompts/egg-cull.md`** — mirrors `cell-destroy.md`.
- **`scripts/hatch.ts`** — Bun TS, ~150 lines:
  ```ts
  // CLI: hatch <egg-id> --as <name> --variant <sig>
  // 1. Atomic claim: flock eggs.json sentinel, transition warm→claimed
  // 2. If state != pristine, sprite restore <egg.sprite_name> pristine-v1 (~300ms)
  // 3. Sprite_exec on egg's sprite:
  //    - sed substitute NAME, MODEL, PROVIDER, THINKING in DNA files
  //    - rm -rf .pi/extensions/<unselected>
  //    - jq edit settings.json to register chosen optional extensions
  //    - cell-color → sed substitute __CELL_BG__/__CELL_FG__/__NAME__ in tmux.conf
  //    - write status.json
  // 4. Local: scripts/register-site-service.sh <NAME> (pi starts, spawns child pi --mode rpc)
  // 5. Local: write registry entry status="warming"
  // 6. Print "alive — cells talk <NAME>"
  // 7. Async background, fire and forget:
  //    - bash scripts/deploy-cell-worker.sh <NAME>
  //    - if --channels=slack: ensureSlackChannel + bind
  //    - if --channels=email: write binding
  //    - vault sync
  //    - take per-cell checkpoint
  //    - flip registry status="alive" when all done
  ```
- **`~/.cells/eggs.json`** — created on first `cells egg birth`. Schema:
  ```json
  {
    "version": 1,
    "eggs": [
      { "id": "egg-7f3a",
        "sprite_name": "egg-opus-mem-7f3a",
        "variant_signature": "v1:model=opus,...",
        "state": "warm" | "claimed" | "live" | "culling",
        "born_at": "iso",
        "claimed_at": "iso|null",
        "claimed_by": "<cell-name>|null",
        "max_age_at": "iso" }
    ]
  }
  ```

### Modify

- **`cli/cells.ts`** — add subcommand dispatch + helpers:
  - `cmdEgg(args)` dispatching to `egg birth`, `egg list`, `egg cull`
  - `cmdHatch(args)` invoking `scripts/hatch.ts`
  - `loadEggs() / saveEggs() / claimEgg()` — eggs.json registry helpers, mirroring `loadRegistry`/`saveRegistry` patterns
  - `Cell` type gains optional `status?: "warming" | "alive"` and `hatched_from?: string` fields. Backwards compatible — older entries default to `alive` / undefined.
  - Update usage block at bottom.
- **`cli/cells.ts`** — *do not* touch `cmdCreate` yet. That's Phase 2 (auto-hatch). Keeping cmdCreate untouched means the existing slow path is the explicit fallback.

## Reuse aggressively (do not rewrite)

- `runPiWithOutcome` (cli/cells.ts:454) — invoke birth-egg / cull-egg same way as cell-create / cell-destroy
- `directSpriteDestroy` (cli/cells.ts:~1250) — reuse for cull-egg's safety-net layer
- All cleanup helpers (`evictPulseStateForCell`, `archiveSlackChannelsForCell`, `evictChannelBindingsForCell`, `deleteCellWorker`, `removeVaultEntry`) — these are per-CELL not per-egg, so cull-egg doesn't need them; but **kill-cell after hatch** still does, and the existing cmdDestroyOne path covers that
- `scripts/configure-cell-proxy.sh` — runs unchanged at egg-birth time (the `<NAME>` arg is the egg's sprite name; the env files dropped are universal)
- `scripts/register-site-service.sh` — runs unchanged at hatch time with the cell's real name
- `scripts/cell-color.sh` — deterministic by name, runs at hatch
- `scripts/deploy-cell-worker.sh` — runs async post-hatch, exactly as it does today after a slow `cells birth`
- `ensureSlackChannel` / `inviteSlackUser` / `loadChannels` / `saveChannels` / `kvUpsert` (cli/cells.ts) — all reused unchanged in hatch's async tail

## Implementation order

Tight sequence so each step is verifiable independently:

1. **Variant signature library + tests.** `cli/lib/variant-signature.ts`. Round-trip parse/format for ~10 sample variants. ~1 hour.
2. **eggs.json registry helpers in cli/cells.ts.** `loadEggs`, `saveEggs`, `claimEgg`, `releaseEgg`. Atomic write via tmp+rename. ~30 min.
3. **`birth-egg` skill + `egg-birth` prompt.** Fork birth/SKILL.md, drop per-cell steps. ~1.5 hours.
4. **`cells egg birth <variant>` CLI.** Invokes birth-egg via runPiWithOutcome, registers in eggs.json on success. ~30 min. **First end-to-end milestone:** `cells egg birth opus-mem` produces a warm egg in ~5 min. Verify with `sprite list` and `cells egg list`.
5. **`scripts/hatch.ts`.** Pure determinism, no LLM. Read egg, claim, sed-substitute on cell, register site service, write registry, fire-and-forget async tail. ~3 hours including the async coordination.
6. **`cells hatch <egg-id> --as <name> --variant <sig>` CLI.** Thin wrapper over hatch.ts. ~30 min. **Second end-to-end milestone:** `cells hatch egg-7f3a --as testcell --variant ...` produces an alive cell in <20s; `cells talk testcell` works immediately; CF worker / slack / vault converge within 60s in background.
7. **`cull-egg` skill + `cells egg cull` CLI.** ~45 min. Idempotent — works on already-destroyed eggs.
8. **`docs/eggs.md`.** Variant signature spec, architecture summary, operator runbook (how to manually birth/hatch/cull). ~1 hour.

Total: ~9 hours of focused work, probably ~2 sessions.

## End-to-end test (Phase 1 done when…)

```bash
# Kill any prior eggs/cells from earlier dev work
cells egg list  # if any: cells egg cull <id>

# 1. Birth a single egg manually
time cells egg birth 'v1:model=opus,thinking=high,extensions=memory,packages=,channels='
# expect: ~5 min, eggs.json shows egg-<hash> state=warm

# 2. Hatch it
time cells hatch egg-<hash> --as testcell --variant 'v1:model=opus,thinking=high,extensions=memory,packages=,channels=slack'
# expect: <20s to "alive", registry shows testcell status=warming

# 3. Talk to it immediately
cells talk testcell "say ok"
# expect: response within a few seconds

# 4. Verify async tail completes within 60s
sleep 60
cells list  # expect: testcell status=alive
# Slack channel cells-testcell exists and is bound
# CF worker cells-front-testcell deployed

# 5. Kill the cell (existing path)
cells kill testcell --yes
# expect: full cleanup as today

# 6. Cull what's left of the egg
cells egg cull egg-<hash>
# expect: sprite gone, eggs.json entry removed
```

If all six steps pass, Phase 1 is done.

## Open questions to settle before starting

1. **Pool sprite naming convention.** Proposal: `egg-<short-variant-token>-<6-hex-hash>`. e.g. `egg-opus-mem-7f3a2b`. Sprite name max length and `[a-z0-9-]` constraint both honored.
2. **Where exactly does `claim-and-restore` happen?** If we always sprite-restore the pristine checkpoint at hatch, we get repeatability but pay ~300ms every time (per Sprites docs). If we trust the egg is clean from prior hatch's cleanup, we save the 300ms but risk a dirty hatch. Recommendation: **always restore**. 300ms is invisible vs the talk-roundtrip.
3. **What does hatch do if pi fails to start on the cell?** Site service supervises with auto-restart, but if there's a real config bug the cell stays in `warming` forever. Need a hatch-side timeout (e.g., 30s of waiting for the WS bridge to come up); on timeout, declare hatch failed, mark the egg `culling`, surface the error.
4. **Backwards compat with existing cells in `cells.json`.** They have `{name, created_at}` only — no `status` field. Reads should treat missing `status` as `"alive"`. ✓ already in the plan above; just call it out so future-me doesn't break it.
5. **Phase 2 scope check.** Auto-hatch on `cells birth` is Phase 2. We should *not* drift into it during Phase 1, even when tempted. Phase 1 ends when the manual operator path works reliably.

## What this plan deliberately does not include

- Auto-hatch on `cells birth` (Phase 2)
- Closest-match-and-tweak (Phase 2)
- Pulse-driven pool maintenance (Phase 3)
- Stock-level targets / variant rebalancing (Phase 3)
- Cost telemetry (Phase 4)
- Multi-pool / namespacing (Phase 4)

These all have real designs in `~/.claude/plans/okay-i-want-to-giggly-flute.md` and corresponding architecture memory at `project_eggs_v2_architecture.md`.

## Risk register

- **Site service "stop the world" semantics.** When register-site-service.sh runs on an existing egg sprite that's already had a service registered (shouldn't happen on first hatch since eggs don't have site service registered, but during a re-hatch after a cull+rebirth could hit this), the DELETE-then-PUT pattern in the script handles it. Watch for races if hatching the same egg sprite twice.
- **Pi startup timing on first hatch.** Pi reads `.pi/settings.json` once at site service spawn. If sed is incomplete or settings.json malformed, pi crashes and site service auto-restarts in a tight loop. Hatch should validate settings.json after sed (jq parse) before triggering site service.
- **Async tail failures going unnoticed.** If CF worker deploy fails 30s post-hatch, the cell is alive but unreachable from outside via `<name>.cells.md`. Hatch should write the failure to `~/.cells/logs/hatch/<name>.log` so a follow-up `cells doctor` can surface it. (Phase 1 minimum: just log it.)
- **Egg max-age not enforced in Phase 1.** We'll set `max_age_at` to born_at + 7 days but Phase 1 doesn't have the cron tick to retire eggs. Pete culls manually via `cells egg cull`. Acceptable for v1.
