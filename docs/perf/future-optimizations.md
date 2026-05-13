# Future perf optimizations

Things we know would shave latency but are deferred until the surrounding
architecture is settled.

## Pre-send the seed message during birth animation

**Cost saved:** ~1-1.5s on birth-to-first-token (LLM cold-start latency).
**Today:** birth animation runs 5s, talk drops in at t=5s, sends seed
message, LLM takes ~1.2s to start streaming → first-token ≈ 6.2s.
**Optimization:** send the seed message into pi as soon as the prewarm's
`bridge_ready` fires (during the animation), buffer the LLM response,
start RENDERING when the animation ends. LLM is already mid-stream by
then so first-token ≈ 5.0-5.1s.

**Why deferred (2026-05-12):** today eggs are all v1-generic (pi + deepseek).
With v2, eggs will diverge — claude-code harness, codex harness, multiple
model variants. The right shape there is a *basket* of eggs keyed on
harness+model, not one warm pool. Pre-send adds a layer of "stream
buffering" that needs to be re-evaluated once that basket exists (each
harness may have its own first-byte behavior). Do the basket work first,
then revisit pre-send.

**Implementation sketch (when picked up):**
- Move seed-message dispatch from end of `cmdCreateV1Fast` (after
  animation) to right after `prewarmHostBridge` succeeds (during animation).
- `streamCellBridge` grows a `buffer-until-animation-ends` mode: open WS,
  send seed, accumulate token chunks, flush to stdout when caller signals
  ready.
- Caller signals ready via a promise that resolves when the birth-ui
  animation unmounts.

## Other things noted as we go

(Add entries as they surface — keep this list short and motivated, not a
backlog.)
