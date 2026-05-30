# cells — command + architecture reference

The exhaustive surface. For workflows and gotchas, see `SKILL.md` next to this file.

## `cells` subcommands

| Command | What it does |
|---|---|
| `cells birth <name> [flags]` | Provision a new cell (alias: `create`). Claims a generic egg, configures it via mother's birthing ritual. No flags → interactive picker; any flag → non-interactive. |
| `cells talk <name> [msg]` | Interactive bridge chat (no msg) or one-shot (with msg). Routes through host-bridge → SSH → harness. `talk mother` opens mother's Pi TUI and passes pi flags through (`-c`, `-r`, `--session=`, `-p`, …). |
| `cells kill <name>... [--yes]` | Destroy cells (alias: `destroy`). Deterministic — `well destroy --force` + local sweep. `--all-but <name>...` kills everything except the listed cells. Always pass `--yes` in scripts. |
| `cells list` | List known cells (name, model, birthday). |
| `cells sleep <name>` | Hibernate — releases VM RAM, wakes on inbound traffic. ~0.6s. |
| `cells stop <name>` | Cold-stop — explicit reset/recovery. Use `sleep` for normal pause. |
| `cells wake <name>` | Wake a hibernated or stopped cell. |
| `cells checkpoint <name>` | Snapshot a cell's filesystem. |
| `cells tui <name>` | Drop into a well-side tmux shell (debug, file poking). |
| `cells shell <name>` | Bare bash shell on a cell (separate tmux from the agent; Ctrl+D exits). |
| `cells see <name>` | Open `https://<name>.cells.md` in the browser. |
| `cells sync [name]` | Pull cell markdown into `~/Obsidian/cells/` (default: all + mother). |
| `cells dream <name\|mother\|--all>` | Run dream/memory consolidation. |
| `cells doctor` | Inspect mother OAuth state + proxy health (run when cells act 401-y). |
| `cells pool <subcmd>` | Manage the egg pool — see below (alias `egg` is deprecated). |
| `cells bake [--name=cell-base] [--force]` | Bake the base image (one-time, ~5min). |
| `cells channel <args>` | Channel binding ops (alias: `channels`). See below. |
| `cells refresh-extensions <args>` | Re-sync a cell's extensions from the DNA. |
| `cells heartbeat <args>` | Heartbeat ops — pulse digest, schedule, recent fires. |
| `cells pi` | Open the mother Pi TUI (alias for `cells talk mother`). |
| `cells schedule-* / unschedule-*` | Install/remove launchd jobs: `pi-patches`, `host-bridge`, `pulse`, `pool-reconcile`. `schedule-pool-refill` is retired — it now refuses; `unschedule-pool-refill` stays, to remove a stale plist. |

## `cells birth` flags

