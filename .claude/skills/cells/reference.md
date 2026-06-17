# cells — command + architecture reference

The exhaustive surface. For workflows and gotchas, see `SKILL.md` next to this file.

## `cells` subcommands

| Command | What it does |
|---|---|
| `cells birth [<project>] <name> [flags]` | Provision a new cell (alias: `create`). Cold-forks a fresh well (`cells-<name>`) from the `cell-base` image, configures it via mother's birthing ritual. `cells birth <project> <name>` attributes it to the project's mother (`<project>-mother`) if registered, else the global mother. No flags → interactive picker; any flag → non-interactive. |
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
| `cells bake [--name=cell-base] [--force] [--no-verify]` | (Re)build the `cell-base` image births cold-fork from (one-time / on DNA-toolchain change, ~few min). See below. |
| `cells channel <args>` | Channel binding ops (alias: `channels`). See below. |
| `cells refresh-extensions <args>` | Re-sync a cell's extensions from the DNA. |
| `cells heartbeat <args>` | Heartbeat ops — pulse digest, schedule, recent fires. |
| `cells pi` | Open the mother Pi TUI (alias for `cells talk mother`). |
| `cells schedule-* / unschedule-*` | Install/remove launchd jobs: `pi-patches`, `host-bridge`, `pulse`. (The old `pool-refill`/`pool-reconcile` jobs are gone with the pool — `schedule-pool-refill` refuses; `unschedule-pool-refill` stays only to remove a stale plist if one lingers.) |

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
| `--no-pool` | — | Deprecated no-op (the pool is gone; flag kept for back-compat so old scripts don't error). |

## The `cell-base` image (`cells bake`)

There is **no egg pool** (removed 2026-06-17 — cold-boot substrate; joint design in the wells repo's `docs/proposals/cold-boot-substrate.html`). Every birth cold-forks a fresh well (`cells-<name>`) from a single pre-baked image, `cell-base` — an APFS clonefile (sub-ms), then configured by the ritual. Birth never installs anything.

| Command | What it does |
|---|---|
| `cells bake` | (Re)build `cell-base`: create a temp well from the lean `ubuntu-25.10-base` → `provisionCellInWell` (DNA + all 4 harnesses + node-gyp + pi patches) → save as the `cell-base` image → fork-verify. The ONLY step that runs the heavy install. |
| `cells bake --force` | Overwrite an existing `cell-base`. |
| `cells bake --no-verify` | Skip the post-save fork test (faster, riskier). |

Re-bake after editing `dna/cells/base/` or bumping a harness / node-gyp / toolchain pin — new births fork the image as-is. Live cells drift separately; the steward refreshes them with `cells refresh`.

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
      → resolveCellTarget: cells.json `well` (cells-<name>, via lib/resolve.ts) → welld for IP
      → ssh ubuntu@<ip> → sudo to root (HOME=/root) → HarnessAdapter spawns the harness
          piAdapter         → pi --mode rpc        (JSON-RPC over stdio, persistent)
          claudeCodeAdapter → claude --print       (stream-json over stdio, persistent)
          codexAdapter      → codex exec --json    (per-turn — one process per prompt,
                                                    resumed by thread id)
          hermesAdapter     → hermes TUI-gateway   (JSON-RPC 2.0 over stdio, persistent;
                                                    addressed by a gateway session id)
      → translates harness events ↔ the talk CLI's pi-shaped event protocol

cells birth [<project>] <name>
  → cmdCreate: resolve config → JSON blob → claimAndReady (cold-fork cell-base → cells-<name> well)
      → ensureWellHasIp → ensureHibernateReady (seal once) → stripAnthropicKey (if claude-code/codex)
      → walk the global mother's modelChain [claude-code, pi]:
          claude-code → runClaudeWithOutcome("birth",       [name, well, blob])  (.claude/skills/birth → imprint-cell.sh)
          pi (fallback)→ runPiWithOutcome("cell-create",     [name, well, blob])  (.pi/prompts/cell-create.md → birthing-ritual.html)
          (mother runs locally, cwd dna/specials/mother; the well is pre-created and handed in — no pool claim)
  → on success: registry push (well: cells-<name>), prewarmHostBridge, talk UX

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
| `com.pete.cells-tunnel` | `*.cells.md` (cloudflared) | Public DNS for `proxy.cells.md` and the per-cell Workers. |

Restart any of them after editing its `.ts`: `launchctl kickstart -k gui/$(id -u)/<service>`.

## On-disk state

| Path | Contents |
|---|---|
| `~/.cells/cells.json` | The cell registry — `{name, status, harness, well, project, modelChain, created_at, …}`. `well` is the cell→well mapping (`cells-<name>`; legacy cells backfilled with their `egg-<hex>`). `hatched_from` may persist on old records as a legacy marker — not used for resolution. |
| `~/.cells/channels.json` | Channel bindings (slack/email → cell). |
| `~/.cells/secrets.json` | `CELLS_PROXY_SECRET`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, Slack tokens. **Never commit; never paste raw.** |
| `~/.cells/config.json` | `{well_public_base: "cells.md", …}`. |
| `~/.cells/logs/` | `harden/runs/*.json` (eval run records), `birth-timings/<name>.log`, `perf/birth.jsonl`. |
| `~/.wells/token` | welld API bearer (auto-generated; the `well` CLI and `cells` both read it). |
| `~/.wells/vms/<well>/ssh_key` | per-well SSH key host-bridge uses. |

## Repo layout

| Path | Contents |
|---|---|
| `cli/cells.ts` | The CLI — `cmdCreate` (birth), `cmdDestroyOne` (kill), `cmdBake`, `cmdTalk`, `streamCellBridge`, `runClaudeWithOutcome` / `runPiWithOutcome` (the mother-harness chain), `claimAndReady` (cold-fork the well), `provisionCellInWell` (the bake recipe). |
| `cli/host-bridge.ts` | The talk daemon — `CellSession`, `HarnessAdapter` (`piAdapter` / `claudeCodeAdapter` / `codexAdapter` / `hermesAdapter`), `resolveCellTarget`. |
| `cli/proxy.ts` | The subscription proxy — harness-agnostic. Handles Anthropic Max + ChatGPT-codex OAuth refresh. |
| `cli/worker/cell/` | Per-cell Cloudflare Worker (Bearer control plane + public site route) + Durable Object (`handleSitePublish`, `serveSite`, channel inbox). |
| `cli/lib/channels.ts` | Slack/email channel binding logic. |
| `cli/lib/resolve.ts` | Cell→well resolver (`wellNameForCell`): the stored `well`, else `cells-<name>`. The single source of truth for the mapping. |
| `dna/cells/base/` | The generic cell DNA baked into `cell-base` — `AGENTS.md`/`CLAUDE.md` (harness entrypoints), `SOUL.md`/`CELLS.md`/`TOOLS.md` (identity), `.pi/` + `.claude/` + `.codex/` config (placeholder templates), `site/`, `scripts/`, `bin/publish-image`. |
| `dna/specials/mother/` | Mother — `.pi/prompts/cell-create.md` + `cell-destroy.md`, `.pi/skills/birth/`, `state/memory/`. |
| `docs/birthing-ritual.html` | The ritual mother follows — one branch per harness: claude-code `c1`–`c7`, codex `x1`–`x7`, hermes `h1`–`h7` (plus the pi branch). |
| `scripts/eval-birth.ts` | Targeted birth eval (one combo × N, asserts loudly). |
| `scripts/harden-birth.ts` | Matrix-sweep birth eval (writes a run record). |
| `scripts/bind-channel.sh`, `register-site-service.sh`, `deploy-cell-worker.sh` | Birth-ritual helper scripts. |

## DNA placeholders

The `cell-base` image ships these tokens; the birthing ritual substitutes them per-cell:

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
- **Cells doesn't pace its own boots** — fires `create`/`wake` at the gate and lets wells pace. A birth burst self-paces; parked boots just wait.

## Comms with the wells team

The wells team runs in `~/Projects/wells` and has their own Claude Code session. Coordinate via `/comms wells`:

- Bounces: they give ~2-min heads-up before `launchctl kickstart`-ing welld. Ack if no birth in flight, or ask them to hold.
- Substrate bugs: file the symptom + your last call's request/response, let them diagnose. Don't shim around their bugs in cells code.
- The boundary is fixed (see SKILL.md). When in doubt about ownership, the wells skill (`~/.claude/skills/wells/SKILL.md`) is the authoritative read.
