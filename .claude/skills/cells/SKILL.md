---
name: cells
description: Operate the cells fleet — always-on AI agents, each in its own VM, addressable by name. The `cells` CLI births / talks to / kills / hibernates cells, manages the egg pool, and drives the birth eval loop. Use this skill whenever spinning up an agent ("birth a cell to ..."), talking to a named cell, killing or sleeping one, working with the egg pool, debugging birth/talk/kill flows, touching `~/.cells/`, or hitting `<name>.cells.md`. Cells run on top of the **wells** VM substrate — there's a `wells` skill for the layer below; do not confuse the two (see the boundary section).
---

# cells — operate the agent fleet

A **cell** is an always-on AI agent that lives on its own VM (a "well"), addressable by name. You talk to it with `cells talk <name>`; you give it a public page at `<name>.cells.md`; you let it sleep when idle and wake it on inbound traffic. The fleet is the user-facing product — the `cells` CLI is how you drive it.

This skill is the **judgment layer** — when to birth a cell, which harness to pick, the gotchas that `cells --help` won't tell you. The exhaustive command + architecture reference lives in `reference.md` next to this file. The repo lives at `~/Projects/cells`.

## Mental model

| Concept | What it is |
|---|---|
| **cell** | The user-facing agent. Has a name, a harness, a model, a public page. Persists across hibernation. |
| **well** | The Linux VM the cell runs in (substrate-owned by the wells team). Cell name ≠ well name — a pool-born cell keeps its `egg-<hex>` well name internally. |
| **harness** | The agent runtime inside the cell. `pi` = full agent with packages/extensions/channels. `claude-code` = Anthropic-model coding machine on the Max subscription. `codex` = OpenAI-model coding machine on the ChatGPT subscription. Coding-machine harnesses skip the cells-side capability stack. |
| **egg** | A pre-baked generic VM in the pool. Birth *claims* an egg and *configures* it — birth never installs anything. |
| **pool** | The warm reservoir of eggs at `~/.cells/pool.json`. V1 ships pure-asleep (every egg hibernated, ~0 RAM/CPU); refill is automatic on consume. Depth target 10. |
| **mother** | An LLM (pi) that runs the birthing ritual (`docs/birthing-ritual.html`) for each new cell. In the birth path, not the kill path. |
| **proxy.cells.md** | The subscription LLM proxy on the Mac — swaps `CELLS_PROXY_SECRET` for the real Anthropic Max / ChatGPT-codex OAuth tokens. Lets every cell talk to LLMs without holding any real credential. |

## The wells/cells boundary — read this first

**Wells owns substrate primitives. Cells owns the pool and the agent.** This split is load-bearing — getting it wrong reintroduces deleted architecture.

- **Wells owns**: `create`, `start`, `stop`, `hibernate`, `wake`, `seal`, `destroy`, `exec`, `checkpoint`, image management. The raw VM lifecycle. Has its own `wells` skill.
- **Cells owns**: the warm egg pool (`~/.cells/pool.json`), the bake flow, refill, reconciliation, the birth ritual, the harnesses, `cells talk`, the per-cell Worker, the cell's public site.
- **Pool state is gone from wells.** `~/.wells/pool/` doesn't exist; pool modules were deleted in the V1 boundary cleanup. Don't reintroduce them on either side.
- **VM creates / boots are paced by wells's admission gate** (`WELL_MAX_CONCURRENT_BOOTS`, default 3 → collapses to 1 under vCPU pressure). You don't hand-pace a birth burst — fire the calls, they self-pace. A parked boot just waits.

When working on cells code, substrate / welld / lume issues are wells's domain — `/comms wells` is the comms channel. Don't reimplement their fixes.

## Core workflows

### Birth a cell
```
cells birth <name>                                          # interactive 6-question picker
cells birth <name> --harness=pi --model=gpt-5.5 --thinking=low
cells birth <name> --harness=claude-code --model=opus --thinking=high
cells birth <name> --harness=codex --model=gpt-5.5 --thinking=low
```
Birth = claim an egg from the pool → build a JSON config blob → mother runs the birthing ritual on it → drop into talk. **~90–140s** end-to-end (cold-consume = ~95s, the 0.55s wake is invisible against the ritual time). On failure the egg is swept (a fresh egg beats a half-born one). Use `--seed=off` for scripted births to skip the post-birth greeting message.

### Talk to a cell
```
cells talk <name>            # interactive bridge chat
cells talk <name> "message"  # one-shot
```
Routes through host-bridge → SSH into the cell's well → spawns the harness. `connected via local bridge` in the output = the host-bridge path (good). `cells talk mother` opens mother's TUI; pi flags (`-c`, `-r`, `--session=`, `-p ...`) pass through.

### Kill a cell
```
cells kill <name>... [--yes]
cells kill --all-but <name>... [--yes]
```
Deterministic (~9s) — resolve well locally → `well destroy --force` → sweep registry / pulse / channels / Worker / vault / pool → journal the line. No mother. **Always pass `--yes` (or `-y`) in scripted contexts** — the prompt is interactive and will hang in non-TTY.

### Lifecycle
- `cells sleep <name>` — hibernate, releases VM RAM, wakes on inbound. ~0.6s.
- `cells wake <name>` — explicit wake (also auto-wakes on `cells talk`).
- `cells stop <name>` — cold-stop (no RAM image saved). Use `sleep` for normal pause; `stop` for reset/recovery.
- `cells checkpoint <name>` — filesystem snapshot.

### Web presence — `<name>.cells.md`

Every cell has a public page at `https://<name>.cells.md`, served by a per-cell Cloudflare Worker + Durable Object — **even when the cell is asleep**. The cell publishes by writing to `site/public/` inside its well; a watch in the cell's site server pushes the snapshot to the Worker on change. Snapshot cap: ~96 KB per file (the DO storage limit) — for anything larger, use `publish-image`.

