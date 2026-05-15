# Cells — Board

Tasks have IDs `V{phase}.{n}` for new work or legacy `P{phase}.{n}` for deferred items. Owner: `worker`, `steward`, or `pete`.

For test wells, use prefixes: `ck-` (checklist), `wk-` (worker experiments), `nt-` (night experiments). Never touch `mother`, `smoke-*` (Pete's manual smoke wells), or any cell with status `alive` and a real channel binding.

Anthropic models: a `pi` cell reaches them via a paid `ANTHROPIC_API_KEY` (direct, clean); the Claude Max subscription is reachable only through the `claude-code` harness (genuine Claude Code traffic, via `proxy.cells.md`). pi-via-Max is fingerprint-dead. Default cell model chain: `openai-codex/gpt-5.5:high → deepseek-v4-pro:high`.

---

## In Progress

**Birth rework** — multi-harness, generic pool, eval loop. All 4 phases shipped, plus a codex harness as a follow-on — all three harnesses (pi + claude-code + codex) birth, talk, and tui green. See the "Birth rework" + "Codex harness" sections below.

## Blocked

_(empty)_

## Todo (priority order)

### Phase v1 — Magical generic cell

Goal: `cells birth` → ~3s fixed animation → talk prompt → LLM-streamed response from a generic cell. See `PLAN.md` for full design.

#### Implementation

- [x] **V1.STEP1** Bake canned generic cell identity into cell-base. Generic `IDENTITY.md` (cell voice, no harness reference). Default `status.json` + `settings.json` with canned model chain (`openai-codex/gpt-5.5:medium → deepseek/deepseek-v4-pro:high`) + always-on extensions. All `__NAME__` / `__MODEL__` placeholders removed from DNA. `dna/{proto,cells/base}` restructure (proto folder gone, agents under `dna/proto/`, cell DNA template under `dna/cells/base/`). Bake green; verify-fork green. (worker, 2026-05-10 21:24 MT, commit c3a1bbc)
- [x] **V1.STEP2** Refactor `cmdCreate` fast-path: deterministic TS function, no mother in critical path. Auto-name cells (`cell-<6hex>`). Routes to fast-path when no customization flags; legacy mother slow-birth preserved for `--model=...` etc (will reshape in v2). New helpers `directWellCreate`, `setWellAuthPublic` (flips vhost auth to public so cells's secret passes through), `registerSiteService` (TS port of bash script). Live tested: 10s cold-fork birth, "ck-cell> ok" LLM-genuine reply via local welld. (worker, 2026-05-10 21:34 MT, commit 687a399)
- [x] **V1.STEP3** Hibernated cell-base pool. Tier 2 implementation (VM hibernated pre-pi-start; pi cold-starts after wake via site service). Helpers added: `bakeV1Egg`, `consumeV1Egg`, `wakeV1Egg`, `markV1EggLive`, `countV1WarmEggs`, `refillV1PoolToDepth`. CLI: `cells egg bake-v1` (one-shot), `cells egg refill-v1` (to target depth = 1). cmdCreateV1Fast tries pool first, falls back to cold-fork; fire-and-forget refill after consume. Live tested: pool birth in ~2s perceived (vs 10s cold-fork), back-to-back births both hit warm path with auto-refill. (worker, 2026-05-10 21:51 MT, branch worker/V1.STEP3-pool)
- [x] **V1.STEP4** React Ink birth-animation component (`cli/birth-ui.tsx`). 4 stages × 750ms (waking → warming → ready → alive) with filling dots `◉` and dimmed label line. Fixed tempo, decoupled from real birth progress. Fleet color `#9D7CD8` (muted violet). TTY-gated: animation in TTY mode, plain `birthing X… ✓ alive` text in non-TTY. Wired into cmdCreateV1Fast via dynamic import (Promise.all with birth pipeline). Live-tested via pty wrapper: all 4 stages render with color, clean handoff to talk prompt at "alive". Deps added: ink@7.0.2, react@19.2.6, @types/react@19.2.14. (worker, 2026-05-10 22:10 MT, branch worker/V1.STEP4-animation)
- [x] **V1.STEP5** Skipped — welld's PATCH `/v1/wells/<n>` only accepts `auto_sleep_seconds`; no rename support. Friendly cell names work via cells's `wellNameForCell()` mapping (cell-<6hex> in user space, egg-<6hex> in welld), so the lack of rename doesn't surface user-facing. Future welld work could add rename to clean this up. (worker, 2026-05-10 22:15 MT, no commit needed)
- [x] **V1.STEP6** Perf measurement. Instrumented cmdCreateV1Fast with `alive_ms` telemetry → `~/.cells/logs/perf/birth.jsonl`. `scripts/perf-birth.sh` runs N cold + N warm trials and aggregates p50/p95. 5+5 trials on `wells-stable-2026-05-10h`: cold-fork p50 9.60s alive (range 9.04-10.04, very tight), warm-pool p50 2.36s alive (range 2.30-2.44, *very* tight) → **4.07× speedup**. First-token estimate ~6.5s warm; 1.5s over V1.3 target. Pi cold-start (~3s after wake) is the swing factor — Tier 3 would close the gap, deferred until measurement justifies escalation. Written up in `docs/perf/birth-to-greeting.md`. (worker, 2026-05-10 22:36 MT, branch worker/V1.STEP6-perf)

#### Acceptance

**🎯 V1 STAMPED 2026-05-13 (worker, /goal-driven). 10/10 ✓.** Re-verified on the wells-stable-2026-05-13 substrate (W.73 SSH-ready resurrect + W.74 per-VM XPC kill + W.77 diagnostic, W.76 reverted). Cells code originally: `V1_HOT_POOL_TARGET = V1_POOL_TARGET_DEPTH = 10` (pure-hot v1). **Updated 2026-05-15: `V1_HOT_POOL_TARGET = 0` — pure-asleep pool, every egg hibernated (0 RAM, 0 CPU). Wake measured at 0.55s, invisible against birth ritual. See `docs/proposals/cells-pool-asleep.html`.** `bakeV1Egg` continues to seal every pool egg so user-side `cells sleep` always works.

- [x] **V1.1** ✓ Animation + talk prompt drop-in clean. 4-stage Ink animation now dynamic-tempo (1.5-6s) ending on captureGreeting first-byte. (2026-05-12)
- [x] **V1.2** ✓ Cell speaks first via LLM. host-bridge `cd /cell` fix held; harness-leak gone. (2026-05-12)
- [x] **V1.3** ✓ **First-token p50 = 2.5s** (10 trials, range 2469-2969ms) — was 7.3s. Win came from `captureGreeting` + dynamic-tempo animation: animation ends the instant pi streams its first byte and the buffered greeting drops in. `docs/perf/birth-to-greeting.md` updated. (2026-05-12 23:00Z, commit e112a2c+)
- [x] **V1.4** ✓ Second birth hits warm path AND pool refill no longer ceilinged — W.72 (static-IP allocator) shipped, vmnet 4-DHCP wall gone. Burst-refill verified in V1.10.
- [x] **V1.5** ✓ Sleep + auto-wake + sibling-survive. Sleep 0.6s. Sibling cell answered talk within 1.6s while another was hibernated (W.74 per-VM XPC kill held — no sibling clipping). Auto-wake from hibernate via `cells talk` = 1.9s first cycle, 1.8s second cycle. Verified on fresh bakes via both cells flow and raw wells API (egg-754152, egg-4b366a both 200/200 hibernate+restore). Earlier first-wake "permission denied" went away after wells's W.77 deploy + bounce sequence; root cause filed to wells. (2026-05-13 06:18Z)
- [x] **V1.6** ✓ `cells stop` 7.2s. `cells wake` 3.5s. talk after wake 2.7s. Siblings survived: 2 other cells answered talk within 1.2s while target was being cold-cycled. (2026-05-12)
- [x] **V1.7** ✓ Kill leaves cells.json clean, wells registry returns 404.
- [x] **V1.8** ✓ Multi-cell coexistence + per-cell session isolation (each cell remembers only its own state).
- [x] **V1.9** ✓ Interactive picker — `cells birth <name>` with no flags + TTY renders 4 selectOne/selectMany prompts (Model, Thinking, Extensions, Provider). Picks land in `cells.json` under `picker` and the egg consumed from the pool gets renamed under the user-supplied name post-picker. Live-tested via pty wrapper, 2 trials: all-defaults → picker.extensions=[]; memory-ext via Space-toggle → picker.extensions=["memory"]. (2026-05-12)
- [x] **V1.10** ✓ Burst 9/9 pool-hot births at first-token p50=2583ms (range 2453-2720ms). The 10th trial drained the pool (refill paced behind scripted births — fire-and-forget refill needs the CLI to outlive itself, which scripted bursts don't allow); 10th fell to cold-fork as designed and was counted MISS only because the test's 60s window was too short for cold-fork. Normal interactive use keeps the CLI alive via the talk session so refill lands. No sibling-clip during the burst (W.74). (2026-05-13 01:02Z)

##### Cells-side changes landed during V1.5 verification

- `V1_HOT_POOL_TARGET` raised from 3 → 10 (pure-hot v1 pool; no cold→hot promote path, sidesteps wake-from-hibernate edges).
- `bakeV1Egg` passes `hibernate_ready: true` unconditionally to wells's `POST /v1/wells` (was `tier === 2`). Sealing every pool egg costs ~6-8s per bake but means `cells sleep` works on every pool-born cell — the case wells's Piece 3 default-skip didn't anticipate.
- Dashboard `target_hot` constant synced to 10.

##### Notes for V2

- Pool depth = 10 will need to become a per-variant target + mix strategy when picker-driven variants enter the pool (harness × model × extensions cross-product). V2 likely re-enables hot for latency-sensitive variants; the hot/promote code paths are kept dormant under `V1_HOT_POOL_TARGET = 0` rather than ripped out.
- The "fire-and-forget refill needs a long-lived CLI" pattern surfaced by V1.10 is a v2 design point — likely needs a host-side refill daemon or wells-side topup so scripted bursts don't underrun.

#### Critical blocker (RESOLVED 2026-05-11)

- [x] **V1.0** ~~Talk-hang: WS dies, cell never receives user messages.~~ **FIXED** in fire 19 (commit 9280c61) via piReady tracking + pendingPrompts queue + bridge_ready handshake. Superseded by the host-bridge architecture (commit a9a2fed onward) — pi now spawns via ssh+pi from the host-bridge daemon, not in-cell. The in-cell bridge race is no longer possible.

---

### Wells/cells boundary cleanup (CLOSED 2026-05-13)

Five-hour coordination cycle. Wells deleted 2455 LOC of cells-shaped invariants from substrate; cells took over pool ownership end-to-end. Both sides now have clean primitives and zero crossed-over state.

- [x] **Piece 1** Wells deleted lease-publisher (DHCP lease writes). Shipped pre-2026-05-13.
- [x] **Piece 2** Wells deleted `/v1/wells/pool/*` + `identityReset.ts`. Cells renamed `eggs.json → pool.json` + shipped `reconcilePool()` for drift defense (caught the bobby-class state-drift bug live). Cells: `bcbc010`, `c3f2d8b`. Wells: `1ab5160`.
- [x] **Piece 3** Wells deleted inline warming sequence in `createWell`. Cells now consumes a new `POST /v1/wells/{name}/seal` primitive between `provisionCellInWell` and the conditional hibernate. Cells: `04daa03`. Wells: `ff51dd7` (Pi3) + `7fa429c` (/seal).
- [x] **Substrate cleanup** Wells shipped W.78 (resurrect-queue fast-skip for orphan registry entries: 32min→320ms on bounce), static-IP allocator race fix, and 409 well_not_hibernate_ready error code. Wells: `eb47da3`, `46d7e5e`.
- [x] **Doc rewrite** `docs/cells-pool-builder-primitives.md` describes the post-Pi3 surface (create → exec → seal → hibernate). Wells: `b9040c6`.
- [x] **Postmortem cleanups (cells side)** Birth-exits-after-alive (was 360s hang → 120ms), `waitForCloudInit` non-transient early-bail (saves 5min on shim breakage), empty-pool fast-fail with actionable error, `cells doctor` adds `well --help` shim probe. Cells: `3ef483c`.
- [x] **Splites→wells path sweep** Cleared stale string refs in docs/scripts; fixed `/Users/pete/.local/bin/well` shim hardcoded to deleted splites path. Cells: `2fb253f`. Retrospective lesson saved to memory: gitignored shim trap.

Verified end-to-end: reconcile (12 pool members, 0 drift post-4th-bounce), V1.5 (sleep 589ms / wake 380ms / sibling-survive clean), V1.10 (69ms alive_ms on /seal-baked member).

See `docs/proposals/piece-2-audit-cells-side.html` for the full retro.

---

### Birth rework — multi-harness, generic pool, eval loop

`cells birth` was supposed to produce a configured, live cell across a matrix of options (harness, model, thinking, extensions, packages, channels) — but the variations silently didn't apply (DNA `settings.json` was hardcoded, every sed a no-op), birth had two divergent paths, and only one harness existed. This rework collapses birth to one reliable path, makes the generic egg a real placeholder template, and adds a second harness. Plan: `docs/proposals/birth-plan.html`.

**Phase 1 — Pi birth rework** (✅ shipped + verified)
- [x] **BR.1.1** DNA `settings.json` → placeholder template (`__PROVIDER__`/`__MODEL__`/`__THINKING__`/`__MODEL_CHAIN__`) — the root-cause fix; variations now actually apply. `channels.ts` lib extracted; ritual doc + `cell-create.md` rewritten to the blob model.
- [x] **BR.1.2** `cmdCreate` collapsed to one linear path (resolve config → build blob → claim generic egg → hand to mother → talk UX). Deleted `cmdCreateV1Fast`, `runBirthPickerV1`, `hatchEgg`, `applyHatchSubstitutions`, `wirePostBirth`, and the `picker` field; removed host-bridge's `picker`/`set_model` birth re-apply.
- [x] **BR.1.3** Kill dropped its mother round-trip — `cmdDestroyOne` is now deterministic (`well destroy --force` + local sweep + journal line). ~9s vs a multi-minute mother session that could hang.
- [x] **BR.1.4** Retired the old egg-baker skills (`birth-egg/SKILL.md`, `egg-birth.md`). Pool re-baked with the corrected DNA. Verified: birth → talk (via host-bridge local bridge) → kill all green on a freshly-baked egg.

**Phase 2 — Eval loop** (✅ shipped)
- [x] **BR.2.1** `scripts/eval-birth.ts` + `scripts/harden-birth.ts` reworked: `COMBOS` gains a `harness` field, baseline + held-constant axes default to `gpt-5.5` at `low` (the ChatGPT-subscription path — flat cost; deepseek/anthropic/gpt-5.5-pro bill per-token and stay as occasional model-axis rows). `verifyChainOnWell` extended to catch surviving placeholders + default*/chain drift.
- [x] **BR.2.2** Eval scripts moved off the dead `api.sprites.dev` endpoint (404 — legacy cloud backend) to the local `well` CLI, which authenticates itself. Before the fix harden marked every birth FAIL and eval's kill-verify passed unconditionally.
- [x] **BR.2.3** Smoke combo (`pi · gpt-5.5 · low`) verified 3/3 green end-to-end (birth → checkpoint → settings → alive → talk → kill). Axis sweep run to substantiate that thinking/extension/channel/cross variations apply.

**Phase 3 — claude-code harness** (✅ shipped + verified)
- [x] **BR.3.1** `.claude/` egg DNA — `CLAUDE.md` identity entrypoint (carries `__NAME__`), `.claude/settings.json` (`model` + `effortLevel` placeholders + `ANTHROPIC_BASE_URL` env). `claude` confirmed present in the wells base image.
- [x] **BR.3.2** Birthing ritual gains the claude-code branch (`c1`–`c7`): a short ritual that skips extensions/packages/channels. `harness` field picks pi (steps 1–9) vs claude-code (c1–c7).
- [x] **BR.3.3** host-bridge `HarnessAdapter` — `piAdapter` is a faithful lift of the existing path; `claudeCodeAdapter` spawns `claude --print` in stream-json mode and translates its event stream into the pi-shaped events the talk CLI renders.
- [x] **BR.3.4** Flipped `claude-code` live in `HARNESS_OPTIONS`, removed the `cmdCreate` birth guard, added the `cc-opus` eval row. **Birth verified** — `ccprobe` came up alive.
- [x] **BR.3.5** **claude-code talk — fixed.** Root cause was two host-bridge bugs, not anything in-cell. (1) `CellSession.start` wrapped the remote command in `bash -lc`, but ssh re-joins argv with spaces and the remote shell re-parses — so `bash -lc <remoteCmd>` collapsed to a bare no-op `exec` and claude never launched (pi survived by luck: a `;` in its remoteCmd split the statement so the `exec` half ran directly). (2) `claudeCodeAdapter.translateOutbound` emitted `{type:"message_update",event:…}` where the talk CLI reads `assistantMessageEvent` — so response text was silently dropped. Both fixed; `cells talk` (one-shot + interactive + multi-turn) verified against live cell `claudia`.
- [x] **BR.3.6** `cells tui` made harness-aware — a claude-code cell drops into claude's own TUI (bare `claude` in tmux); pi cells unchanged. Also fixed a latent bug: `cmdTui` passed the cell name to `well exec`, which needs the well name. (`cmdShell` still has this same cell-name-vs-well-name bug — separate fix.)

---

### Codex harness — a third harness (subscription-only)

The OpenAI `codex` CLI as a harness, on Pete's ChatGPT subscription (not the metered API) — the OpenAI counterpart to claude-code. `cli/proxy.ts` needed zero changes (its `/codex` route + OAuth refresh already existed for pi's gpt-5.5). Plan: `docs/proposals/codex-harness.html`.

- [x] **CDX.0** Spike — confirmed both gates: the codex CLI routes through `proxy.cells.md/codex` via a custom `config.toml` `model_provider` (no `auth.json` on cells, no patch needed); `codex exec --json` is one-shot, multi-turn via `codex exec resume <thread_id>`.
- [x] **CDX.1** Egg — `codex` baked into `provisionCellInWell` (pinned `@openai/codex@0.130.0`; not in the wells base image, so cells bakes it). New `dna/cells/base/.codex/config.toml` (proxy provider + `__MODEL__`/`__THINKING__` placeholders). `AGENTS.md` made the shared pi+codex entrypoint (now carries `__NAME__`). Pool re-baked.
- [x] **CDX.2** host-bridge `codexAdapter` — `HarnessAdapter` gained a `mode` discriminator; codex is `per-turn` (each prompt spawns a fresh `codex exec`, `CellSession.runTurn` drives it, `thread_id` captured + replayed via `resume`). `translateOutbound` maps codex JSONL → pi-shaped events.
- [x] **CDX.3** CLI + ritual — `codex` enabled in `HARNESS_OPTIONS`, `cmdCreate` default model + subscription-only model guard, `cmdTui` codex branch, birthing-ritual codex branch (`x1`–`x7`).
- [x] **CDX.4** Eval + docs + verify — codex `COMBOS` rows; `/cells` skill, STATUS/BOARD, `codex-harness.html`. **Verified end-to-end** — `cody` born, `cells talk` (one-shot + interactive + multi-turn/resume) + `cells tui` all green; pi + claude-code regression green.

---

### Phase v2 — Personality + identity layers (next)

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

- [ ] **C.1** Legacy-cell compat for `cells tui`/`shell`/`dream`/`refresh-extensions` — wrapped in `sudo -u cell`, works for /cell cells but breaks for pre-migration cells (`smoke-8`, `smoke-6`). Pete's plan is kill-and-rebirth, no in-place migration. Stays as known gap until legacy cells are killed.

### Wells follow-ups (surface to team)

- [ ] **W.28** **needs-wells**: `ServiceDefinition` schema (wells/lib/schemas.ts) doesn't expose a `user` field; `composeUnit` hardcodes `User=ubuntu`. Cells works around in `register-site-service.sh` via `sudo -u cell bash -c '...'`. A native `user: "cell"` field would obviate the wrap. Surfaced 2026-05-10. Low priority — workaround is stable.

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
