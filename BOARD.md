# Cells — Board

Tasks have IDs `P{phase}.{n}`. Owner: `worker`, `steward`, or `pete`.

For test wells, use prefixes: `ck-` (checklist), `wk-` (worker experiments), `nt-` (night experiments). Never touch `mother`, `smoke-*` (Pete's manual smoke wells), or any cell with status `alive` and a real channel binding.

Anthropic models (opus / sonnet / haiku) are out-of-bounds for the matrix until the Claude Code harness ships — they trip Pete's Claude Max OAuth fingerprint detection.

---

## In Progress

(none)

## Blocked

_(empty)_

## Todo (priority order)

### Phase 1 — Birth checklist passes (acceptance gate)

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

### Phase 1b — Full CLI smoke (every subcommand exercised on a real cell)

This phase walks the entire `cells` CLI surface against an alive cell. Phase 1 confirms birth produces a working cell across the flag matrix; Phase 1b confirms every other verb behaves. Use a dedicated test cell `ck-cli` (gpt-5.5, default flags) for this. Each task asserts both "command exits 0" and "the side effect actually happened", not just the exit code.

- [ ] **P1b.1** Birth `ck-cli --model=gpt-5.5`. Confirm alive + talk smoke. Owner: `worker`. (This cell is the test subject for P1b.2 onwards.)
- [ ] **P1b.2** `cells doctor` — exit 0, output mentions mother OAuth + proxy health, no red flags. Owner: `worker`.
- [ ] **P1b.3** `cells list` — `ck-cli` listed with right model + age. Format readable. Owner: `worker`.
- [ ] **P1b.4** `cells sleep ck-cli` → `cells list` shows `hibernating`. Then `cells talk ck-cli "still here?"` wakes it within 60s and replies. Confirms wake-on-talk works. Owner: `worker`.
- [ ] **P1b.5** `cells stop ck-cli` → `cells list` shows `stopped`. Then `cells wake ck-cli` returns to `alive`. Confirms cold-stop + explicit wake. Owner: `worker`.
- [ ] **P1b.6** `cells checkpoint ck-cli` succeeds. List checkpoints (CLI surface or via welld API), confirm new entry. Owner: `worker`.
- [ ] **P1b.7** `cells see ck-cli` — manually verify (or confirm exit 0) that browser opens `https://ck-cli.cells.md`. Owner: `worker`. May need `needs-pete-session: browser` if visual confirmation is required.
- [ ] **P1b.7a** Cell public website works. `curl -i https://ck-cli.cells.md/` returns 200 with the cell's site content (the Bun web server at `~/agent/site/server.ts` rendered through welld vhost + cloudflared). Confirm static HTTP routes are public (no bearer required), HTML response, sane title or content matching the cell. The `/agent` WS upgrade path stays bearer-gated. Owner: `worker`. Depends: P1b.1.
- [ ] **P1b.7b** Mother public website works. Same checks against `https://mother.cells.md/`. Confirms mother's site server is up and reachable end-to-end (CF cert + cloudflared tunnel + welld vhost dispatch + mother's :8080 site server). If mother is offline, this also surfaces a real bug (mother should always be reachable). Owner: `worker`.
- [ ] **P1b.8** `cells tui ck-cli` — drops into the cell's tmux session. Inside, verify:
  - Status bar shows the cell-name color chip on the left (per the per-cell tmux color from birth step 3b).
  - Right side of status bar reads from `~/agent/.pi/status.json` (harness, channels).
  - `mft` (markdown file tree viewer) launches without errors and renders `~/agent/AGENTS.md` etc. cleanly.
  - Tmux key bindings work (split panes, switch windows).
  - Detach cleanly and confirm tmux session persists for the next attach.
  Owner: `worker`. May need `needs-pete-session: tui-eyeball` for the visual checks.
