# Pool — operator runbook

The **pool** is cells's stock of pre-built wells, ready to hatch into cells in
~100ms instead of ~30s of cold-bake. The expensive part of birth — apt install,
bun, gh tarball, DNA push, /seal warming — happens once per pool member, ahead
of time.

User-facing: `cells birth <name>` claims a pool member if one's available, falls
back to a clear error message if not (cold-fork was retired post-V1). The user
never sees the word "pool" in normal use.

Operator-facing: `cells pool <subcommand>` to manage stock. (`cells egg` is a
deprecated alias retained for muscle memory.)

> Substrate naming: well names still carry the `egg-` prefix (`egg-AAAAAA`)
> because that's a wells-side convention. The cells side calls them pool members.

## Naming — two axes, never conflated

The pool has exactly two independent axes. Older code/docs used `warm`/`hot`/
`cold`, which collided three temperature words across both axes. Retired.

- **standing** — pool membership. `open` = built, in the pool, not yet claimed.
  `claimed` = a birth took it (it's now a cell). Also `culling` (hatch failed
  partway) and `live` (claim succeeded, kept as a breadcrumb).
- **power** — the VM's power state. `running` = up, in RAM, instant to claim.
  `hibernated` = suspended to disk, ~2s wake on claim. Derived from `tier`
  (4 = running, 2 = hibernated).

Say it like: "an open hibernated egg", "bob is a running cell". Never warm/hot/
cold again.

## Architecture (one screen)

- A **pool member** is a well with the full cells toolchain (bun, node, gh, DNA,
  /root), a baked identity (CELL_NAME, hostname, machine-id, ssh host keys via
  well-firstboot), and a hibernate-legal disk-only steady state (via `/seal`).
- Power tier:
  - **Tier 4 (running)** — up, ready to claim instantly. Target =
    `V1_RUNNING_POOL_TARGET`.
  - **Tier 2 (hibernated)** — suspended to disk. ~0.5s wake on claim. No RAM/CPU
    cost while idle.
  - V1 ships **pure-hibernated**: `V1_RUNNING_POOL_TARGET = 0`, so every pool
    egg bakes hibernated. Wake is ~0.5s — invisible against the birth ritual —
    and keeping eggs off RAM is what lets the box hold more cells. The
    running-egg path is kept dormant for V2.
- A member's **variant signature** is `model + extensions + packages`. Today
  every V1 member is the canned `v1-generic` variant.
- **Hatching** = claim a member from `~/.cells/pool.json`, wake it if hibernated,
  mark live, drop the user into talk. The cell's name is pre-baked into
  `/etc/environment` at create time; no rename dance.

## Pool depth & refill

- Target depth is **5** (`V1_POOL_TARGET_DEPTH`, and the single row in
  `DEFAULT_POOL_CONFIG`). Small on purpose: eggs go stale as the system hardens,
  and a deep pool just means more stale eggs to reap.
- **Refill is on-birth, not a loop.** Each successful `cells birth` claims one
  egg, then fires a background `refillPoolToDepth()` that bakes the pool back to
  5. One birth → one new egg. There is **no background refiller** — that loop
  (it targeted 10, ran every 10 min, raced the on-birth refill) is what let the
  pool run away to 42. It's gone.
- **Cull is the shrink path.** Refill only ever *adds*. `reconcilePool` runs a
  cull pass that destroys `open` members above target depth, oldest first.
  Without it the pool can only grow. Cull never touches claimed/live members.

## Operator commands

```bash
cells pool bake-v1     # build one V1 member (~30s; includes /seal warming)
cells pool list        # see what's in stock (standing + power columns)
cells pool refill      # top the pool up to target depth
cells pool drain       # destroy every open member (destructive — pre-bake cleanup)
cells pool cull abc123 # cull a specific member by id
cells pool reconcile   # diff pool.json vs welld, evict ghosts, cull over-target
```

Lazy reconcile runs automatically at the top of `pool list`, `pool refill`, and
`cells birth` — cheap when there's no drift, evicts ghosts and culls excess when
there is.

