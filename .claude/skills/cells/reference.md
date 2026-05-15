# cells — command + architecture reference

The exhaustive surface. For workflows and gotchas, see `SKILL.md` next to this file.

## `cells` subcommands

| Command | What it does |
|---|---|
| `cells birth <name> [flags]` | Provision a new cell (alias: `create`). Claims a generic egg, configures it via mother's birthing ritual. No flags → interactive picker; any flag → non-interactive. |
| `cells talk <name> [msg]` | Interactive bridge chat (no msg) or one-shot (with msg). Routes through host-bridge → SSH → harness. `talk mother` opens mother's Pi TUI and passes pi flags through. |
| `cells kill <name>... [--yes]` | Destroy cells (alias: `destroy`). Deterministic — `well destroy --force` + local sweep. `--all-but <name>...` kills everything except the listed cells. |
| `cells list` | List known cells (name, model, birthday). |
| `cells sleep <name>` | Hibernate — releases VM RAM, wakes on inbound traffic. |
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
| `cells channel <args>` | Channel binding ops (alias: `channels`). |
| `cells refresh-extensions <args>` | Re-sync a cell's extensions from the DNA. |
| `cells heartbeat <args>` | Heartbeat ops. |
| `cells pi` | Open the mother Pi TUI (alias for `cells talk mother`). |
| `cells schedule-* / unschedule-*` | Install/remove launchd jobs: `pi-patches`, `host-bridge`, `pulse`, `pool-refill`, `pool-reconcile`. |

## `cells birth` flags

| Flag | Values | Notes |
|---|---|---|
| `--harness=` | `pi`, `claude-code`, `codex` | `pi` = full agent; `claude-code` = Anthropic-model coding machine (Max sub); `codex` = OpenAI-model coding machine (ChatGPT sub). Default `pi`. |
| `--model=` | `gpt-5.5`, `gpt-5.5-pro`, `deepseek-v4-flash`, `deepseek-v4-pro`, `opus`, `sonnet`, `haiku` | `claude-code` requires an Anthropic model (opus/sonnet/haiku). `codex` requires `gpt-5.5` (the ChatGPT-subscription model — not the metered API). `pi` + Anthropic model needs `ANTHROPIC_API_KEY` in secrets. |
| `--thinking=` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive` | `adaptive` is opus-only. `gpt-5.5-pro` rejects sub-medium. Anthropic models disable thinking below `high`. |
| `--extensions=` | subset of `memory`, `mentality`, `wiki`, `dream` | `pi` only. Comma-separated. Empty = none. |
| `--packages=` | subset of `pi-web-access`, … | `pi` only. |
| `--channels=` | subset of `slack`, `email` | `pi` only. `slack` auto-creates `#cells-<name>`, binds, deploys the worker. |
| `--seed=<text>` | text, or `off` | First message auto-sent post-birth. Default greeting on; `--seed=off` disables. |
| `--no-pool` | — | Deprecated no-op (back-compat for scripts). |

## `cells pool` subcommands

| Command | What it does |
|---|---|
| `cells pool list` | Show pool members + states. |
| `cells pool refill` | Bake fresh generic eggs up to `V1_POOL_TARGET_DEPTH` (10). |
| `cells pool drain [-y]` | Destroy all warm (unclaimed) members. `-y` to confirm. |
| `cells pool create` | Bake one generic egg. (Args are ignored — the pool is uniform.) |
| `cells pool cull <id>` | Destroy one pool member by short id. |
| `cells pool reconcile` | Diff `pool.json` vs welld; evict stale entries. |

Pool member states: `warm`/`hot`/`cold` (claimable) → `live` (claimed by a cell) → `culling`. Birth claims one; `cmdCreate` fires a background refill after.

## Architecture map

```
cells talk <name>
  → host-bridge  :7880   (ws://127.0.0.1:7880/agent?cell=<name>, Bearer CELLS_PROXY_SECRET)
      → resolveCellTarget: cells.json hatched_from → pool.json well_name → welld for IP
      → ssh ubuntu@<ip> → sudo -u cell → HarnessAdapter spawns the harness
          piAdapter         → pi --mode rpc          (JSON-RPC over stdio, persistent)
          claudeCodeAdapter → claude --print          (stream-json over stdio, persistent)
          codexAdapter      → codex exec --json       (per-turn — one process per prompt,
                                                       resumed by thread id)
      → translates harness events ↔ the talk CLI's pi-shaped event protocol

cells birth <name>
  → cmdCreate: resolve config → JSON blob → claimGenericEgg → runPiWithOutcome("cell-create", …)
      → mother (pi -p, cwd dna/proto/mother) reads docs/birthing-ritual.html, follows it
  → on success: markPoolMemberLive, registry push, prewarmHostBridge, refill, talk UX

LLM routing
  → pi cells:          deepseek/gpt-5.5-pro via direct API key; gpt-5.5 via proxy.cells.md (codex/ChatGPT sub);
                       opus/sonnet/haiku via direct ANTHROPIC_API_KEY (paid)
  → claude-code cells: opus/sonnet/haiku via proxy.cells.md → Anthropic Max subscription
  → codex cells:       gpt-5.5 via proxy.cells.md/codex → OpenAI ChatGPT subscription
```