- [ ] **P1b.9** `cells shell ck-cli` — drops into bash on the cell (separate tmux from the agent). Run a quick command (`uname -a`, `which pi`). Ctrl+D exits cleanly back to the Mac terminal. Owner: `worker`.
- [ ] **P1b.10** `cells sync` and `cells sync ck-cli` — pulls cell markdown into `~/Obsidian/cells/ck-cli/`. Confirm SOUL.md / IDENTITY.md / CELLS.md present, not empty, identity substituted. Owner: `worker`.
- [ ] **P1b.11** `cells dream ck-cli` — runs dream consolidation, exits cleanly. Then `cells dream --all` exits cleanly. Owner: `worker`.
- [ ] **P1b.12** `cells refresh-extensions ck-cli heartbeat-watch --restart` — extension push lands, pi restarts and loads it (verify via `cells talk` — extension visible in the agent's self-introspection). Then `cells refresh-extensions ck-cli heartbeat-watch --remove --restart` removes it cleanly. Owner: `worker`.
- [ ] **P1b.13** `cells heartbeat` — pulse digest renders. `cells heartbeat ck-cli` — single cell schedule renders. `cells heartbeat --tail` — recent fires render. Owner: `worker`.
- [ ] **P1b.14** Channel commands: `cells channel list` — empty or current bindings render. `cells channel link ck-cli <slack-channel-id> --kind=slack` (use a throwaway test channel — record what you bind to). `cells channel list` shows the binding. `cells channel sync` — re-mirrors to KV without errors. `cells channel unlink ck-cli` — binding gone. Owner: `worker`. Depends on a test Slack channel — note it in JOURNAL.
- [ ] **P1b.15** `cells schedule-pulse` installs the launchd plist. Verify with `launchctl list | grep pulse`. `cells unschedule-pulse` removes it. Owner: `worker`.
- [ ] **P1b.16** `cells schedule-pi-patches` installs the watcher launchd plist. `launchctl list | grep pi-patches` confirms. `cells unschedule-pi-patches` removes. Owner: `worker`.
- [ ] **P1b.17** `cells pi` — opens the mother Pi TUI. Confirm tmux session shows mother's identity (color chip, status bar harness, can issue a prompt and get a reply). Detach cleanly. Owner: `worker`. May need `needs-pete-session: tui-eyeball`.
- [ ] **P1b.18** `cells kill ck-cli --yes` — clean teardown. `cells list` no longer shows `ck-cli`. Wells, registry, vault, CF Worker all swept (verify each). Owner: `worker`.
- [ ] **P1b.19** `cells kill --all-but mother smoke-6 --yes` smoke (against a tiny set of throwaway cells P1b.18 created — birth `ck-killtest-1`, `ck-killtest-2` first). Confirms multi-kill + --all-but flag work. Owner: `worker`.
- [ ] **P1b.20** Sign-off: append CLI-smoke pass line to `state/memory/project_cells_activity.md` matching the matrix sign-off format. Owner: `worker`.

### Phase 2 — Auto-seed first message

- [x] **P2.1** Added `--seed=<text>` flag + `DEFAULT_SEED` constant + `--seed=off` to disable. Help text updated. Validated parser rejects unknown flag values; `--seed=off` short-circuits cleanly. Untested end-to-end (substrate-blocked).
- [x] **P2.2** Wired seed through cmdCreate's TTY branch: post-birth, when seed is enabled, calls `streamCellBridge(name, { interactive: true, initialMessage: seedText })` directly instead of `cmdTalk(name, [])`. The seed sends, the response streams back, then the readline loop opens normally. `--seed=off` falls through to the original blank-prompt behavior.
- [ ] **P2.3** Slack-bound cells: confirm seed greeting also lands in `#cells-<name>` (mirror behavior matches a manual prompt). Owner: `worker`. Depends: P2.2.
- [ ] **P2.4** Measure p50 birth-to-greeting on the current substrate (no eggs). Record in `docs/perf/birth-to-greeting.md` with one row per matrix combo. Owner: `worker`. Depends: P2.2.

### Phase 3 — Eggs (pre-warmed, agent-managed pool)

- [x] **P3.1** Wrote `docs/eggs-spec.md` consolidating eggs.md + eggs-phase-1.md + project_eggs_v2_architecture memory. Key shift: wells now ships its own substrate-level pool, so eggs become Layer 2 on top of wells's Layer 1. Hatch flow, variant signature, refill agent, capability-deferred install, and consolidated phase plan (3a/3b/3c/4) all in the new doc. Closed 2026-05-09 night.
- [x] **P3.2** Wrote `docs/eggs-variants.md`. Initial pool: gpt-5.5 vanilla ×3, gpt-5.5+memory ×2, deepseek-v4-pro vanilla ×1 (6 warm total). Anthropic excluded until Claude Code harness. Capability-deferred install scoring formula specified for off-menu requests. Re-tune triggers documented.
- [x] **P3.3** Added `cells egg refill` (reads `~/.cells/eggs-config.json`, defaults to the docs/eggs-variants.md table, bakes serially up to configured depth) and `cells egg drain` (cull all warm eggs; -y to skip confirmation). `cells egg list` and `cells egg cull <id>` already existed. Drain tested: "no warm eggs to drain". Refill untested end-to-end (substrate-blocked) but its work-list logic is correct and prints before baking.
- [x] **P3.4** Added `cells schedule-egg-refill` and `cells unschedule-egg-refill`. Plist runs `cells egg refill` every 10 minutes (10-min cadence balances freshness with bake-overlap risk). Mother concurrency=1 serializes naturally with manual births. Logs to `~/.cells/logs/egg-refill.{log,err}`. Untested end-to-end (substrate-blocked) but plist generation and dispatch are correct.
- [x] **P3.5** Auto-hatch is already implemented in cmdCreate (cli/cells.ts:~1417): pool-key match against eggs.json with state=warm, calls hatchEgg → drops into talk. Seed greeting wired across both slow-birth and hatch paths (commit 3d5efda). Untested end-to-end pending substrate.
- [x] **P3.6** `--no-pool` flag for forcing slow-birth — landed. CLI parses `--no-pool` (no-arg), `CreateOpts.noPool: boolean`, gates the entire auto-hatch block in cmdCreate (skips loadEggs IO too). Help text updated. `bun build` clean (149.0 KB). Untested live (P1.3 substrate-blocked) but the gate is purely additive — when noPool is false, the existing slow-birth + hatch paths are unchanged. (worker, 2026-05-10 03:08 MT, night/2026-05-09)
- [ ] **P3.7** Measure p50 birth-to-greeting with eggs on. Confirm 4× drop vs Phase 2 baseline. Update `docs/perf/birth-to-greeting.md`. Owner: `worker`. Depends: P3.5.

### Phase 4 — Capability-deferred install

- [x] **P4.1** Wrote `docs/in-flight-install.md`. Schema for `/cell/.pi/in-flight.json` (state-machine: pending/installing/failed/done; absence = fully provisioned). Built-in `in-flight-watch` extension injects a system-message addendum per turn so the agent self-narrates. Worker write protocol uses flock LOCK_EX for R/M/W cycles, LOCK_SH for agent reads. Failure modes (worker crash → 5min supervisor timeout, pi restart, corrupt file → degrade silent) covered. P4.2 implements the worker on top.
- [ ] **P4.2** Implement post-hatch background install — when a hatched egg is missing requested extensions/packages, install them after the seed-greeting starts. Talk session stays live. Owner: `worker`. Depends: P3.5, P4.1.
- [ ] **P4.3** Failure mode: surface install failures as graceful agent replies, not silent broken cells. Owner: `worker`. Depends: P4.2.
- [ ] **P4.4** Measure p50 birth-to-greeting with capability-deferred install for off-menu configs. Update perf doc. Owner: `worker`. Depends: P4.2.

### Phase 5 — Cloud talk path (lower priority)

- [ ] **P5.1** Apply wells team's diagnostic — run `curl -i -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" -H "Sec-WebSocket-Version: 13" https://<name>.cells.md/agent` against an alive cell and see whether the per-cell CF Worker returns 101 or anything else. Document in JOURNAL. Owner: `worker`. Depends: P1 done (need an alive cell).
- [ ] **P5.2** If P5.1 shows the Worker mangling the upgrade: fix the per-cell Worker to either preserve `Upgrade`/`Connection` headers when forwarding via `fetch()`, switch to `WebSocketPair()` for in-Worker proxying, or have cloudflared route `/agent` directly to welld and skip the Worker for WS. Owner: `worker`. Depends: P5.1.
- [ ] **P5.3** Verify cloud path end-to-end: from a non-Mac (e.g. iPhone Mac browser), `wss://<name>.cells.md/agent` opens, a prompt round-trips, close clean. Owner: `worker`. Depends: P5.2. May be `needs-pete-session: browser` for the actual round-trip test.

### Cells follow-ups (worker-discovered)

- [ ] **C.1** Legacy-cell compat for `cells tui`/`shell`/`dream`/`refresh-extensions` — iter 18 wrapped these in `sudo -u cell`, which 100% works on /cell cells but breaks on pre-migration cells (`smoke-8`, `smoke-6`) since the `cell` user doesn't exist there. Two options: (a) probe layout via `well_exec test -d /cell` and dispatch user accordingly (one extra round-trip per call); (b) wait for the legacy cells to be killed and rebirthed (Pete's plan: kill-and-rebirth, no in-place migration). Since Pete's plan is (b), this stays as a known gap. If Pete wants to debug legacy cells in the meantime, the workaround is `well exec -s <name> -- <cmd>` directly, bypassing the `cells` CLI. Owner: `worker`. Surfaced 2026-05-10 04:30 MT.

