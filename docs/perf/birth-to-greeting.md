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

## V1.3 measured — 2026-05-12 17:14Z (host-bridge architecture)

Substrate: `wells-stable-2026-05-12` post-W.70. cell-base from commit `2a908c8` (host-bridge `cd /cell` fix landed).

Method: 10 trials of `bun run cells birth` under a pty wrapper (`/tmp/v13-first-token.py`). First-token = time from spawn to first byte after the `cell-XXXXXX>` prompt label. Pool refilled to depth 6 before run; refill failures during the run (vmnet 4-concurrent DHCP ceiling) meant trials 7–10 hit cold-fork.

| trial | path | first_token_ms |
|---|---|---|
| 1 | (regex miss — startup race) | — |
| 2–6 | warm | 6867 / 6888 / 6977 / 7225 / 7319 |
| 7–10 | cold/mixed | 9945 / 10032 / 10243 / 11321 |

**Summary:** p50=7319ms · p95=11321ms · min=6867ms · max=11321ms · 9/10 valid.

**Verdict: V1.3 FAILS the 5s target by 2.3s p50.** Even pure warm-path trials cluster ~6.9–7.3s.

### Architectural cause

Earlier estimate ("~6.5s warm, 1.5s over target") had cold-start at ~3s. Actual first-token is closer to 7.3s warm — closer to ~4s of cold-start + LLM time on top of alive. The host-bridge architecture (commit a9a2fed onward) **spawns a fresh `ssh+pi` per session inside the cell**:

```
host-bridge (Mac) ─ssh→ ubuntu@<cell-ip> ─sudo→ cell ─exec→ pi --mode rpc
```

Every birth pays:
- ~1s for ssh handshake to the egg
- ~2s for pi to start and load extensions (use-max, codex-proxy, memory, etc.)
- ~1s for switch_session ack + set_model + set_thinking_level handshake
- ~2-3s for first LLM round-trip to deepseek-v4-flash

Tier 4 (running-resident eggs) keeps the VM hot but the `ssh+pi` is a fresh process every time — none of the pi-init work persists.

### Paths to ≤5s

Three options, ordered by reversibility:

1. **Revise the V1.3 target to 8s p50** — accept that host-bridge's reliability win (V1.0 talk-hang fix) costs ~2-3s of first-token time. Animation already covers 5s of perceived latency, so first-token-after-animation is ~2s, which is acceptable UX. Pete's call.
2. **Keep ssh+pi sessions warm across talks** — host-bridge already TTL-reaps idle sessions. Could pre-spawn ssh+pi at egg-birth time so the first talk lands on a hot pi. ~1 day of work. Adds memory pressure (5 running Tier-4 eggs × ssh+pi each).
3. **Migrate pi back into the cell** with a fix for the V1.0 talk-hang — undoes the host-bridge architecture. Lower latency, but reintroduces the bridge bug class. Not recommended.

**Recommendation: option 1.** Animation absorbs 5s of UX latency by design (commit c338c90: "stretch animation so prompt only appears after cell speaks"). The 7.3s first-token lands during/just after the animation completes. From the user's perspective, alive-line → animation finishes → cell streams greeting feels continuous. Revising V1.3 target to 8s makes the metric reflect what the architecture actually delivers; option 2 is available later if usage shows it matters.

Test script kept at `/tmp/v13-first-token.py` for re-runs.

## V1.3 measured — 2026-05-12 18:55Z (post-prewarm, per-egg provisioning)

Substrate: `wells-stable-2026-05-12h` (W.72 static IPs + Piece 3 + bun + cell user in base). cells commit `3bc65a7` (cell-base dropped, per-egg provisioning, prewarm endpoint live).

Method: same `/tmp/v13-first-token.py` pty wrapper, 10 trials of `bun run cells birth` against a fresh 10/10 warm pool.

| trial | cell | first_token_ms |
|---|---|---|
| 1 | cell-c900fe | 6269 |
| 2 | cell-bef56c | 6248 |
| 3 | cell-05f1ff | 6088 |
| 4 | cell-b955f6 | 6243 |
| 5 | cell-698ddf | 6014 |
| 6 | cell-8cbb00 | 6346 |
| 7 | cell-5f1269 | 6067 |
| 8 | cell-e5b065 | 6107 |
| 9 | cell-cef75e | 6102 |
| 10 | cell-a1ba58 | 6268 |

**Summary:** p50=6243ms · p95=6346ms · min=6014ms · max=6346ms · 10/10 valid · spread=332ms.

### What changed vs the 7.3s baseline

- **Prewarm endpoint** (`POST /prewarm` on host-bridge, fired from `cmdCreateV1Fast` at `tPhaseA`): overlaps the ~545ms ssh+pi spawn with the animation. Was the dominant cost.
- **Static IPs (W.72)**: removed DHCP variance.
- **Per-egg provisioning**: no architectural perf impact at talk-time, but it killed the stale-cell-base bug class.

### Why we're still 1.2s over 5s target

The remaining gap is the **LLM cold-start round-trip** after the seed message lands at pi. Animation runs 5s, talk drops in at t=5s, sends the seed, deepseek-v4-flash takes ~1.2s to start streaming back. Prewarm gets ssh+pi ready but can't accelerate the LLM itself.

### Verdict

**Accepted, target revised to 8s p50.** Pete's call (2026-05-12): "Seven seconds, eight seconds is fine. I think we've gotten it down to a really good timeframe." The path to ≤5s (pre-send the seed during animation) is deferred — see `docs/perf/future-optimizations.md` — because v2 will introduce variant eggs (claude-code / codex / different models) and the right pre-send shape depends on what that basket looks like.

V1.3 **passes** the revised 8s target with p50=6.2s, p95=6.3s.

## Sleep + wake latency — 2026-05-12 19:00Z

How long does shut-down-and-fire-back-up take? Measured via `/tmp/v15-wake-latency.py`: for each cell, `cells sleep <name>` then `cells talk <name> "hi"` timed spawn-to-first-token. 3 trials on Tier-2-source cells.

| metric | value |
|---|---|
| Sleep call wall-clock | ~67ms (CLI returns; hibernate runs async wells-side) |
| Wake → first-token p50 | **8197ms** |
| Wake → first-token p95 | 8260ms |
| spread | 165ms |

Breakdown of the 8.2s wake-to-first-token:
- ~3-5s: wells's `/wake` (resume hibernated VM, re-network, ssh-ready)
- ~0.5-1s: `ensureWellRunningForTalk` ssh-accept TCP probe loop
- ~0.5s: host-bridge spawns fresh ssh+pi (cold session — no prewarm on talk path)
- ~1.5s: switch_session + set_model + LLM first-byte

This **passes V1.5/V1.6 acceptance** (talk auto-wakes hibernated cells; no user-visible timeout). The 8.2s wake number is ~2s over fresh-birth (6.2s) — fair cost for full VM resume from a saved RAM image.

Could be shaved: prewarm-on-talk (fire `/prewarm` from `cmdTalk` after wake) would save the ~0.5s ssh+pi spawn cost. Added to `docs/perf/future-optimizations.md` if needed later.

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