### Daemons (launchd)

| Service | Port | Role |
|---|---|---|
| `md.cells.welld` | `:7878` | Substrate primitives — well create/destroy/exec/checkpoint/hibernate. Wells team's domain. |
| `com.pete.cells-host-bridge` | `:7880` | Spawns the harness over SSH on `cells talk`; one session per cell, 30min idle TTL. |
| `com.pete.cells-proxy` | (`proxy.cells.md`) | Subscription LLM proxy — swaps `CELLS_PROXY_SECRET` for the real Max/codex OAuth token. |
| `com.pete.cells-pool-refill` | — | Refills the pool every 10 min. |
| `com.pete.cells-pool-reconcile` | — | Reconciles `pool.json` vs welld every 5 min (available; not auto-installed). |

Restart any of them after editing its `.ts`: `launchctl kickstart -k gui/$(id -u)/<service>`.

## On-disk state

| Path | Contents |
|---|---|
| `~/.cells/cells.json` | The cell registry — `{name, status, harness, hatched_from, modelChain, …}`. |
| `~/.cells/pool.json` | Pool members — `{id, well_name, state, tier, …}`. Lock: `~/.cells/.pool.lock`. |
| `~/.cells/channels.json` | Channel bindings (slack/email → cell). |
| `~/.cells/secrets.json` | `CELLS_PROXY_SECRET`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, Cloudflare + Slack tokens. |
| `~/.cells/config.json` | `{well_public_base: "cells.md", …}`. |
| `~/.cells/logs/` | `harden/runs/*.json` (eval run records), `birth-timings/<name>.log`, `perf/`. |
| `~/.wells/token` | welld API bearer (auto-generated; the `well` CLI reads it). |
| `~/.wells/vms/<well>/ssh_key` | per-well SSH key host-bridge uses. |

## Repo layout

| Path | Contents |
|---|---|
| `cli/cells.ts` | The CLI — `cmdCreate` (birth), `cmdDestroyOne` (kill), `cmdPool`, `cmdTalk`, `streamCellBridge`, `runPiWithOutcome`. |
| `cli/host-bridge.ts` | The talk daemon — `CellSession`, `HarnessAdapter` (`piAdapter` / `claudeCodeAdapter`), `resolveCellTarget`. |
| `cli/proxy.ts` | The subscription proxy — harness-agnostic. |
| `cli/lib/channels.ts` | Slack/email channel binding logic. |
| `dna/cells/base/` | The generic egg DNA — `AGENTS.md`/`CLAUDE.md` (harness entrypoints), `SOUL.md`/`CELLS.md`/etc. (shared identity), `.pi/` + `.claude/` config (placeholder templates), `site/`, `scripts/`. |
| `dna/proto/mother/` | Mother — `.pi/prompts/cell-create.md` + `cell-destroy.md`, `.pi/skills/birth/`, `state/memory/project_cells_activity.md`. |
| `docs/birthing-ritual.html` | The ritual mother follows — pi steps 1–9, claude-code branch `c1`–`c7`. |
| `scripts/eval-birth.ts` | Targeted birth eval (one combo × N, asserts). |
| `scripts/harden-birth.ts` | Matrix-sweep birth eval (writes a run record). |
| `scripts/bind-channel.sh`, `register-site-service.sh`, `deploy-cell-worker.sh` | Birth-ritual helper scripts. |

## DNA placeholders

The generic egg ships these tokens; the birthing ritual substitutes them per-cell:

| Placeholder | Becomes | Where |
|---|---|---|
| `__NAME__` | the cell name | `package.json`, `CLAUDE.md`, identity `.md` files, `.tmux.conf` |
| `__MODEL__` | the model id | `.pi/settings.json`, `.claude/settings.json` |
| `__PROVIDER__` | pi-ai provider id | `.pi/settings.json` (pi only) |
| `__THINKING__` | thinking / effort level | `.pi/settings.json`, `.claude/settings.json` |
| `__MODEL_CHAIN__` | the fallback chain (JSON array) | `.pi/settings.json` (pi only) — quoted token, sed swaps the quotes too |

A surviving `__…__` token on a born cell means a birth-time sed was a no-op — the failure mode the eval loop's `settings.json` check is built to catch.