## How auto-hatch decides

`cells birth bob`:

1. Lazy reconcile sweeps `pool.json` for ghosts and over-target excess (cheap).
2. Claim the first `open` member matching `variant_signature` (V1: always
   `v1-generic`) — running eggs preferred, hibernated as fallback.
3. **If found**: wake (hibernated) or no-op (running), mark live, register cell
   in `cells.json`, fire the background top-up refill, return.
4. **If not found**: fast-fail with `pool is empty; run cells pool refill /
   bake-v1 / reconcile`. Cold-fork was retired post-V1 — V1 is pool-only.

Wall-clock to alive: **70–100ms** typical (plus ~0.5s wake for a hibernated egg).

## State machine

Pool members move through these `standing` values:

- **open** — ready to claim (running or hibernated).
- **claimed** — atomic claim in flight; transient (~10s during hatch).
- **live** — claim succeeded; the underlying well is now a cell. Stays in
  `pool.json` as a breadcrumb.
- **culling** — hatch failed partway. `cells pool cull <id>` to clean up.

Reconcile evicts a member if welld doesn't know about its well anymore
(W.68-class drift), or if it's a `tier=4` (running) member welld reports
status≠running (the bobby class — welld bounce stopped the running VM). It then
culls `open` members above target depth.

## Files

- `~/.cells/pool.json` — pool registry. JSON `{version: 1, members: [...]}`.
  Hand-edit at your own risk. (`state: "warm"` from older code is migrated to
  `"open"` on read.)
- `~/.cells/.pool.lock` — sentinel for atomic claims. Auto-cleared if stale (>30s).
- `~/.cells/pool-config.json` — refill targets per variant signature (optional;
  falls back to V1 generic at depth `V1_POOL_TARGET_DEPTH = 5`).

## Bake flow (what happens inside `pool bake-v1`)

1. `POST /v1/wells` with `from_image: ubuntu-base`, `env: { CELL_NAME }`. A
   create failure also fires `well destroy --force` so a partial bundle dir
   doesn't leak.
2. `setWellAuthPublic` + `disableAutoSleep` — configure auth + watchdog.
3. `waitForCloudInit` — wait for `/etc/.well-ready` + populated authorized_keys.
4. `provisionCellInWell` — DNA push, bun/node/gh install, /root layout, pi patches.
5. **`sealWell`** — `POST /v1/wells/{name}/seal`. Halts the guest, restarts
   without cidata, flips `runtime.hibernate_ready=true`. ~7s.
6. If Tier 2: `POST /v1/wells/{name}/hibernate` — accepted because seal flipped
   the flag.
7. Atomic append to `pool.json`.

## Scheduled jobs

The periodic **refill** loop has been retired — refill is on-birth (see above).
Only reconcile runs on a schedule, as the drift + cull safety net:

```bash
cells schedule-pool-reconcile     # periodic reconcile (drift evict + cull)
cells unschedule-pool-reconcile
```

Logs land in `~/.cells/logs/pool-reconcile.{log,err}`.

## Wells-side primitives this consumes

- `POST /v1/wells` — create
- `POST /v1/wells/{name}/exec` — SSH-passthrough for provisioning
- `POST /v1/wells/{name}/seal` — halt/restart-no-cidata/flip hibernate-legal flag
- `POST /v1/wells/{name}/hibernate` + `/wake` — pool lifecycle
- `GET /v1/wells` — reconcile's diff source
- `GET /healthz` — reconcile's back-off signal

## V2 directions (not built yet)

- Per-variant pool depth via `pool-config.json` rows (V1 is uniform `v1-generic`).
- Closest-match-and-tweak: if exact variant isn't in stock, hatch the nearest
  member and apply the delta async.
- Re-enable running eggs (`V1_RUNNING_POOL_TARGET > 0`) for latency-sensitive
  variants.
- Aged-member rotation. `max_age_at = born_at + 7 days` is recorded but not
  enforced.
