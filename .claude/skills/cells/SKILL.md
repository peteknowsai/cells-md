---
name: cells
description: Drive the cells substrate — birth/talk/kill agent cells, manage the egg pool, run the birth eval loop, debug welld/host-bridge/proxy. Invoke when working with the `cells` CLI, wells, eggs, the pool, harnesses, or birth/talk/kill flows.
---

# cells — using the substrate

`cells` is a fleet of always-on AI agents, each living in its own **well** (a hardware-isolated Linux VM on the Mac), addressable by name. The `cells` CLI is the operator interface. This file is how to drive it; **`reference.md`** next to it is the exhaustive command surface + architecture map.

## The shape of it

- A **cell** is the user-facing agent. It runs a **harness** inside its well: `pi` (the full agent — packages, extensions, channels), `claude-code` (the Anthropic-model coding machine — `claude` CLI on the Max subscription), or `codex` (the OpenAI-model coding machine — `codex` CLI on the ChatGPT subscription). Both coding-machine harnesses skip the cells-side capability stack.
- Birth claims a pre-baked generic **egg** from the **pool** and *configures* it — birth never installs anything. The egg's well is `egg-<hex>`; the cell's user-facing name is a separate alias.
- **Cell name ≠ well name.** Resolve cell → well via `~/.cells/cells.json` (`hatched_from` short id) → `~/.cells/pool.json` (member `well_name`).
- Daemons (all launchd): **welld** `:7878` (substrate primitives), **host-bridge** `:7880` (spawns the harness over SSH on `cells talk`), **proxy.cells.md** (subscription LLM proxy — Max + ChatGPT/codex).

## Core workflows

### Birth a cell
```
cells birth <name> --harness=pi --model=gpt-5.5 --thinking=low
cells birth <name> --harness=claude-code --model=opus --thinking=high
cells birth <name> --harness=codex --model=gpt-5.5 --thinking=low
```
No flags → interactive 6-question picker. Any flag → non-interactive (defaults fill the rest). Birth claims an egg → builds a JSON config blob → hands `[name, eggWell, blob]` to mother → mother follows the birthing ritual (`docs/birthing-ritual.html`) → drops into talk. ~90–140s. On failure the egg is swept (a fresh egg beats a half-born one).

### Talk to a cell
```
cells talk <name>            # interactive bridge chat
cells talk <name> "message"  # one-shot
```
Routes through host-bridge → SSH → the harness. `connected via local bridge` in the output = the host-bridge path (good). If it dials `wss://egg-….cells.md` instead, host-bridge didn't pick up — check it's running current code.

### Kill a cell
```
cells kill <name>... [--yes]
cells kill --all-but <name>... [--yes]
```
Deterministic (~9s) — resolve well locally → `well destroy --force` → sweep registry/pulse/channels/worker/vault/pool → journal the line. No mother in the teardown path.

### Lifecycle
`cells sleep <name>` (hibernate — releases VM RAM, wakes on inbound), `cells wake <name>`, `cells stop <name>` (cold stop), `cells checkpoint <name>` (filesystem snapshot).

### The egg pool
```
cells pool list | refill | drain [-y] | create | cull <id> | reconcile
```
`refill` bakes to depth (`V1_POOL_TARGET_DEPTH = 10`). After changing the DNA under `dna/cells/base/`, run `cells pool drain -y && cells pool refill` so warm eggs carry the new DNA — existing warm eggs are frozen at bake time.

### The birth eval loop
```
bun scripts/eval-birth.ts --combo=<id> --repeat=N --talk-verify   # targeted, asserts loudly
bun scripts/harden-birth.ts --combos=N                            # matrix sweep, writes a run record
```
Combos live in each script's `COMBOS` list. Baseline `smoke` = `pi · gpt-5.5 · low` (the ChatGPT-subscription path — flat cost). Each iteration: birth → `born-<name>` checkpoint → `settings.json` verify (no surviving `__…__`, default* agrees with `modelChain[0]`) → alive → talk-verify → kill.

### Debug
- `cells doctor` — mother OAuth + proxy health (run when cells act 401-y)
- `well doctor` — substrate health, VM count vs. ceiling, orphan processes
- `curl -s http://127.0.0.1:7880/healthz | jq` — host-bridge
- `curl -s https://proxy.cells.md/_proxy/health | jq` — proxy (Max + codex token state)
- `cells tui <name>` — well-side tmux shell; `cells shell <name>` — bare bash on the cell

## Gotchas (learned the hard way)

- **Daemons run stale code.** host-bridge / proxy / welld are launchd services loaded once. After editing their `.ts`, restart: `launchctl kickstart -k gui/$(id -u)/com.pete.cells-<svc>` (`cells-host-bridge`, `cells-proxy`; welld is `md.cells.welld`). A daemon from days ago silently runs old logic — this bit twice in one session (host-bridge couldn't resolve new cells; proxy `ZlibError` from a missing header-strip fix).
- **Cell name ≠ well name.** `well info -s <cell-name>` returns 404 — the well is `egg-<hex>`. Resolve via `hatched_from` → `pool.json`.
- **`cells` on PATH** is a symlink → `cli/cells.ts`, so it runs current source. `bun cli/cells.ts <cmd>` is equivalent.
- **Test/eval births use `gpt-5.5` at `low`** — the ChatGPT-subscription path (flat cost). deepseek / Anthropic-via-API-key / gpt-5.5-pro all bill per-token; keep them as occasional rows.
- **Mother is in the birth path, not kill.** Birth hands a blob to mother (an LLM runs the ritual). Kill and the pool are pure deterministic TS.
- **Smoke-test a `.ts` change**: `bun build <file> --target=bun`. `cli/cells.ts` needs `--external react-devtools-core --external ink` (an `ink` optional dep won't resolve otherwise — that error is not your code).
- **Wells substrate is the wells team's domain.** welld/lume issues go to them via `/comms wells`; don't reimplement their fixes.

## Full reference

`reference.md` (next to this file) has every `cells` subcommand with flags, the architecture map, the on-disk state files, and the DNA layout.