```
# On the cell — generate an image, get a public URL
publish-image diagram.png
# → https://imagedelivery.net/<hash>/<id>/public
```

`publish-image` is on every cell's PATH; it routes through the Worker's `/image/upload` to Cloudflare Images. The cell never holds a real Cloudflare credential.

User-side: `cells see <name>` opens the page in the browser.

### The egg pool
```
cells pool list | refill | drain [-y] | reconcile
cells pool                      # alias for `cells pool create` — bakes ONE generic egg
cells pool cull <id>            # destroy one member by short id
```

The V1 pool is **pure-asleep** (`V1_HOT_POOL_TARGET = 0`, 2026-05-15): every member is a tier-2 hibernated VM, ~0 RAM, ~0 CPU. Disk-only. Refill is automatic on consume (fire-and-forget after every birth) + scheduled every 10 min via launchd.

After changing the DNA under `dna/cells/base/`, run `cells pool drain -y && cells pool refill` so warm eggs carry the new shape — existing eggs are frozen at bake time.

### The birth eval loop
```
bun scripts/eval-birth.ts --combo=<id> --repeat=N --talk-verify
bun scripts/harden-birth.ts --combos=N
```
Combos live in each script's `COMBOS` list. Baseline `smoke` = `pi · gpt-5.5 · low` (the ChatGPT-subscription path — flat cost). Each iteration: birth → `born-<name>` checkpoint → `settings.json` verify (no surviving `__…__`, default* agrees with `modelChain[0]`) → alive → talk-verify → kill. Use this when changing the DNA, the birthing ritual, or any harness wiring.

### Debug
- `cells doctor` — mother OAuth + proxy health (run when cells act 401-y)
- `well doctor` — substrate health, VM count vs. ceiling, orphan processes
- `curl -s http://127.0.0.1:7880/healthz | jq` — host-bridge
- `curl -s https://proxy.cells.md/_proxy/health | jq` — proxy (Max + codex token state)
- `cells tui <name>` — well-side tmux shell; `cells shell <name>` — bare bash on the cell
- `curl -s http://127.0.0.1:7878/healthz | jq .boot_gate` — wells admission gate (waiting > 0 = paced, not broken)

## Gotchas — the judgment layer

1. **Daemons run stale code.** host-bridge / proxy / welld are launchd services loaded once. After editing their `.ts`, **restart**: `launchctl kickstart -k gui/$(id -u)/com.pete.cells-<svc>` (`cells-host-bridge`, `cells-proxy`; welld is `md.cells.welld`). A daemon from days ago silently runs old logic — this has bitten multiple times.
2. **Cell name ≠ well name.** `well info -s <cell-name>` returns 404 — the well is `egg-<hex>`. Resolve cell → well via `~/.cells/cells.json` (`hatched_from` short id) → `~/.cells/pool.json` (`well_name`).
3. **`cells` on PATH** is a symlink → `cli/cells.ts`, so it runs current source; no rebuild step. `bun cli/cells.ts <cmd>` is equivalent.
4. **Mother is serial.** Multiple `cells birth` or anything that goes through mother (`cell-create`) running in parallel will time out around ~175s. Serialize anything that touches the mother. (Pure CLI ops — `cells pool create`, `cells kill`, `cells talk` — are parallel-safe; mother isn't in those paths.)
5. **Test/eval births use `gpt-5.5` at `low`** via the codex provider — the ChatGPT-subscription path (flat cost). `deepseek` / Anthropic-via-API-key / `gpt-5.5-pro` all bill per-token; keep them as occasional axis-sweep rows, not defaults.
6. **Use `--seed=off` in scripts.** Default birth flow sends a greeting and waits for the cell's first response. In scripted contexts that prompt-and-wait hangs invisibly. Same with `cells kill` — always pass `--yes`/`-y`.
7. **`cells birth` is a destructive consume.** It claims an egg permanently; if you want to test the cold-consume path without losing pool capacity, pool refill will bake a replacement automatically (it triggers after every birth) — just budget the ~30 s replacement bake.
8. **Smoke-test a `.ts` change**: `bun build <file> --target=bun`. `cli/cells.ts` needs `--external react-devtools-core --external ink` (an `ink` optional dep won't resolve otherwise — that error is not your code).
9. **Welld bounces happen.** The wells team announces them via `/comms wells`. Acknowledge before they bounce (or hold if you have a birth in flight); a bounce mid-birth = HTTP 500 and a burned bake. The handshake is **~2-minute heads-up, then ack**.
10. **Wells substrate is the wells team's domain.** lume errors, welld degraded, VM creates timing out, DHCP / network issues — message them via `/comms wells`. Don't shim around their bugs in cells code.

## Read into the repo

- `reference.md` (next to this file) — exhaustive CLI surface, on-disk state, repo layout, DNA placeholders, daemon ports.
- `STATUS.md`, `BOARD.md`, `PLAN.md` — running state of the project (where we are now, what's open).
- `docs/birthing-ritual.html` — the ritual mother follows. Reading this is the fastest way to understand what a birth actually *does*.
- `docs/proposals/cells-pool-asleep.html` — why the pool is pure-asleep (2026-05-15).
- `docs/proposals/cell-web-presence.html` — how `<name>.cells.md` and `publish-image` work.
- `docs/proposals/claude-code-harness.html`, `codex-harness.html` — the two coding-machine harnesses.
- `cli/cells.ts` (the CLI), `cli/host-bridge.ts` (talk daemon), `cli/proxy.ts` (subscription proxy).
- `dna/cells/base/` — the generic egg DNA; what every cell ships with.
