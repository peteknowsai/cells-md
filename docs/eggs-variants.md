# Egg variants — what to bake, what to defer

Per `docs/eggs-spec.md` Phase 3, the egg pool keeps a small set of pre-baked variants warm. Off-menu requests fall through to capability-deferred install (Phase 4): the closest egg gets hatched, then missing extensions/packages install in the background while the seed-greeting is already streaming.

This doc settles **which variants earn a pre-baked egg**, what stock depth each gets, and what triggers re-tuning.

## The framing

Two costs in tension:

- **Pool cost (storage + idle compute).** Each warm egg is a stopped well consuming disk for the cell-base + variant-bake delta (~50–100 MB delta). 10 cold eggs is real. 100 is real money.
- **Hatch latency for off-menu requests.** Capability-deferred install runs in the background after the talk session is live, so the user can talk in 5–15s, but tool calls into the deferred capability fail until install finishes (~30–60s for one extension, longer for `pi-web-access` which compiles).

The wedge is: pre-bake the top-N most-frequent variants so most births hit a warm egg. Tail variants accept the deferred-install latency.

## Inputs

We don't have weeks of `cells birth` telemetry yet, so initial weights come from:

1. Pete's daily-driver pattern (gpt-5.5, no extensions, no packages) — most-common shape from manual flow.
2. The birth checklist matrix (`docs/birth-checklist.md` §3) — what we exercise as canonical.
3. Anthropic constraint per `feedback_birth_death_flexible.md`: `opus`/`sonnet`/`haiku` are blocked at the worker level until Claude Code harness ships. Don't bake what we can't safely birth.

## Pre-baked variants (Phase 3 launch)

| # | Variant key                                                          | Stock depth | Why                                                                 |
|---|----------------------------------------------------------------------|-------------|---------------------------------------------------------------------|
| 1 | `v1:model=gpt-5.5,thinking=,extensions=,packages=,channels=`         | **3**       | Daily-driver default. Most `cells birth bob` invocations land here. |
| 2 | `v1:model=gpt-5.5,thinking=,extensions=memory,packages=,channels=`   | **2**       | Memory is the most-used optional extension; long-lived cells need it. |
| 3 | `v1:model=deepseek-v4-pro,thinking=,extensions=,packages=,channels=` | **1**       | Cheaper inference for ops-bot cells; one warm covers occasional use. |

That's **6 warm eggs** total, ~360–600 MB of variant-bake delta on top of the shared `cell-base` image.

`thinking` and `channels` are stripped from the pool key (they're hatch-time-cheap — tunable in `.pi/settings.json` or wired up at bind time). Two birth requests with different thinking levels but the same model/extensions/packages share the same pool slot.

## Why these three

- **gpt-5.5 vanilla (3)**: matches Pete's `cells birth bob` reflex. Three slots so a quick `birth → kill → birth → kill` cycle (e.g., during checklist runs) doesn't drain the pool faster than the refill agent can replenish.
- **gpt-5.5 + memory (2)**: memory is the canonical "make this cell remember things across sessions" pattern. Two slots because users who want memory often want a few cells that all have it.
- **deepseek-v4-pro vanilla (1)**: cost-sensitive use cases, occasional. One warm slot is enough; if multiple deepseek births stack up the second falls through to slow-bake.

Total inventory at steady state: 6 eggs, ~3 GB on top of the 5.7 GB cell-base. Acceptable on Pete's Mac.

## What does NOT earn an egg (and why)

- **`gpt-5.5-pro`**: Pro tier. Lower frequency, premium use case. Slow-bake on demand or hatch from gpt-5.5 + capability-deferred install of any pro-only patches.
- **`deepseek-v4-flash`**: flash is fast inference, less commonly used than pro for sustained agent work. One warm if frequency observed.
- **`extensions=mentality`, `extensions=wiki`, `extensions=dream`**: lower frequency than memory; capability-deferred install at hatch.
- **`packages=pi-web-access`**: the install is the slowest deferred op (~30s+, npm + native build). If observed weekly, promote to a baked variant. Until then, deferred.
- **`channels=slack`**: zero impact on the bake — Slack channel + binding are post-hatch async. Pool key correctly strips channels.
- **All Anthropic models**: deliberately excluded until Claude Code harness ships. The pi-emulated path on cell IPs is fingerprint-termination risk on Pete's Claude Max OAuth subscription. When Claude Code lands, add `claude-code × opus` ×1, `claude-code × sonnet` ×1.

## Closest-match-and-tweak (Phase 4)

Off-menu request flow:

1. CLI computes pool key from request.
2. Scan `~/.cells/eggs.json` for exact-match `state=warm`. Found → hatch.
3. **Not found** → score every warm egg by overlap on (extensions, packages). Pick highest score with same model. (Different model = no match — model patches differ.)
4. Hatch the closest egg. Mark the cell's `/cell/.pi/in-flight.json` with the missing extensions/packages.
5. Background install runs. Cell agent's system prompt reads in-flight.json; can self-narrate ("loading pi-web-access; ask again in ~30s").
6. On install completion, in-flight.json is cleared. Failed installs surface as graceful agent replies, not silent broken cells.

Scoring formula (Phase 4 implementation):

```
score = exact_extension_overlap * 2
      + exact_package_overlap * 3   # packages cost more deferred → prefer match
      - missing_extension_count * 1
      - missing_package_count * 2   # missing pkg = 30s+ degraded period
```

Tiebreak on egg age (prefer freshest).

## When to re-tune the pool

Refill agent (P3.4) writes a daily summary to `~/.cells/logs/eggs/usage.log`. Steward checks it during morning triage. Re-tune when:

- A non-pre-baked variant has been hatched ≥3× in 7 days → promote to a baked slot (steal depth from the least-used pre-baked variant or grow the pool).
- A pre-baked variant hasn't been hatched in 30 days → cull its depth, free the disk.
- Capability-deferred install latency consistently > 60s for the same package → consider promoting variants that include it.

The pool is a hot cache, not a contract. Frequency drives shape.

## Acceptance for P3.2

- [x] Initial pre-baked variant table is defined here with stock depths.
- [x] Anthropic exclusion is documented and tied to its memory feedback.
- [x] Capability-deferred install policy + closest-match scoring is specified.
- [x] Re-tuning trigger is documented (so this doc doesn't bit-rot).

When P3.4 (refill agent) ships, this doc's table becomes the agent's initial config (`~/.cells/eggs-config.json` schema TBD in P3.3).

## Open questions deferred to implementation

- **`eggs-config.json` schema**: where do stock depths live? Inline in the refill agent code, in a config file, in BOARD? Recommendation: a single `~/.cells/eggs-config.json` that Pete or the steward edits; refill agent watches it.
- **Cost telemetry**: surface "current pool is costing $X/month equivalent in storage" in the refill agent's daily summary? Phase 4+ nice-to-have.
- **First-egg priority on cold start**: when cells boots and the pool is empty, which variant bakes first? Recommendation: row 1 (gpt-5.5 vanilla), since it's the most likely first request.

## Pointers

- Spec: `docs/eggs-spec.md`
- Operator runbook: `docs/eggs.md`
- Phase 1 implementation plan: `docs/eggs-phase-1.md`
- v2 architecture memory: `~/.claude/projects/-Users-pete-Projects-cells/memory/project_eggs_v2_architecture.md`
- Anthropic exclusion rationale: `feedback_birth_death_flexible.md`
