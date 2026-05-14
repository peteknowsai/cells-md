# Pool — operator runbook

The **pool** is cells's stock of pre-warmed wells, ready to hatch into cells in ~100ms (warm) instead of ~30s (cold-bake). The expensive part of birth — apt install, bun, gh tarball, DNA push, /seal warming — happens once per pool member, hours in advance.

User-facing: `cells birth <name>` claims a pool member if one's available, falls back to a clear error message if not (cold-fork was retired post-V1). The user never sees the word "pool" in normal use.

Operator-facing: `cells pool <subcommand>` to manage stock. (`cells egg` is a deprecated alias retained for muscle memory.)

> Substrate naming: well names still carry the `egg-` prefix (`egg-AAAAAA`) because that's a wells-side convention. The cells side calls them pool members.

## Architecture (one screen)

- A **pool member** is a well with the full cells toolchain (bun, node, gh, DNA, /cell), a baked identity (CELL_NAME, hostname, machine-id, ssh host keys via well-firstboot), and a hibernate-legal disk-only steady state (via wells's `/seal`).
- Two tiers:
  - **Tier 4 (hot)** — running, ready to claim instantly. Aim for `V1_HOT_POOL_TARGET = 10`.
  - **Tier 2 (cold)** — hibernated. ~2s wake on claim. Storage cost; minimal CPU. (V1 pool is pure-hot; cold tier is implementation-ready but not used.)
- A member's **variant signature** is `model + extensions + packages` — the dimensions baked into the disk image. Today every V1 member is the canned `v1-generic` variant.
- **Hatching** = claim a member from `~/.cells/pool.json`, wake it if Tier 2, mark live, drop the user into talk. The cell's name (`cell-<hex>`) is pre-baked into `/etc/environment` at create time; no rename dance.

## Operator commands

```bash
# Pre-warm one V1 member (~30s; includes /seal warming sequence)
cells pool bake-v1

# See what's in stock
cells pool list

# Refill against pool-config.json (or refill-v1 for the V1 generic depth)
cells pool refill

# Drain everything warm (destructive — pre-bake cleanup)
cells pool drain

# Cull a specific member by id
cells pool cull abc123

# Reconcile pool.json against welld /v1/wells (drift defense)
cells pool reconcile
```

Lazy reconcile runs automatically at the top of `pool list`, `pool refill`, and `cells birth` — cheap when there's no drift, evicts ghosts when there is.

## How auto-hatch decides

`cells birth bob`:

1. Lazy reconcile sweeps `pool.json` for ghosts (cheap).
2. Claim the first warm member matching `variant_signature` (V1: always `v1-generic`).
3. **If found**: wake (Tier 2) or no-op (Tier 4), mark live, register cell in `cells.json`, return. `process.exit(0)` if non-TTY; else drop into interactive talk.
4. **If not found**: fast-fail with `pool is empty; run cells pool refill / bake-v1 / reconcile`. Cold-fork (cell-base image) was retired post-V1 — V1 is pool-only by design.

Wall-clock to alive (warm path): **70–100ms** typical. First-token through pi: ~2.5s p50 (V1.3 target).

## State machine

Pool members move through:

- **warm** — ready to claim (Tier 4 running or Tier 2 hibernated)
- **claimed** — atomic claim in flight; transient (~10s during hatch)
- **live** — claim succeeded; the underlying well is now a cell. Stays in `pool.json` as a breadcrumb.
- **culling** — hatch failed partway. `cells pool cull <id>` to clean up.

Reconcile evicts a member if welld doesn't know about its well anymore (W.68-class drift), or if it's `tier=4 warm` but welld reports status≠running (the bobby class — welld bounce stopped the running VM).

## Files

- `~/.cells/pool.json` — pool registry. JSON `{version: 1, members: [...]}`. Hand-edit at your own risk.
- `~/.cells/.pool.lock` — sentinel for atomic claims. Auto-cleared if stale (>30s).
- `~/.cells/pool-config.json` — refill targets per variant signature (optional; falls back to V1 generic at depth `V1_POOL_TARGET_DEPTH = 10`).
- `~/.cells/eggs.json.pre-pool-rename.bak` — one-time legacy backup created by the 2026-05-13 rename auto-migration. Safe to delete after a week.

## Bake flow (what happens inside `pool bake-v1`)

1. `POST /v1/wells` with `from_image: ubuntu-base`, `env: { CELL_NAME }` — fast create, returns when SSH-ready with cidata.
2. `setWellAuthPublic` + `disableAutoSleep` — configure auth + watchdog.
3. `waitForCloudInit` — wait for `/etc/.well-ready` + populated `/home/well/.ssh/authorized_keys`. Bails early on non-transient errors ("Module not found", "Permission denied (publickey)", etc.) instead of grinding the 5-min retry.
4. `provisionCellInWell` — DNA push, bun/node/gh install, /cell layout, pi patches.
5. **`sealWell`** — calls wells's `POST /v1/wells/{name}/seal`. Halts the guest (sysrq), restarts without cidata, flips `runtime.hibernate_ready=true`. Without this, hibernate refuses. ~7s.
6. If Tier 2: `POST /v1/wells/{name}/hibernate` — accepted because seal flipped the flag.
7. Atomic append to `pool.json`.

Total bake: ~30s typical for Tier 4, ~33s for Tier 2.

## Scheduled jobs

```bash
# Install launchd plist for periodic refill (every 10 min)
cells schedule-pool-refill

# Install launchd plist for periodic reconcile (every 5 min)
cells schedule-pool-reconcile

# Remove
cells unschedule-pool-refill
cells unschedule-pool-reconcile
```

Logs land in `~/.cells/logs/pool-refill.{log,err}` and `pool-reconcile.{log,err}`.

## Wells-side primitives this consumes

- `POST /v1/wells` — create
- `POST /v1/wells/{name}/exec` — SSH-passthrough for provisioning
- `POST /v1/wells/{name}/seal` — halt/restart-no-cidata/flip hibernate-legal flag (post-Pi3, 2026-05-13)
- `POST /v1/wells/{name}/hibernate` + `/wake` — pool lifecycle
- `GET /v1/wells` — for reconcile's diff source
- `GET /healthz` — for reconcile's back-off signal

See `~/Projects/wells/docs/cells-pool-builder-primitives.md` (wells main `b9040c6`) for the authoritative wells-side surface description.

## V2 directions (not built yet)

- Per-variant pool depth via `pool-config.json` rows (V1 is uniform `v1-generic`).
- Closest-match-and-tweak: if exact variant isn't in stock, hatch the nearest member and apply the delta async.
- Mother-driven pool rebalancing on pulse ticks (V2 ROADMAP).
- Aged-member rotation. `max_age_at = born_at + 7 days` is recorded but not enforced.