| Flag | Values | Notes |
|---|---|---|
| `--harness=` | `pi`, `claude-code`, `codex`, `hermes` | `pi` = full agent; `claude-code` = Anthropic-model coding machine (Max sub); `codex` = OpenAI-model coding machine (ChatGPT sub); `hermes` = Nous hermes-agent coding machine (ChatGPT sub, device-flow login — proxy can't front it). Default `pi`. |
| `--model=` | `gpt-5.5`, `gpt-5.5-pro`, `deepseek-v4-flash`, `deepseek-v4-pro`, `opus`, `sonnet`, `haiku` | `claude-code` requires an Anthropic model (opus/sonnet/haiku). `codex` and `hermes` require `gpt-5.5` (the ChatGPT-subscription model — not the metered API). `pi` + Anthropic model needs `ANTHROPIC_API_KEY` in secrets. |
| `--thinking=` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive` | `adaptive` is opus-only. `gpt-5.5-pro` rejects sub-medium. Anthropic models disable thinking below `high`. |
| `--extensions=` | subset of `memory`, `mentality`, `wiki`, `dream` | `pi` only. Comma-separated. Empty = none. |
| `--packages=` | subset of `pi-web-access`, … | `pi` only. |
| `--channels=` | subset of `slack`, `email` | `pi` only. `slack` auto-creates `#cells-<name>`, binds, deploys the worker. |
| `--seed=<text>` | text, or `off` | First message auto-sent post-birth. Default greeting on; `--seed=off` disables (use this in scripts). |
| `--no-pool` | — | Deprecated no-op (back-compat for scripts). |

## `cells pool` subcommands

| Command | What it does |
|---|---|
| `cells pool list` | Show pool members + states. |
| `cells pool refill` | Bake fresh generic eggs up to the target depth (`V1_POOL_TARGET_DEPTH = 5`). |
| `cells pool drain [-y]` | Destroy all `open` (unclaimed) members. `-y` to confirm. |
| `cells pool create` | Bake one generic egg. Args are ignored — the V1 pool is uniform (all eggs are `variant_signature: v1-generic`). `cells pool` no-args is an alias. |
| `cells pool cull <id>` | Destroy one pool member by short id. |
| `cells pool reconcile` | Diff `pool.json` vs welld; evict stale entries (welld-unknown, or tier-4 reporting non-running) **and cull** `open` members above target depth, oldest first. Never touches `claimed`/`live`. |

Pool member fields are orthogonal — two axes, never conflated (the old `warm`/`hot`/`cold` trio collided three temperature words across both axes; retired):
- **`state`** (standing) — `open` (built, claimable) → `claimed` (in-flight birth) → `live` (now a cell, kept as a breadcrumb) → `culling` (being destroyed). `pool.json`'s old `state:"warm"` is migrated to `open` on read.
- **`tier`** (power) — `4` (running VM, in RAM, instant claim) or `2` (hibernated VM, ~0.5s wake on claim). V1 ships pure-hibernated: every `open` member is tier 2. `V1_RUNNING_POOL_TARGET = 0`.

Pool RAM cost: ~0 (every asleep egg released its host VZ XPC process). vCPU cost: ~0. Disk cost: ~1.5 GB per asleep egg (RAM image + base disk).

## `cells channel` subcommands

| Command | What it does |
|---|---|
| `cells channel link <cell> <channel-id> [--kind=slack]` | Bind a Slack channel to a cell (mirrors to Cloudflare KV for the Slack Worker). |
| `cells channel unlink <cell> [<channel-id>]` | Remove one or all bindings for a cell. |
| `cells channel list` | List all channel↔cell bindings. |
| `cells channel sync` | Re-mirror `channels.json` to Cloudflare KV. |

## Architecture map

```
cells talk <name>
  → host-bridge :7880          (ws://127.0.0.1:7880/agent?cell=<name>, Bearer CELLS_PROXY_SECRET)
      → resolveCellTarget: cells.json hatched_from → pool.json well_name → welld for IP
      → ssh ubuntu@<ip> → sudo to root (HOME=/root) → HarnessAdapter spawns the harness
          piAdapter         → pi --mode rpc        (JSON-RPC over stdio, persistent)
          claudeCodeAdapter → claude --print       (stream-json over stdio, persistent)
          codexAdapter      → codex exec --json    (per-turn — one process per prompt,
                                                    resumed by thread id)
          hermesAdapter     → hermes TUI-gateway   (JSON-RPC 2.0 over stdio, persistent;
                                                    addressed by a gateway session id)
      → translates harness events ↔ the talk CLI's pi-shaped event protocol

cells birth <name>
  → cmdCreate: resolve config → JSON blob → reconcilePool → claimGenericEgg
      → wakePoolMember (~0.55s for tier-2) → ensureWellHasIp → stripAnthropicKey (if claude-code/codex)
      → runPiWithOutcome("cell-create", [name, eggWell, blob])
          → mother (pi -p, cwd dna/specials/mother) reads docs/birthing-ritual.html, follows it
  → on success: markPoolMemberLive, registry push, prewarmHostBridge, refillPoolToDepth, talk UX

<name>.cells.md (the cell's public page)
  → cells DNS → per-cell Worker (Bearer-gated control plane + open public site route)
      → /inbox/append, /site/publish, /image/upload, /debug — control plane (Bearer)
      → GET <anything else> → Durable Object serveSite → stored snapshot (served even when cell asleep)

publish-image <file> (on the cell)
  → POST https://<name>.cells.md/image/upload (Bearer CELLS_PROXY_SECRET)
      → Worker relays to Cloudflare Images → returns delivery URL

LLM routing (all roads go through proxy.cells.md or a direct key)
  → pi cells:          deepseek/gpt-5.5-pro via direct API key; gpt-5.5 via proxy.cells.md (codex/ChatGPT sub);
                       opus/sonnet/haiku via direct ANTHROPIC_API_KEY (paid).
  → claude-code cells: opus/sonnet/haiku via proxy.cells.md → Anthropic Max subscription.
  → codex cells:       gpt-5.5 via proxy.cells.md/codex → OpenAI ChatGPT subscription.
  → hermes cells:      gpt-5.5 direct to chatgpt.com — hermes hardwires its codex
                       provider to OAuth, so the proxy can't front it; the cell logs
                       in to ChatGPT via device flow at birth instead.
```

### Daemons (launchd)

| Service | Port / surface | Role |
|---|---|---|
| `md.cells.welld` | `:7878` | Substrate primitives — well create/destroy/exec/checkpoint/hibernate. Wells team's domain. |
| `com.pete.cells-host-bridge` | `:7880` | Spawns the harness over SSH on `cells talk`; one session per cell, 30 min idle TTL. |
| `com.pete.cells-proxy` | `proxy.cells.md` (via cloudflared) | Subscription LLM proxy — swaps `CELLS_PROXY_SECRET` for the real Max / codex OAuth tokens. |
| `com.pete.cells-pool-reconcile` | — | Reconciles `pool.json` vs welld + culls excess every 5 min (available; not auto-installed). |
| `com.pete.cells-tunnel` | `*.cells.md` (cloudflared) | Public DNS for `proxy.cells.md` and the per-cell Workers. |
| `com.pete.cells-dashboard` | `:7881` | Pool + cells observability. Optional. |

Restart any of them after editing its `.ts`: `launchctl kickstart -k gui/$(id -u)/<service>`.

## On-disk state

| Path | Contents |
|---|---|
| `~/.cells/cells.json` | The cell registry — `{name, status, harness, hatched_from, modelChain, created_at, …}`. |
| `~/.cells/pool.json` | Pool members — `{id, well_name, variant_signature, state, tier, born_at, claimed_at, claimed_by, max_age_at}`. Lock: `~/.cells/.pool.lock`. |
| `~/.cells/channels.json` | Channel bindings (slack/email → cell). |
| `~/.cells/secrets.json` | `CELLS_PROXY_SECRET`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, Slack tokens. **Never commit; never paste raw.** |
| `~/.cells/config.json` | `{well_public_base: "cells.md", …}`. |
| `~/.cells/logs/` | `harden/runs/*.json` (eval run records), `birth-timings/<name>.log`, `perf/birth.jsonl`. |
| `~/.wells/token` | welld API bearer (auto-generated; the `well` CLI and `cells` both read it). |
| `~/.wells/vms/<well>/ssh_key` | per-well SSH key host-bridge uses. |

## Repo layout

| Path | Contents |
|---|---|
| `cli/cells.ts` | The CLI — `cmdCreate` (birth), `cmdDestroyOne` (kill), `cmdPool`, `cmdTalk`, `streamCellBridge`, `runPiWithOutcome`, pool internals (`bakePoolMember`, `claimGenericEgg`, `wakePoolMember`, `refillPoolToDepth`, `reconcilePool`). |
| `cli/host-bridge.ts` | The talk daemon — `CellSession`, `HarnessAdapter` (`piAdapter` / `claudeCodeAdapter` / `codexAdapter` / `hermesAdapter`), `resolveCellTarget`. |
| `cli/proxy.ts` | The subscription proxy — harness-agnostic. Handles Anthropic Max + ChatGPT-codex OAuth refresh. |
| `cli/worker/cell/` | Per-cell Cloudflare Worker (Bearer control plane + public site route) + Durable Object (`handleSitePublish`, `serveSite`, channel inbox). |
| `cli/lib/channels.ts` | Slack/email channel binding logic. |
| `cli/lib/reconcile.ts` | Pool eviction planner — pure logic, no IO; testable kernel of `reconcilePool`. |
| `dna/cells/base/` | The generic egg DNA — `AGENTS.md`/`CLAUDE.md` (harness entrypoints), `SOUL.md`/`CELLS.md`/`TOOLS.md` (identity), `.pi/` + `.claude/` + `.codex/` config (placeholder templates), `site/`, `scripts/`, `bin/publish-image`. |
| `dna/specials/mother/` | Mother — `.pi/prompts/cell-create.md` + `cell-destroy.md`, `.pi/skills/birth/`, `state/memory/`. |
| `docs/birthing-ritual.html` | The ritual mother follows — one branch per harness: claude-code `c1`–`c7`, codex `x1`–`x7`, hermes `h1`–`h7` (plus the pi branch). |
| `scripts/eval-birth.ts` | Targeted birth eval (one combo × N, asserts loudly). |
| `scripts/harden-birth.ts` | Matrix-sweep birth eval (writes a run record). |
| `scripts/bind-channel.sh`, `register-site-service.sh`, `deploy-cell-worker.sh` | Birth-ritual helper scripts. |

## DNA placeholders

The generic egg ships these tokens; the birthing ritual substitutes them per-cell:

| Placeholder | Becomes | Where |
|---|---|---|
| `__NAME__` | the cell name | `package.json`, `CLAUDE.md`, `AGENTS.md`, identity `.md` files, `.tmux.conf` |
| `__MODEL__` | the model id | `.pi/settings.json`, `.claude/settings.json`, `.codex/config.toml` |
| `__PROVIDER__` | pi-ai provider id | `.pi/settings.json` (pi only) |
| `__THINKING__` | thinking / effort level | `.pi/settings.json`, `.claude/settings.json`, `.codex/config.toml` |
| `__MODEL_CHAIN__` | the fallback chain (JSON array) | `.pi/settings.json` (pi only) — quoted token, sed swaps the quotes too |

A surviving `__…__` token on a born cell means a birth-time sed was a no-op — the failure mode the eval loop's `settings.json` check is built to catch.

## Wells admission control (cells side)

Wells's boot-admission gate (delivered welld 1.0.0, 2026-05-15) paces `create`/`start`/`wake` so a boot burst can't oversubscribe the host CPU.

- **Knob**: `WELL_MAX_CONCURRENT_BOOTS` (default 3) — boots in flight cap. Auto-collapses to 1 when committed vCPU exceeds `WELL_BOOT_VCPU_RATIO × host_cores` (default ratio 2).
- **Observability**: `curl -s http://127.0.0.1:7878/healthz | jq .boot_gate` → `{inFlight, waiting, limit}`. `waiting > 0` is expected under load — boots queue and self-pace. Not a fault.
- **Cells doesn't pace its own bakes** — fires them at the gate and lets wells pace. After making the pool pure-hibernated, the gate auto-relaxed (less CPU pressure).

## Comms with the wells team

The wells team runs in `~/Projects/wells` and has their own Claude Code session. Coordinate via `/comms wells`:

- Bounces: they give ~2-min heads-up before `launchctl kickstart`-ing welld. Ack if no birth in flight, or ask them to hold.
- Substrate bugs: file the symptom + your last call's request/response, let them diagnose. Don't shim around their bugs in cells code.
- The boundary is fixed (see SKILL.md). When in doubt about ownership, the wells skill (`~/.claude/skills/wells/SKILL.md`) is the authoritative read.
