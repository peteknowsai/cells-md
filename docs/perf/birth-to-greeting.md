# Birth-to-greeting perf

The wedge metric for cells. From `cells birth <name> ...` invocation to the moment the cell's first token of its seed-greeting reply lands in Pete's terminal. Lower is better. Target: under 15s p50 with eggs + auto-seed.

## How it's measured

- **Start**: epoch ms at the moment `cmdCreate` is entered (after arg parsing).
- **End**: epoch ms at the moment `streamCellBridge` emits its first delta token from the seed message reply.
- **Sample size**: at least 5 births per row; record p50 + min + max.
- **Substrate**: `wells-stable-<date>` build, noted per-row.
- **Network**: Pete's home WiFi; not a controlled environment, but consistent enough at this latency scale.

When eggs aren't matching, slow-birth rows include the bake-cache state: warm (cell-base recent) vs cold (recently force-baked).

## Phase 2 baseline — slow-birth, no pool

Substrate: TBD on the next P2.4 run.
Pool state: drained (`cells egg drain -y`).

| Variant | Model | Thinking | Extensions | Packages | p50 (s) | min | max | Substrate |
|---|---|---|---|---|---|---|---|---|
| ck-pi-gpt55 | gpt-5.5 | medium | — | — | TBD | TBD | TBD | TBD |
| ck-pi-gpt55-pro | gpt-5.5-pro | medium | — | — | TBD | TBD | TBD | TBD |
| ck-pi-deepseek-pro | deepseek-v4-pro | high | — | — | TBD | TBD | TBD | TBD |
| ck-pi-deepseek-fl | deepseek-v4-flash | medium | — | — | TBD | TBD | TBD | TBD |
| ck-pi-think-low | gpt-5.5 | low | — | — | TBD | TBD | TBD | TBD |
| ck-pi-think-adapt | gpt-5.5 | adaptive | — | — | TBD | TBD | TBD | TBD |
| ck-pi-ext-memory | gpt-5.5 | medium | memory | — | TBD | TBD | TBD | TBD |
| ck-pi-ext-many | gpt-5.5 | medium | memory,wiki,dream | — | TBD | TBD | TBD | TBD |
| ck-pi-pkg-web | gpt-5.5 | medium | — | pi-web-access | TBD | TBD | TBD | TBD |
| ck-pi-slack | gpt-5.5 | medium | — | — | TBD | TBD | TBD | TBD |

Filled by P2.4 once W.27 unblocks Phase 1.

## Phase 3 — eggs on

Substrate: TBD on the next P3.7 run.
Pool state: per `docs/eggs-variants.md` (gpt-5.5 ×3, gpt-5.5+memory ×2, deepseek-v4-pro ×1).

Hatch path (matching variants) vs slow-birth fallback (off-menu) noted per-row.

| Variant | Match | p50 (s) | Δ vs Phase 2 | Notes |
|---|---|---|---|---|
| ck-pi-gpt55 | hatch (gpt-5.5 vanilla) | TBD | TBD | |
| ck-pi-ext-memory | hatch (gpt-5.5+memory) | TBD | TBD | |
| ck-pi-deepseek-pro | hatch (deepseek-v4-pro vanilla) | TBD | TBD | |
| ck-pi-gpt55-pro | slow-birth (off-menu) | TBD | TBD | falls through to Phase 2 path |
| ck-pi-pkg-web | slow-birth (packages off-menu) | TBD | TBD | |

Target: ≥4× drop on hatch rows.

## Phase 4 — capability-deferred install

Substrate: TBD on the next P4.4 run.
Pool state: per `docs/eggs-variants.md`.

| Variant | Closest match | p50 to talk-ready (s) | Install completion (s) | Δ vs slow-birth |
|---|---|---|---|---|
| ck-pi-pkg-web | gpt-5.5 vanilla + deferred pi-web-access | TBD | TBD | TBD |
| ck-pi-ext-many | gpt-5.5+memory + deferred wiki+dream | TBD | TBD | TBD |

Target: hand off to talk in pool-time (~5–15s), not install-time (~30–60s+).

## Notes

- p50 is the magical-first-talk metric. Min/max captured for outlier visibility (cold-cache, lume slow-paths, network jitter).
- Each P2.4/P3.7/P4.4 run replaces the corresponding row(s); old measurements get archived in this file's commit history rather than crowding the table.
- The `cells birth-timings` log at `~/.cells/logs/birth-timings/<name>.log` (P2.5 progress chip's source) gives per-step breakdowns when investigating regressions.
