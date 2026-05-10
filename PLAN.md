# Cells — Plan

## Thesis

A fleet of always-on AI agents, each in its own well (a hardware-isolated Linux VM on Pete's Mac), addressable by name. The product wedge is **the magical first-talk experience**: `cells birth bob --model=gpt-5.5 --extensions=memory` returns to a prompt where Bob is *already greeting Pete back*, within seconds, without Pete having to type the first message. Everything that doesn't shorten birth-to-greeting time or polish the greeting itself is secondary.

The substrate (welld, lume, Cloudflare Workers, cloudflared) is somebody else's problem most of the time. Cells's job is the harness, the DNA, the birth ritual, the talk loop, and the agent ergonomics that make a cell feel alive.

## Phases

### Phase 0 — Infrastructure (this session)

Pete Loop set up. PLAN/BOARD/JOURNAL/STATUS in place. Worker can fire on real tasks. Done when `/start-pete-loop` returns the first `worker(P0.x): …` line and a follow-up turn picks up a P1 task cleanly.

### Phase 1 — Birth checklist passes (acceptance gate)

Run the `docs/birth-checklist.md` matrix end-to-end with no failures. 11 rows × per-birth verification × lifecycle exercises × clean cleanup. This is the "birth as it stands today actually works for every flag we expose" gate. Done when the checklist passes in a single run and `state/memory/project_cells_activity.md` carries the sign-off line.

This phase must come first — there's no point optimizing first-talk latency on a flow that doesn't reliably finish.

### Phase 1b — Full CLI smoke

Walk every `cells` subcommand against a real alive cell. Phase 1 confirms birth across the flag matrix; Phase 1b confirms `talk`, `sleep`, `wake`, `stop`, `checkpoint`, `tui`, `shell`, `sync`, `dream`, `refresh-extensions`, `heartbeat`, `channel`, `see`, `doctor`, `schedule-pulse`, `schedule-pi-patches`, `kill --all-but`, `pi` (mother TUI). Includes visual checks inside `cells tui`: status bar color chip, harness rendering, `mft` launching cleanly, key bindings, persistent session on detach. Done when every CLI verb has been exercised against a live cell and the assertions pass.

### Phase 2 — Auto-seed first message

`cells birth bob` no longer drops Pete into an empty prompt. The moment the cell can answer (post-step-4b verify), the CLI auto-sends `"introduce yourself"` (or a configurable seed) so Pete sees Bob greeting him as soon as the talk session opens. Streaming works the same as a manual prompt.

Done when:

- `cells birth <name>` flag `--seed=<text>` works (default: `"introduce yourself in one sentence and tell me what you can help with"`)
- `--seed=off` opt-out preserved
- The greeting lands in the same talk session the user dropped into, not a separate one
- Slack-bound cells: greeting also mirrors to Slack as expected
- p50 birth-to-greeting under the current substrate (no eggs yet) is recorded in `docs/perf/birth-to-greeting.md`

### Phase 3 — Eggs (pre-warmed wells, agent-managed pool)

Wells team's `pool_size` config makes well-create sub-3s. Cells layers an agent-management pool on top:

- A pool of pre-warmed wells with the cell-base image already booted
- Common configurations pre-applied (the most-frequent harness × model × extensions combos baked in)
- "Hatching" = bind a name to a pre-warmed well, substitute identity, attach to the talk session

See `docs/eggs-spec.md` for the consolidated v2 architecture (with `docs/eggs.md` + `docs/eggs-phase-1.md` retained as prior context). Initial pool sizing in `docs/eggs-variants.md`.

Done when:

- Hatching from a pool is the default path for `cells birth` when a compatible egg exists
- `cells birth <name> --no-pool` opt-out for testing
- `cells egg list/refill/drain` CLI surfaces depth + types
- p50 birth-to-greeting drops by at least 4× vs Phase 2 baseline

### Phase 4 — Capability-deferred install

When user picks a config that isn't pre-baked into any pool, birth still hands them a talkable cell fast: the missing extensions / packages install **after** the seed-greeting has already begun, in the background, on the cell. The talk session is live during the install; the cell itself can comment on what's loading.

Done when:

- A birth that would otherwise need package installs (e.g. `--packages=pi-web-access`) returns to a talk-ready state in pool-time, not install-time
- The cell becomes self-aware of in-flight installs (via a status file the agent reads in its system prompt)
- Failed background installs surface to the user as a graceful "I couldn't load X yet — try again in a minute" reply rather than a silent broken cell

### Phase 5 — Cloud talk path

Off-Mac access to cells via `wss://<name>.cells.md`. Currently broken with 1002 protocol error — wells team's diagnostic points at the per-cell CF Worker stripping `Upgrade` headers when forwarding via `fetch()`. Either fix the Worker to preserve upgrade, switch to `WebSocketPair()` for in-Worker WS proxying, or have cloudflared expose `/agent` directly and skip the Worker for WS.

Lower priority than 1-4 because Pete is on the Mac. Don't let it sneak ahead unless 1-4 are clean.

## Architectural principles

1. **First-talk latency is the metric that matters.** Every shipped feature reports a delta on `docs/perf/birth-to-greeting.md`.
2. **Loop-friendly first.** Prefer file-based state, headless tooling, bounded work cycles. The worker turns every Claude Code turn — design tasks for that cadence.
3. **Cheap experiments before expensive infra.** Validate before scaling. A throwaway smoke cell beats a doc.
4. **Don't fight the substrate.** Welld/lume issues go to wells team via the steward's `needs-wells:` bundling. We don't reimplement their fixes.
5. **Anthropic on cell IPs is poison for the OAuth subscription.** Pete has memory-tagged this multiple times. Default model for cells is gpt-5.5 via openai-codex. Anthropic via API key (paid) is fine; via Pete's Claude Max sub from inside a cell is a ban risk and gets blocked at the worker.
6. **Birth/death stay LLM-routed.** The skill prose at `proto/mother/.pi/skills/birth/SKILL.md` IS the program. Iterate on prose, don't migrate to TS.
7. **Solo-dev git flow.** Branch off main → commit → squash merge to main → push. No PRs unless asked.
8. **Night work goes to a `night/<date>` branch, never to main.** The morning steward fire bundles it into one approve-or-discard touch.

## Loop architecture

The worker is driven by the Pete Loop — a Stop hook in `.claude/hooks/pete-loop-stop.sh` that re-injects the worker prompt after every Claude Code turn until the flag file is removed or 200 turns elapse. The steward fires manually via `/steward`. State lives on disk in this repo (PLAN/BOARD/JOURNAL/STATUS).

`/start-pete-loop` to begin a grinding session. `/stop-pete-loop` to halt. `/steward` for triage. `/worker` for one manual single-fire turn.
