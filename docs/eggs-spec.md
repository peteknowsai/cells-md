# Eggs — consolidated spec

This document consolidates the eggs v2 design across three prior sources and the wells-team substrate evolution since they were written:

- `docs/eggs.md` — operator runbook (variant signatures, hatch flow, state machine)
- `docs/eggs-phase-1.md` — Phase 1 implementation plan (manual operator path)
- `~/.claude/projects/-Users-pete-Projects-cells/memory/project_eggs_v2_architecture.md` — v2 north star (agent-managed variant pool, capability-deferred installs)

What's new since those were written: wells now ships its own substrate-level pre-warmed VM pool (`pool_size` config). Eggs now compose **on top of** that primitive instead of replacing it. This spec defines the two layers, where each layer's responsibility starts and stops, and how a `cells birth` request flows through them.

## Two layers of pooling

```
┌────────────────────────────────────────────────────────────┐
│ Layer 2 — eggs (cells)                                      │
│ ─────────────────────                                       │
│ Variant-baked wells: cell-base + DNA + (model × extensions  │
│ × packages) installed. Hatch = sed + restart pi.            │
│ Owned by cells. Refill agent runs locally.                  │
└─────────────────────────┬──────────────────────────────────┘
                          │ consumes
                          ▼
┌────────────────────────────────────────────────────────────┐
│ Layer 1 — wells substrate pool                              │
│ ─────────────────────────────                               │
│ Pre-warmed booted-but-empty VMs. `well create` from a       │
│ pooled VM is sub-3s vs ~30s cold.                           │
│ Owned by wells team. Configured via wells's `pool_size`.    │
└────────────────────────────────────────────────────────────┘
```

The egg refill agent uses Layer 1 implicitly — every time it bakes a new egg, the underlying `well create` is sub-3s because wells already has a VM warm. Cells code never touches Layer 1's pool directly; it just benefits.

This is the central architectural shift since Phase 1 was written. Phase 1 assumed `well create` was the slow path. It isn't anymore. The slow path now is **the variant bake itself** (DNA push, bun install, package installs, extension prune) — that's what eggs cache.

## What an egg is (now)

An egg is a well in `state=warm` whose disk image already has:

1. The cell-base bake (bun, pi, terminal toolkit, DNA at `/cell/` with placeholders intact, `/etc/profile.d/cells-env.sh` shim, `bun install` complete, pi-ai patches applied)
2. The variant's specific bake on top:
   - Selected extensions installed under `/cell/.pi/extensions/` (others not yet pruned — pruning is hatch-time)
   - Selected packages installed via `pi install` (e.g., `pi-web-access`)
   - `.pi/settings.json` has `<MODEL>`, `<PROVIDER>`, `<THINKING>` substituted; `<NAME>` placeholder intact
3. A pristine well checkpoint (`pristine-v1`) so hatch always restores from a known-clean snapshot before sed-substituting identity

What an egg lacks: a name, a tmux color, a `status.json`, a started pi process, a CF Worker, a Slack channel binding, a vault dir. All of those are hatch-time or async-tail.

## What hatching does

Hatching is **pure determinism on the Mac**. No mother in the loop (per `feedback_skill_structure` memory: small scripts at sharp edges; the LLM-routed path is birth, not hatch). Hatch runs as `scripts/hatch.ts`:

1. **Atomic claim** — `flock` on `~/.cells/.eggs.lock`, transition the egg's row in `~/.cells/eggs.json` from `warm` → `claimed`. Race losers re-read and pick another egg.
2. **Restore checkpoint** — `well restore <egg.well_name> pristine-v1` (~300ms). Cheap and worth it for repeatability.
3. **In-VM identity substitution** — `well exec -s <egg> -- bash -c '...'`:
   - sed `<NAME>` → cell name in DNA files (`IDENTITY.md`, `.pi/settings.json`, `~/.tmux.conf`)
   - prune unselected extensions: `rm -rf /cell/.pi/extensions/<x>` for any extension installed in the bake but not requested at hatch
   - register chosen optional extensions in `.pi/settings.json` via jq
   - apply tmux color: sed `__CELL_BG__` / `__CELL_FG__` per `scripts/cell-color.sh` (deterministic by name)
   - write `/cell/.pi/status.json`
