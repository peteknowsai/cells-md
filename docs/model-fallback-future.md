# Model fallback chain — future work

The v1 of per-cell model fallback (shipped this branch) is the simplest
useful version: each cell has a `modelChain` in its `.pi/settings.json`,
pi-coding-agent's `_handleRetryableError` advances to the next entry when
retries on the current model exhaust, and the swap is sticky for the rest
of the session. The cell genuinely runs on the new model — no proxy
translation, no UI lying, just a real `setModel()` call.

This file captures the obvious next steps. None of them are required for
v1 to be useful.

## Auto-probe back to primary

Right now: once a cell falls from opus → gpt-5.5, it stays on gpt-5.5
until the user `/model claude-opus-4-7` manually. Long sessions will get
stuck on a fallback after a transient outage.

Pete on this: *"once a cell falls to a thing, for now it just stays
there. I think that is the future."*

**Sketch of v1.1**: after a fallback, set `nextProbeAt = now + 30min` on
the session. On the next user turn after that timestamp, send a tiny
no-op probe (e.g. `messages: [{role:"user", content:"ping"}]`,
`max_tokens: 1`) to the primary model. If it succeeds, swap back via
`setModel()` and emit a `model_probe_recovery` event. If it fails, push
`nextProbeAt` out by another 30 min.

**Open questions**:
- Probe timing: 30 min is a starting point. Could be exponential backoff.
- User-visible feedback during probe: do we tell the user "probing opus
  again..." or do it silently? Probably silent unless it succeeds, then
  a one-line "back on opus" notice in the activity feed.
- What if the probe succeeds but the next *real* turn fails again?
  Don't loop — track recent probe history and require N successful
  consecutive turns on the recovered primary before considering it
  "back."

## CLI for managing chains

Today the chain is set at birth and only changeable by editing
`~/.pi/settings.json` on the cell directly. A laptop CLI surface:

```
cells stack <cell> list                        # show ordered chain
cells stack <cell> set <m1> <m2> ...           # replace chain
cells stack <cell> push <model>                # append a tier
cells stack <cell> pop                          # remove last tier
cells stack <cell> reset                        # back to default
cells stack --all set <m1> <m2> ...            # apply to every cell
```

Implementation: a thin command in `cli/cells.ts` that ssh-execs `jq` on
the cell's settings.json, then sends the cell a `/reload-settings`
event so pi-coding-agent picks up the change without restart.

## Per-tier retry policies

Today every tier shares the same retry budget (`maxRetries`, default 3).
A more nuanced model: tier 1 (primary) gets the full budget; tier 2
(fallback) gets fewer retries since we're already in degraded mode and
shouldn't burn time on it; tier 3 gets a single-shot.

Schema sketch:
```json
"modelChain": [
  { "model": "claude-opus-4-7:adaptive", "maxRetries": 3 },
  { "model": "openai-codex/gpt-5.5:high", "maxRetries": 1 }
]
```

Backwards-compatible: array of strings still works (uses default
retry budget per tier).

## Telemetry

Today there's no record of how often fallback fires. Worth tracking:
- How many sessions saw a fallback at least once.
- Distribution of fallback events by (primary, fallback) pair.
- Time-on-fallback per session.

Could surface on the proxy dashboard at `proxy.cells.md/`. Per-cell
counters fed by a `model_fallback` event listener that writes to a
small JSON file.

## Proxy-side coordination

The proxy could centrally know "Anthropic is down right now" and
proactively tell cells to fail over BEFORE they make their first
request of the outage. Today every cell discovers the outage
independently by trying and failing. With proxy coordination, the proxy
would expose `/v1/healthz` reporting Anthropic's status, and cells
would poll it on session start (or via an extension that listens).

Avoid this until needed: the v1 behavior is honest and self-healing
without it. Coordination introduces another point of failure (what if
the proxy's health check is wrong?).

## Extension to other failure modes

Today the patch in `apply-pi-patches.sh` triggers fallback only when
`_handleRetryableError` exhausts its retry budget — i.e., the existing
regex matched some kind of transport/server error and retries didn't
help. That's the right place. But there are other failures we might
want fallback to handle:

- **Context overflow** — `_isRetryableError` returns false. Could we
  fall over to a model with a bigger context window? Probably not worth
  it; the right fix is compaction, which pi-coding-agent already does.
- **Tool-call schema mismatch** — gpt-5.5 might 400 on a tool name
  Anthropic accepts. Sanitize tool names if the fallback path is to
  Codex (matches the regex `^[a-zA-Z0-9_-]{1,64}$`). Could be a future
  patch in the same block.
- **Auth revocation** — if `setModel()` itself throws because
  `hasConfiguredAuth(nextModel)` is false (e.g. the codex JWT got
  revoked), we currently fall through to normal failure. Better
  behavior: skip that tier and try the next one. Easy to add — wrap
  the setModel call in a loop over remaining chain entries.

---

References:
- v1 patch: `proto/mother/dna/scripts/apply-pi-patches.sh` (block 6)
- Settings field: `proto/mother/dna/.pi/settings.json` `modelChain`
- Default chain logic: `cli/cells.ts` `buildDefaultChain`
- Plan that produced this: `~/.claude/plans/okay-i-want-to-giggly-flute.md`
