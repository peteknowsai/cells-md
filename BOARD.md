# Cells — Board

Tasks have IDs `V{phase}.{n}` for new work or legacy `P{phase}.{n}` for deferred items. Owner: `worker`, `steward`, or `pete`.

For test wells, use prefixes: `ck-` (checklist), `wk-` (worker experiments), `nt-` (night experiments). Never touch `mother`, `smoke-*` (Pete's manual smoke wells), or any cell with status `alive` and a real channel binding.

Anthropic models (opus / sonnet / haiku) are out-of-bounds for cells until the Claude Code harness ships — they trip Pete's Claude Max OAuth fingerprint detection. Default cell model chain: `openai-codex/gpt-5.5:high → deepseek-v4-pro:high`.

---

## In Progress

_(none — V1.STEP3 complete; STEP4 next)_

## Blocked

_(empty)_

## Todo (priority order)

### Phase v1 — Magical generic cell

Goal: `cells birth` → ~3s fixed animation → talk prompt → LLM-streamed response from a generic cell. See `PLAN.md` for full design.

#### Implementation

- [x] **V1.STEP1** Bake canned generic cell identity into cell-base. Generic `IDENTITY.md` (cell voice, no harness reference). Default `status.json` + `settings.json` with canned model chain (`openai-codex/gpt-5.5:medium → deepseek/deepseek-v4-pro:high`) + always-on extensions. All `__NAME__` / `__MODEL__` placeholders removed from DNA. `dna/{proto,cells/base}` restructure (proto folder gone, agents under `dna/proto/`, cell DNA template under `dna/cells/base/`). Bake green; verify-fork green. (worker, 2026-05-10 21:24 MT, commit c3a1bbc)
- [x] **V1.STEP2** Refactor `cmdCreate` fast-path: deterministic TS function, no mother in critical path. Auto-name cells (`cell-<6hex>`). Routes to fast-path when no customization flags; legacy mother slow-birth preserved for `--model=...` etc (will reshape in v2). New helpers `directWellCreate`, `setWellAuthPublic` (flips vhost auth to public so cells's secret passes through), `registerSiteService` (TS port of bash script). Live tested: 10s cold-fork birth, "ck-cell> ok" LLM-genuine reply via local welld. (worker, 2026-05-10 21:34 MT, commit 687a399)
- [x] **V1.STEP3** Hibernated cell-base pool. Tier 2 implementation (VM hibernated pre-pi-start; pi cold-starts after wake via site service). Helpers added: `bakeV1Egg`, `consumeV1Egg`, `wakeV1Egg`, `markV1EggLive`, `countV1WarmEggs`, `refillV1PoolToDepth`. CLI: `cells egg bake-v1` (one-shot), `cells egg refill-v1` (to target depth = 1). cmdCreateV1Fast tries pool first, falls back to cold-fork; fire-and-forget refill after consume. Live tested: pool birth in ~2s perceived (vs 10s cold-fork), back-to-back births both hit warm path with auto-refill. (worker, 2026-05-10 21:51 MT, branch worker/V1.STEP3-pool)
- [ ] **V1.STEP4** React Ink birth-animation component (`cli/birth-ui.tsx`). 4 stages × ~750ms (waking → warming → ready → alive). Filling dots + label line beneath. Fixed tempo, decoupled from real birth progress (per Pete's "the animation is theater, not status"). Mounts on `cells birth`, runs 3s on a timer, unmounts at end, hands off to talk prompt. Owner: `worker`. Depends: V1.STEP3 (so the animation completes around when the cell is actually ready).
- [ ] **V1.STEP5** (Optional) Well-rename support via welld API. Check if `well rename` or PUT `/v1/wells/<n>` accepts a new name. If yes, egg from pool gets renamed to user-facing cell name at birth (friendlier than the pool's auto-name). If not, skip — keep the auto-generated `cell-<6hex>` from V1.STEP2. Owner: `worker`. Depends: V1.STEP3.
- [ ] **V1.STEP6** Live test + perf measurement. Run `cells birth` from cold start (empty pool) and warm start (full pool) 10 times each. Measure: animation start → cell-alive, cell-alive → first LLM token, end-to-end birth-to-LLM-token. Record p50/p95 in `docs/perf/birth-to-greeting.md`. Tune if p50 > 5s on warm-start. Owner: `worker`. Depends: V1.STEP3+V1.STEP4.

#### Acceptance

- [ ] **V1.1** `cells birth` shows the 3-stage animation, drops into talk prompt cleanly. Owner: `worker`.
- [ ] **V1.2** First user message hits the cell, LLM streams a real response. No deterministic text from the cell. Owner: `worker`.
- [ ] **V1.3** Birth-to-first-LLM-token ≤ 5s p50, over 10 trials. Owner: `worker`.
- [ ] **V1.4** Pool refill: second `cells birth` immediately after first hits warm-egg path (not cold-fork). Refill completes within 30s after consumption. Owner: `worker`.
- [ ] **V1.5** `cells sleep <name>` → cell hibernates. `cells talk <name>` wakes it within 60s, response streams. Owner: `worker`.
- [ ] **V1.6** `cells stop <name>` → cell stopped. `cells wake <name>` → cell back to alive. Then talk smoke succeeds. Owner: `worker`.
- [ ] **V1.7** `cells kill <name> --yes` cleans up: well destroyed, registry entry removed, vault entry removed (if any), CF Worker removed (if any). Owner: `worker`.
- [ ] **V1.8** Two cells coexist. Birth `cell-a` then `cell-b`. Talk to each; verify isolation (each cell only knows about its own conversation). Owner: `worker`.

---

### Phase v2 — Personality + identity layers (deferred until v1 ships)

When the user wants a specific kind of cell (Chief of Staff, Researcher, etc.), layer personality + per-instance identity on top of the generic cell. Streams in during turn 1, takes effect from turn 2.

- [ ] **V2.1** Define Chief of Staff personality template (system prompt, persona, default behaviors). Bake into cell-base alongside the generic identity, opt-in via flag at birth. Owner: `pete` + `worker`.
- [ ] **V2.2** Per-instance bind payload: name, color, owner identity (slack handle, email), bound channel. Surfaced via `--bind=…` flag at birth or `cells bind <name> ...` command.
- [ ] **V2.3** "Become" extension in DNA. Runtime identity injection without pi restart. Pi accepts a `/become` message, updates internal state, future turns use new identity.
- [ ] **V2.4** Hot-reload of personality MD during turn 1 (while user reads the generic greeting). Takes effect on turn 2's LLM call.

---

### Phase v3 — Cloud lifecycle + polish (deferred)

- [ ] **V3.1** CF Worker reliable WS upgrade (was old P5.1/P5.2). Per-cell `wss://<name>.cells.md/agent` returns 101 cleanly and proxies WS messages bidirectionally.
- [ ] **V3.2** Slack channel binding: `#cells-<name>` created automatically; inbound/outbound messages mirror between Slack and the cell's talk session.
- [ ] **V3.3** Vault markdown sync: cell's IDENTITY.md, CELLS.md, SOUL.md sync to `~/Obsidian/cells/<name>/` on schedule.
- [ ] **V3.4** Multi-device access verified: from iPhone Mac browser, `wss://<name>.cells.md/agent` opens, prompt round-trips, closes clean.
- [ ] **V3.5** Mother's post-talk birth ritual runs async in tailPromise: deploys CF Worker, binds Slack, saves vault, records memory.

---

### Deferred from previous plan (no longer gating)

The old Phase 1 variant matrix (P1.4–P1.16) and most of Phase 1b CLI walk are superseded by v1's acceptance items. Specifically:

- **P1.4** ck-pi-gpt55-pro — dropped. gpt-5.5-pro is paid-API (not subscription); never belonged in the matrix. Was killed mid-flight (mother stuck for hours; see JOURNAL 2026-05-10 15:14 MT).
- **P1.5–P1.13** Variant births — superseded by "every cell is the canned generic cell" in v1. Variants come back as v2 personality+binding swaps.
- **P1.14** Lifecycle on a cell — covered by V1.5/V1.6.
- **P1.15** Cleanup verification — covered by V1.7.
- **P1.16** Matrix sign-off — replaced by v1 acceptance sign-off.
- **P1b.1–P1b.20** CLI surface walk — partially absorbed (V1.5/V1.6/V1.7 cover sleep/wake/stop/wake/kill/list). Other items (tui visual, sync, dream, channel ops) move to v3 / future.
- **P2.1–P2.5** Auto-seed — already implemented; default behavior in v1's cmdCreate.
- **P3.1–P3.7** Eggs — design persists, but v1's pool is just 1 generic egg. Multi-variant pools come back if we ever want per-variant cells.
- **P4.1–P4.4** Capability-deferred install — v2 territory.
- **P5.1–P5.3** Cloud talk — V3 territory.

---

### Cells follow-ups (worker-discovered)

- [ ] **C.1** Legacy-cell compat for `cells tui`/`shell`/`dream`/`refresh-extensions` — iter 18 wrapped these in `sudo -u cell`, which 100% works on /cell cells but breaks on pre-migration cells (`smoke-8`, `smoke-6`) since the `cell` user doesn't exist there. Workaround: `well exec -s <name> -- <cmd>` directly. Pete's plan is kill-and-rebirth, no in-place migration. Stays as known gap; cleared automatically when legacy cells get killed in V1.7 cleanup pass.

### Wells follow-ups (surface to team)

- [ ] **W.28** **needs-wells**: `ServiceDefinition` schema (splites/lib/schemas.ts) doesn't expose a `user` field, and `composeUnit` (splites/lib/services.ts:53) hardcodes `User=ubuntu` in the systemd unit. Cells's site service writes to `/cell` (cell:cell 0755) — ubuntu can read but not write. Cells works around in `register-site-service.sh` by wrapping the service body in `sudo -u cell bash -c '...'`. A native `user: "cell"` field on `ServiceDefinition` would obviate the wrap. Surfaced 2026-05-10 03:35 MT.

---

## Done

- [x] **P1.3** Birth + verify `ck-pi-gpt55` on `wells-stable-2026-05-10h`. All 8 birth steps stamped; §4 verification green (alive, all steps in birth-timings, /etc/environment has CELLS_PROXY_SECRET, no __NAME__ placeholders, harness=pi, no __CELL_BG__, site service 200, talk smoke replies "ok"). CF Worker remote talk path still fails (separate v3 work). Side-effect fixes shipped on the way: cells's bake recipe installs pi+bun (was assumed in wells base, dropped from -10g rebake) + chmod /home/well 0755 (default 0750 blocks cell user traverse). First end-to-end birth-to-talk on the project. (worker, 2026-05-10 15:32 MT)
- [x] **W.29** Root cause (per direct cells↔wells Claude-Code chat 2026-05-10 ~14:35–15:03 MT): wells's rinse was `rm /etc/machine-id; touch /etc/machine-id`, leaving a 0-byte file. systemd's `sshd-keygen.service` has `ConditionFirstBoot=yes` which fires precisely when `/etc/machine-id` is empty — so every fork triggered early-boot RSA keygen on cold entropy, hanging sshd. Wells's `wells-stable-2026-05-10g` rinse stops zeroing machine-id and stops deleting `/etc/ssh/ssh_host_*`. (closed 2026-05-10 15:03 MT)
- [x] **W.27** Wells shipped well-firstboot etc-environment.append handler (`splites/templates/well-firstboot.sh:67-76`). Verified on ubuntu-25.10-base + --env: /etc/environment carries the wells-env block. (verified 2026-05-10 10:35 MT)
- [x] **W.23** Wells shipped pool zombie auto-prune + `pool drain --all` in `wells-stable-2026-05-10d`. (closed 2026-05-10 02:57 MT)
- [x] **W.24** Wells shipped welld plist template fix (PATH adds `/usr/sbin`). (closed 2026-05-10 02:57 MT)
- [x] **W.25** Wells shipped per-entry tolerance in `GET /v1/wells/images`. (closed 2026-05-10 02:57 MT)
- [x] **P2.5** Birth progress chip — `runPiWithOutcome` takes `{ progressName }`, tails birth-timings, renders chip on stderr. Untested live but logic verified. Will be superseded by V1.STEP3's Ink animation. (worker, 2026-05-10 02:48 MT)
- [x] **P1.2a** Migrated cells DNA + harness state to `/cell/` with user `cell`. Bake produces cell-base; verify-fork passes; full /cell tree confirmed (DNA, .pi, bin, site, scripts, .tmux.conf), /etc/profile.d/cells-env.sh wired. (worker, 2026-05-10 02:14 MT)
- [x] **P1.2** Bake §2 acceptance gate. Passes via P1.2a verify. (worker, 2026-05-10 02:14 MT)
- [x] **P1.1** Pre-flight 7 checks. Mother answered. Substrate healthy. (worker, 2026-05-09 23:00 MT)
