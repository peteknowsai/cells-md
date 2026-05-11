# Birth-to-greeting perf

The wedge metric for cells. Two related measurements:

- **`alive_ms`** — from `cells birth` invocation to the cell being registered as `alive` in `~/.cells/cells.json` (deterministic Phase A complete; WS handle available). Captured in `~/.cells/logs/perf/birth.jsonl` per-birth.
- **`first_token_ms`** *(not yet instrumented)* — from `cells birth` invocation to the first LLM token of the seed-greeting reply streaming into the user's terminal. Adds WS-connect + pi cold-start (Tier 2) + LLM round-trip on top of `alive_ms`. Estimated +3–5s.

Target: `first_token_ms` ≤ 5s p50 on warm-pool birth (V1.3 acceptance).

## How it's measured

`scripts/perf-birth.sh N_COLD N_WARM` runs N births in each mode against the local substrate, parses `~/.cells/logs/perf/birth.jsonl`, prints p50/p95/min/max.

- Non-TTY mode (no animation overhead).
- Pool drained between cold runs.
- Pool refilled to depth 1 before each warm run.
- Cell killed between runs.

## Phase v1 baseline — 2026-05-10 22:35 MT

Substrate: `wells-stable-2026-05-10h`. cell-base from commit `c109bb9` (V1.STEP4 merged).

**Alive-time** (`cells birth … alive` log line, 5 trials each):

| path | n | p50 | p95 | min | max |
|---|---|---|---|---|---|
| cold-fork (pool empty) | 5 | 9.60s | 10.04s | 9.04s | 10.04s |
| warm-pool | 5 | 2.36s | 2.44s | 2.30s | 2.44s |

Warm cluster is *very* tight (2.30–2.44s range, only 140ms spread). Cold cluster is also tight (9.04–10.04s, ~1s spread, all 9+s). **Warm-pool is 4.07× faster than cold-fork at the alive line.**

**Estimated first-token-time** (alive_ms + WS-connect + pi cold-start + LLM round-trip):

| path | estimated p50 | components |
|---|---|---|
| cold-fork | ~14s | 9.6s alive + ~0.1s WS + ~3s pi-cold + ~1s LLM |
| warm-pool | ~6.5s | 2.4s alive + ~0.1s WS + ~3s pi-cold + ~1s LLM |

The dominant cost in cold is welld's clonefile + warming-restart (~9s); the pool side dodges that via hibernate/wake (~2s).

## Where the 3s animation lands

`cells birth` in TTY mode runs a fixed-tempo 3s animation (`waking → warming → ready → alive`) in parallel with Phase A. User-perceived time = max(animation, phase_a):

- Warm-pool birth: animation dominates → user sees ~3s total to "alive".
- Cold-fork birth: phase_a dominates → user sees ~9s total to "alive" (animation finishes early at 3s and the cell catches up).

## Gap to V1.3 target

V1.3 target: `first_token_ms` ≤ 5s p50 warm-pool.

Current estimate: ~6.5s p50. **~1.5s over target.**

The bottleneck is **pi cold-start inside the egg** (~3s after wake). The egg is hibernated pre-pi-start (Tier 2); pi spawns via site-service after wake. Tier 3 (pi running in hibernated state, resumed on thaw) would eliminate this ~3s — putting us at ~3s p50 first-token, well under target.

**Recommendation:** ship Tier 2 for v1, escalate to Tier 3 if/when Pete's actual usage shows the 1.5s gap matters. The animation + the user's typing time on the first prompt already absorb 3–5s of perceived latency, so the alive-line is the dominant user-perceived event. The first-token may matter less in practice than the alive-line feel does.

Open: instrument `first_token_ms` directly (either non-TTY auto-seed path or pty-emulated TTY run) to confirm the estimate. Current number is alive-line measured + budget for the rest.

## Cold-fork detail (for posterity)

The 8.94s cold-fork is mostly wells's create profile, observed via `~/.wells/welld.log`:

```
totalMs:8580, phase:{
  vmDir:1, seed:21, lumeCreate:24, waitStopped:30, clonefile:32, truncate:31,
  lumeStart1:35, waitRunning1:47, dhcp1:3057, ssh1:5435, shutdownSent:5562,
  diskReleased:5826, lumeStart2:5828, waitRunning2:5834, dhcp2:8344, ssh2:8580
}
```

Dominant: double-DHCP from the warming-restart cycle (3s × 2 = 6s) + ssh-ready confirmation (~2s). This is wells's own latency budget; cells can't optimize it further without wells substrate changes.

## History

Old "Phase 1 matrix variant" tables (P2.4, P3.7, P4.4 rows for each model × extensions combo) were dropped when the v1 plan locked. v1 has one canned cell shape, so there's just cold vs warm. Variant-aware perf returns in v2 if/when personality binding adds substantial new variants. Git history of this file has the prior shape if useful.