4. **Local registry write** — append to `~/.cells/cells.json` with `status: "warming"` and `hatched_from: <egg-id>`. Cell is now `cells talk`-able.
5. **Site service registration** — `scripts/register-site-service.sh <name>` starts the per-cell site service inside the well; pi spawns its child rpc process; WS bridge comes up.
6. **First user can talk** — control returns to caller. If TTY, `cells birth` drops into `cells talk <name>`. The seed-greeting (Phase 2) auto-sends.
7. **Async tail** (fire-and-forget, doesn't block step 6):
   - `bash scripts/deploy-cell-worker.sh <name>` — per-cell CF Worker
   - if `--channels=slack`: `ensureSlackChannel` + bind + invite
   - if `--channels=email`: write binding
   - vault dir create + first sync
   - first cell checkpoint
   - flip registry status `warming` → `alive` once all done
8. **Egg row** flips `claimed` → `live` (post-hatch breadcrumb). Phase 3-future rotates these out.

Target: steps 1–6 complete in **5–15 seconds**. Async tail typically converges in 30–60s with no user-visible impact unless the user immediately tries to talk to the cell over Slack or via `<name>.cells.md`.

## Variant signature

Same as `docs/eggs.md`:

```
v1:model=<m>,thinking=<t>,extensions=<a>|<b>,packages=<p>,channels=<c>
```

The **pool key** zeroes `thinking` and `channels` (they don't shard the pool — both are hatch-time-cheap). Two requests with the same pool key are hatch-interchangeable.

Library: `cli/lib/variant-signature.ts` (Phase 1 ships this; pure, unit-tested, no IO).

## Common variants (pre-baked)

Don't bake every theoretical variant. Bake the top-N by historical frequency. The refill agent (P3.4) maintains stock at configured depth per variant.

Initial recommendation (settled in P3.2):

| Variant key                                       | Stock depth | Why                                           |
|---------------------------------------------------|-------------|-----------------------------------------------|
| `v1:model=gpt-5.5,thinking=,extensions=,packages=,channels=` | 3 | Pete's daily-driver default, most common      |
| `v1:model=gpt-5.5,thinking=,extensions=memory,packages=,channels=` | 2 | Memory is the most-used extension             |
| `v1:model=deepseek-v4-pro,thinking=,extensions=,packages=,channels=` | 1 | Deepseek users; cheaper to keep one warm      |

Anthropic models (`opus`, `sonnet`, `haiku`) deliberately excluded from the egg pool until the Claude Code harness ships. Per `feedback_birth_death_flexible.md` and `feedback_birth_reliability_over_speed.md`: pi-emulated Claude Code on cell IPs is fingerprint termination risk on Pete's Claude Max sub. Don't bake eggs we can't safely birth.

Off-menu requests (variants with no matching egg) fall through to **capability-deferred install** (Phase 4) rather than slow-birth. The hatch agent picks the **closest egg** in the pool, hatches it, and installs the missing extensions/packages in the background while seed-greeting is already streaming back.

## Capability-deferred install (Phase 4 brief)

When a `cells birth` request's pool key has no exact-match egg:

1. Hatch picks the egg with the most-overlap on extensions/packages.
2. Identity substitution proceeds normally; pi starts.
3. The cell agent's system prompt reads `/cell/.pi/in-flight.json` — written at hatch with the list of capabilities still installing.
4. Background process on the cell runs `pi install <pkg>` and `cp -r <dna-source>/.pi/extensions/<ext> /cell/.pi/extensions/` for missing items, then removes the in-flight entry.
5. Cell agent can self-narrate: "I'm still loading pi-web-access; ask me again in 30s if you need it." Failed installs surface as graceful agent replies, not silent broken cells.

Acceptance: a hatch with `--packages=pi-web-access` against a no-package egg returns to a talk-ready state in pool-time (5–15s), not install-time (60s+).

## State machine + registry

Eggs have four states (unchanged from `docs/eggs.md`):

- **warm** — ready to hatch
- **claimed** — atomic claim in progress; transient (~10s)
- **live** — claimed and hatched into a real cell. Breadcrumb until rotated out.
- **culling** — hatch failed partway. Refill agent or `cells egg cull` cleans up.

Files:

- `~/.cells/eggs.json` — egg registry
- `~/.cells/.eggs.lock` — claim sentinel (auto-cleared if stale >30s)
- `~/.cells/cells.json` — cells registry; gains `status: "warming" | "alive"` and `hatched_from: <egg-id>` fields. Backwards-compat: missing `status` → `"alive"`.

## CLI surface (P3.3)

```bash
# Operator: see + manage stock
cells egg list                              # warm/claimed/live counts per variant
cells egg refill                            # bake any short-stock variants now (foreground)
cells egg drain                             # cull all warm eggs (e.g., before rebake)
cells egg cull <id>                         # remove one specific egg
cells egg --variant 'v1:...'                # bake one egg of a specific variant

# User-facing: unchanged
cells birth bob --model=gpt-5.5             # auto-hatches if matching egg in pool
cells birth bob --model=gpt-5.5 --no-pool   # force slow-birth (testing)
```

The `cells egg` namespace mirrors the shape of wells's `well pool` but operates on cells's variant-aware view. Cells doesn't expose Layer 1's pool — that's wells's `well pool`.

## Refill agent (P3.4)

Runs as a launchd plist (mirroring pulse). Tick interval: 60s.

Per tick:

1. Read `~/.cells/eggs.json`.
2. For each configured variant, count `state=warm` eggs.
3. If count < target depth, bake one new egg (foreground; mother concurrency=1 still applies).
4. Retire `state=live` eggs older than 7 days (rotation; non-blocking).
5. Retire `state=culling` eggs older than 60s (failed hatches).

The refill agent is **also** where Phase 4 measures real-world variant frequency — count `cells birth` requests by pool key over rolling 7d window, surface "should we bake X?" suggestions in the next steward turn.

## Implementation phases (consolidated)

| Phase | Scope | Primary deliverable | Done when |
|-------|-------|--------------------|-----------|
| **3a** (Phase 1 from `eggs-phase-1.md`) | Manual operator path | Variant signature lib, eggs.json, `birth-egg` skill, `scripts/hatch.ts`, `cells egg birth/list/cull` | `cells egg birth ...` then `cells hatch ... --as testcell` produces an alive cell in <20s |
| **3b** (was P3.3-P3.5 in BOARD) | Auto-hatch on `cells birth` | `cmdCreate` checks pool first, falls through on miss | `cells birth bob` hatches a matching egg silently; `--no-pool` forces slow-birth |
| **3c** (was P3.4 in BOARD) | Refill agent | launchd plist + tick logic | Pool stays at configured depth without manual intervention |
| **4** (Phase 4 in BOARD) | Capability-deferred install | Closest-match hatch + in-flight install + cell self-narration | Off-menu birth returns to talk-ready in pool-time, not install-time |

Phase 3a is roughly the `eggs-phase-1.md` plan. The new pieces above are 3b/3c/4.

## Risks (consolidated from prior docs + new substrate context)

- **Pi startup timing on first hatch.** If sed is incomplete or settings.json malformed, pi crashes and site service auto-restarts in a tight loop. Hatch must validate settings.json (jq parse) after sed before triggering site service. Fail loud, not silent.
- **Async tail failures going unnoticed.** CF Worker deploy failure 30s post-hatch leaves cell alive but unreachable from outside. Hatch writes failure to `~/.cells/logs/hatch/<name>.log`; `cells doctor` surfaces it.
- **Egg max-age not enforced in Phase 3a.** Refill agent (3c) handles rotation. Until then, Pete culls manually.
- **Wells-substrate pool exhaustion.** If wells's `pool_size` is set lower than the egg refill agent's bake rate, refills will fall back to cold `well create` (~30s). Coordinate with wells team on `pool_size` settings if egg bakes start running slow. **`needs-wells:` if observed in production.**
- **Mother concurrency=1 on `birth-egg`.** Refilling 5 short-stock variants takes ~25 minutes serialized at current bake speed. If the pool is empty after a substrate outage, recovery is slow. Mitigation: warm starts with a baseline pool snapshot (Phase 5+).
- **Closest-match-and-tweak shape**. Picking the closest egg is straightforward when one extension is missing; trickier when packages diverge. Phase 4 algorithm: prefer eggs with the same `packages` (because installing pi packages is the slowest deferred op), tiebreak on extension overlap.
- **Anthropic re-enablement.** When Claude Code harness ships, add `claude-code` × top-2 models to the variant table. Don't bake them until then.

## What this spec deliberately omits

- **Stock-level targets per variant** — that's P3.2's deliverable, not this doc's
- **Cost telemetry on egg storage** — Phase 4 nice-to-have
- **Multi-pool / multi-tenant namespacing** — not on the roadmap
- **Egg portability across Macs** — eggs live on the local welld; no cross-machine sharing in v1

## Pointers

- Operator runbook (manual flow): `docs/eggs.md`
- Phase 3a implementation plan: `docs/eggs-phase-1.md`
- v2 architecture memory: `~/.claude/projects/-Users-pete-Projects-cells/memory/project_eggs_v2_architecture.md`
- BOARD: `BOARD.md` Phase 3 + Phase 4 sections
- The magical-first-talk wedge that motivates this whole phase: `PLAN.md` Phase 3
