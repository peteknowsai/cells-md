# Cells — Board

Tasks have IDs `P{phase}.{n}`. Owner: `worker`, `steward`, or `pete`.

For test wells, use prefixes: `ck-` (checklist), `wk-` (worker experiments), `nt-` (night experiments). Never touch `mother`, `smoke-*` (Pete's manual smoke wells), or any cell with status `alive` and a real channel binding.

Anthropic models (opus / sonnet / haiku) are out-of-bounds for the matrix until the Claude Code harness ships — they trip Pete's Claude Max OAuth fingerprint detection.

---

## In Progress

_(empty)_

## Todo (priority order)

### Phase 1 — Birth checklist passes (acceptance gate)

- [ ] **P1.1** Run `docs/birth-checklist.md` §1 (pre-flight). Verify substrate health, secrets present, mother talkable. Owner: `worker`.
- [ ] **P1.2** Run `docs/birth-checklist.md` §2 (bake verification). Fork a throwaway from `cell-base`, prove `/etc/environment` env injection works, `~/.bashrc.d/` shims exist, `~/agent/` DNA + node_modules present, placeholders intact. If any fail, run `cells bake --force` and re-verify. Owner: `worker`.
- [ ] **P1.3** Birth + verify `ck-pi-gpt55` (`--model=gpt-5.5`). Run §4 per-birth verification. Owner: `worker`.
- [ ] **P1.4** Birth + verify `ck-pi-gpt55-pro` (`--model=gpt-5.5-pro`). Run §4. Owner: `worker`.
- [ ] **P1.5** Birth + verify `ck-pi-deepseek-pro` (`--model=deepseek-v4-pro --thinking=high`). Run §4. Owner: `worker`.
- [ ] **P1.6** Birth + verify `ck-pi-deepseek-fl` (`--model=deepseek-v4-flash`). Run §4. Owner: `worker`.
- [ ] **P1.7** Birth + verify `ck-pi-think-low` (`--model=gpt-5.5 --thinking=low`). Confirm `.pi/settings.json` shows `defaultThinkingLevel: "low"`. Owner: `worker`.
- [ ] **P1.8** Birth + verify `ck-pi-think-adapt` (`--model=gpt-5.5 --thinking=adaptive`). Confirm pi-coding-agent's adaptive patches are landed. Owner: `worker`.
- [ ] **P1.9** Birth + verify `ck-pi-ext-memory` (`--extensions=memory`). Confirm only `memory` extension is on disk plus the always-on five. Owner: `worker`.
- [ ] **P1.10** Birth + verify `ck-pi-ext-many` (`--extensions=memory,wiki,dream`). Owner: `worker`.
- [ ] **P1.11** Birth + verify `ck-pi-pkg-web` (`--packages=pi-web-access`). Confirm `pi list` shows it. Owner: `worker`.
- [ ] **P1.12** Birth + verify `ck-pi-slack` (`--channels=slack`). Confirm `#cells-ck-pi-slack` exists, binding mirrors. Owner: `worker`.
- [ ] **P1.13** Birth + verify `ck-pi-tui` (no flags — interactive). Sanity-test the picker UX runs through. Owner: `worker`.
- [ ] **P1.14** Run §5 lifecycle on `ck-pi-gpt55`: sleep / talk-wakes / stop / wake / checkpoint / see. Owner: `worker`.
- [ ] **P1.15** Run §6 cleanup. Verify wells, registry, vault, CF Workers all swept. Owner: `worker`.
- [ ] **P1.16** Sign-off: append the pass line to `state/memory/project_cells_activity.md`. Owner: `worker`.

### Phase 2 — Auto-seed first message

- [ ] **P2.1** Add `--seed=<text>` flag to `cells birth`. Default value: `"introduce yourself in one sentence and tell me what you can help with"`. `--seed=off` opts out. Document in `cells birth --help`. Owner: `worker`.
- [ ] **P2.2** Wire seed into the post-birth talk hand-off. After mother reports `success: true`, the CLI auto-opens the talk session AND auto-sends the seed prompt before yielding to the user's terminal. The greeting streams back into the user's terminal. Owner: `worker`. Depends: P2.1.
- [ ] **P2.3** Slack-bound cells: confirm seed greeting also lands in `#cells-<name>` (mirror behavior matches a manual prompt). Owner: `worker`. Depends: P2.2.
- [ ] **P2.4** Measure p50 birth-to-greeting on the current substrate (no eggs). Record in `docs/perf/birth-to-greeting.md` with one row per matrix combo. Owner: `worker`. Depends: P2.2.
- [ ] **P2.5** UX polish: while birth is running, the CLI shows a one-line progress chip ("step 4: site service…") so the user knows we're working. Falls through to seed-greeting streaming when ready. Owner: `worker`. Depends: P2.2.

### Phase 3 — Eggs (pre-warmed, agent-managed pool)

- [ ] **P3.1** Read existing `docs/eggs.md` + `docs/eggs-phase-1.md` and the project_eggs_v2_architecture memory. Write `docs/eggs-spec.md` consolidating the v2 design with the wells-team `pool_size` substrate primitive, agent-management layer on top, and the "common variants pre-baked" idea. Owner: `worker`.
- [ ] **P3.2** Define the variant matrix — which (model × extensions × packages) combos earn a pre-baked egg vs. which fall through to capability-deferred install. Recommendation: top-3 by frequency. Document in `docs/eggs-variants.md`. Owner: `worker`. Depends: P3.1.
- [ ] **P3.3** Implement `cells egg list/refill/drain` CLI surface. Mirror wells's `well pool` shape but operate on agent-aware variants. Owner: `worker`. Depends: P3.2.
- [ ] **P3.4** Implement the egg refill agent — keeps the pool topped up at desired depth per variant. Runs as a launchd plist (like pulse). Owner: `worker`. Depends: P3.3.
- [ ] **P3.5** Implement hatching: `cells birth <name> [flags]` first checks if a compatible egg is in the pool; if so, binds the name + substitutes identity + attaches to the talk session in <15s. Owner: `worker`. Depends: P3.4.
- [ ] **P3.6** `--no-pool` flag for forcing slow-birth (testing). Owner: `worker`. Depends: P3.5.
- [ ] **P3.7** Measure p50 birth-to-greeting with eggs on. Confirm 4× drop vs Phase 2 baseline. Update `docs/perf/birth-to-greeting.md`. Owner: `worker`. Depends: P3.5.

### Phase 4 — Capability-deferred install

- [ ] **P4.1** Define the "in-flight install" status surface — a JSON file the cell agent reads in its system prompt so it can self-narrate ("I'm still loading pi-web-access; ask me again in 30s if you need it"). Owner: `worker`.
- [ ] **P4.2** Implement post-hatch background install — when a hatched egg is missing requested extensions/packages, install them after the seed-greeting starts. Talk session stays live. Owner: `worker`. Depends: P3.5, P4.1.
- [ ] **P4.3** Failure mode: surface install failures as graceful agent replies, not silent broken cells. Owner: `worker`. Depends: P4.2.
- [ ] **P4.4** Measure p50 birth-to-greeting with capability-deferred install for off-menu configs. Update perf doc. Owner: `worker`. Depends: P4.2.

### Phase 5 — Cloud talk path (lower priority)

- [ ] **P5.1** Apply wells team's diagnostic — run `curl -i -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" -H "Sec-WebSocket-Version: 13" https://<name>.cells.md/agent` against an alive cell and see whether the per-cell CF Worker returns 101 or anything else. Document in JOURNAL. Owner: `worker`. Depends: P1 done (need an alive cell).
- [ ] **P5.2** If P5.1 shows the Worker mangling the upgrade: fix the per-cell Worker to either preserve `Upgrade`/`Connection` headers when forwarding via `fetch()`, switch to `WebSocketPair()` for in-Worker proxying, or have cloudflared route `/agent` directly to welld and skip the Worker for WS. Owner: `worker`. Depends: P5.1.
- [ ] **P5.3** Verify cloud path end-to-end: from a non-Mac (e.g. iPhone Mac browser), `wss://<name>.cells.md/agent` opens, a prompt round-trips, close clean. Owner: `worker`. Depends: P5.2. May be `needs-pete-session: browser` for the actual round-trip test.

## Blocked

_(empty)_

## Done

_(filled in as work completes)_