### Wells follow-ups (surface to team)


- [ ] **W.28** **needs-wells**: `ServiceDefinition` schema (splites/lib/schemas.ts) doesn't expose a `user` field, and `composeUnit` (splites/lib/services.ts:53) hardcodes `User=ubuntu` in the systemd unit. Cells's site service writes to `/cell` (cell:cell 0755) — ubuntu can read but not write; pi extensions write memory/wiki to /cell/state/* which fails as ubuntu. Cells works around tonight in `register-site-service.sh` by wrapping the service body in `sudo -u cell bash -c '...'` (relies on ubuntu's NOPASSWD sudo from cloud-init default), but a `user: "cell"` field on `ServiceDefinition` would let cells request that systemd run the unit as cell directly. Surfaced 2026-05-10 03:35 MT.

## Blocked

_(empty)_

## Done

- [x] **P1.3** Birth + verify `ck-pi-gpt55` on `wells-stable-2026-05-10h`. All 8 birth steps stamped; §4 verification green (alive, all steps in birth-timings, /etc/environment has CELLS_PROXY_SECRET, no __NAME__ placeholders, harness=pi, no __CELL_BG__, site service 200, talk smoke replies "ok"). CF Worker remote talk path still fails (separate P5.1 work). Side-effect fixes shipped on the way: cells's bake recipe installs pi+bun (was assumed in wells base, dropped from -10g rebake) + chmod /home/well 0755 (default 0750 blocks cell user traverse). (worker, 2026-05-10 15:32 MT)
- [x] **W.29** Root cause (per direct cells↔wells Claude-Code chat 2026-05-10 ~14:35–15:03 MT): wells's rinse was `rm /etc/machine-id; touch /etc/machine-id`, leaving a 0-byte file. systemd's `sshd-keygen.service` has `ConditionFirstBoot=yes` which fires precisely when `/etc/machine-id` is empty — so every fork triggered early-boot RSA keygen on cold entropy, hanging sshd. Ubuntu-base forks happened not to hit it because their machine-id was populated. Wells's `wells-stable-2026-05-10g` rinse stops zeroing machine-id and stops deleting `/etc/ssh/ssh_host_*`; well-firstboot regens both per-fork after network-online with haveged-provided entropy. Bake + smoke verified 2026-05-10 15:03 MT — cell-base + --env CELLS_PROXY_SECRET works end-to-end. Earlier "entropy fix in -10f" was a partial fix on the right hypothesis — final fix is in -10g. (closed 2026-05-10 15:03 MT)
- [x] **W.27** Wells shipped well-firstboot etc-environment.append handler (`splites/templates/well-firstboot.sh:67-76`). Verified on ubuntu-25.10-base + --env: /etc/environment carries the wells-env block. (verified 2026-05-10 10:35 MT)

- [x] **W.23** Wells shipped pool zombie auto-prune + `pool drain --all` in `wells-stable-2026-05-10d` (splites `0a3f8e0`). Re-bake on -10d worked first try, no `registry.json` workaround needed. (worker confirmed 2026-05-10 02:30 MT, closed by steward 2026-05-10 02:57 MT)
- [x] **W.24** Wells shipped welld plist template fix (PATH adds `/usr/sbin`). Local plist still has the manual workaround appended; will be normalized when welld next reinstalls/upgrades. (closed by steward 2026-05-10 02:57 MT)
- [x] **W.25** Wells shipped per-entry tolerance in `GET /v1/wells/images` (splites `aee9793`). cmdBake's `--force` delete branch fires correctly on conflict — no `well image rm cell-base` ritual needed. (worker confirmed 2026-05-10 02:30 MT, closed by steward 2026-05-10 02:57 MT)
- [x] **P2.5** Birth progress chip — `runPiWithOutcome` takes `{ progressName }`, tails `~/.cells/logs/birth-timings/<name>.log` on a 250ms poll, renders `· birthing <name> — step <N>: <label>…` on stderr with `\r` overwrite, clears on pi exit. Wired through `cmdCreate`'s slow-birth path. TTY-gated (script callers see clean output). `bun build` clean. Untested live (P1.3 substrate-blocked). (worker, 2026-05-10 02:48 MT, night/2026-05-09)
- [x] **P1.2a** Migrated cells DNA + harness state to `/cell/` with user `cell`. Bake green: `cells bake --force` produces 6059 MB cell-base; auto-verify-fork passes; manual §2 fork-verify confirms user `cell` (uid 1002, sudo), /cell tree (full DNA + .pi + bin + node_modules + site + scripts + .tmux.conf), /etc/profile.d/cells-env.sh wired (proxy env shim + PATH adds /cell/bin), /cell/bin/cells (cell:cell 755), pi patches landed (URL→proxy.cells.md ×23, codex extractAccountId stub, THINKING_LEVELS adaptive, model fallback chain). Two pi patches non-applicable upstream (anthropic-adaptive shape changed, footer.js path moved) — not blocking, file under cells follow-up. (worker, 2026-05-10 02:14 MT, night/2026-05-09)
- [x] **P1.2** Bake §2 acceptance gate. Passes via P1.2a verify above. (worker, 2026-05-10 02:14 MT, night/2026-05-09)
- [x] **P1.1** Pre-flight passed all 7 checks. Mother answered "ok ok ok". Substrate `wells-stable-2026-05-10a`, degraded=false, respawns_5min=0, cell-base image present. (worker, 2026-05-09 23:00 MT, night/2026-05-09)
