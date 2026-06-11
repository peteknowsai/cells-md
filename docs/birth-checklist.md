# Birth checklist

A one-shot acceptance pass for `cells birth` across the dimensions a user can pick. Run top-to-bottom; each section gates the next. If a step fails, stop and fix before continuing — partial passes are noise.

This is the **manual** acceptance pass. The **automated** path is the eval loop:

- `bun scripts/eval-birth.ts --combo=<id> --repeat=N --talk-verify` — targeted: one combo, N times, with assertions (birth exits 0, `born-<name>` checkpoint landed, `settings.json` on the well has no surviving `__…__` placeholder and its `default*` fields agree with `modelChain[0]`, registry flips alive, talk round-trips, kill leaves nothing behind).
- `bun scripts/harden-birth.ts --combos=N` — matrix sweep: picks N combos, births them, verifies, kills, writes a JSON run record.

When the eval loop is green across two consecutive sweeps **and** this manual checklist passes, birth is shippable for the matrix it covers.

## 0. Setup once

- `cd ~/Projects/cells` is your cwd for everything below
- `WELL_TOKEN=$(cat ~/.wells/token)` exported (some checks need it directly)
- `SECRET=$(jq -r '.CELLS_PROXY_SECRET' ~/.cells/secrets.json)` exported

## 1. Pre-flight — substrate health

These check welld + lume + the egg pool are alive and the operator's machine is in a fit state to birth anything at all.

- [ ] `curl -s http://127.0.0.1:7878/healthz | jq` → `ok: true`, `degraded: false`
- [ ] `well doctor` exits 0 and is not VM-saturated (`VMs:` count well under the host ceiling)
- [ ] host-bridge healthy: `curl -s http://127.0.0.1:7880/healthz | jq` → `ok: true`
- [ ] `~/.cells/secrets.json` has at minimum `CELLS_PROXY_SECRET`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (Slack tokens too if you'll exercise the slack row; `ANTHROPIC_API_KEY` if you'll birth a `pi` cell on an Anthropic model)
- [ ] `~/.wells/token` exists (welld API bearer; auto-generated on welld first-start)
- [ ] `cat ~/.cells/config.json` shows `well_public_base: "cells.md"`
- [ ] Cloudflared tunnel running: `pgrep -f cloudflared`
- [ ] Mother cell talkable: `bun cli/cells.ts talk mother "say ok" -p` returns within 30s

If any of these fail, fix substrate before touching birth.

## 2. Pool verification — a warm egg has what birth assumes

Birth claims a generic egg from the pool and never installs anything — so the egg must already ship the toolchain, both harnesses, the DNA with placeholders intact, and the env shim. Verify a freshly-baked warm egg before betting on it.

- [ ] `bun cli/cells.ts pool refill` brings the pool to depth; `jq '[.members[]|select(.state!="live")]|length' ~/.cells/pool.json` ≥ 1
- [ ] Pick a warm egg's `well_name` and resolve its IP with `well info -s <egg> --json`
- [ ] `well exec -s <egg> -- bash -c 'grep -c CELLS_PROXY_SECRET /etc/environment'` ≥ 1
- [ ] `well exec -s <egg> -- bash -c 'test -f /etc/profile.d/cells-env.sh && echo OK'` prints `OK`
- [ ] `well exec -s <egg> -- bash -c 'which pi && which claude'` shows both harnesses present
- [ ] `well exec -s <egg> -- bash -c 'ls /root/'` shows the DNA root (AGENTS.md, CLAUDE.md, SOUL.md, IDENTITY.md, .pi/, .claude/, site/, scripts/, package.json, bin/)
- [ ] `well exec -s <egg> -- bash -c 'grep -l "__[A-Z_]*__" /root/.pi/settings.json /root/.claude/settings.json /root/package.json'` — placeholders **intact** on a warm egg (birth substitutes them)
- [ ] `well exec -s <egg> -- bash -c 'grep -c CELL_NAME /etc/environment'` returns `0` — no baked identity (the egg is generic)

If any fail, the bake is incomplete — `cells pool drain -y && cells pool refill` and re-verify.

## 3. Birth matrix — by harness × model × thinking

The automated sweep (`scripts/eval-birth.ts` / `scripts/harden-birth.ts`, see the `COMBOS` list) is the source of truth for the matrix. For a manual pass, exercise at least one row per axis:

| Cell name        | Flags                                                          | Tests                                          |
|------------------|----------------------------------------------------------------|------------------------------------------------|
| ck-smoke         | `--harness=pi --model=gpt-5.5 --thinking=low`                  | Baseline — the free subscription path          |
| ck-deepseek      | `--harness=pi --model=deepseek-v4-flash --thinking=low`        | Direct-API-key model path                      |
| ck-think-high    | `--harness=pi --model=gpt-5.5 --thinking=high`                 | Thinking level honored in `.pi/settings.json`  |
| ck-ext-memory    | `--harness=pi --model=gpt-5.5 --extensions=memory`             | Extension switched on, others left on disk     |
| ck-slack         | `--harness=pi --model=gpt-5.5 --channels=slack`                | Auto-creates `#cells-ck-slack`, binds, mirrors |
| ck-cc-opus       | `--harness=claude-code --model=opus --thinking=high`           | claude-code harness — Anthropic model via Max  |
| ck-tui           | (no flags — interactive picker walks defaults)                 | Sanity check the picker UX                     |

For each row, run §4 immediately after birth before moving on.

The Claude Max subscription is **claude-code-harness-only** (Pete, 2026-06-11): `cells birth --harness pi --model opus` is rejected at parse time, and the proxy 403s any non-claude-code cell on the Anthropic route (`anthropicRouteVerdict` in `cli/lib/proxy-oauth.ts`). pi and hermes ride the ChatGPT subscription (gpt-5.5 via the `/codex` proxy route). A useful negative row: `cells birth ck-pi-opus --harness=pi --model=opus` must fail with the policy message before touching the pool.

## 4. Per-birth verification

Run for each cell birthed in §3. The cell's well is the egg's `well_name` (resolve via `hatched_from` → `pool.json`), not the cell name.

- [ ] `cells list | grep <name>` shows status `alive`
- [ ] `well checkpoint list -s <egg-well>` includes a `born-<name>` checkpoint (ritual step 7 / c5)
- [ ] No surviving placeholders: `well exec -s <egg-well> -- bash -c 'grep -rl "__[A-Z_]*__" /root/*.md /root/.pi/settings.json /root/.claude/settings.json /root/package.json'` returns nothing
- [ ] For a `pi` cell: `well exec -s <egg-well> -- bash -c 'cat /root/.pi/settings.json'` — `defaultProvider`/`defaultModel`/`defaultThinkingLevel` agree with `modelChain[0]`
- [ ] For a `claude-code` cell: `well exec -s <egg-well> -- bash -c 'cat /root/.claude/settings.json'` — `model` + `effortLevel` substituted, `env.ANTHROPIC_BASE_URL` present
- [ ] `well exec -s <egg-well> -- bash -c 'cat /root/.pi/status.json | jq -r .harness'` matches the requested harness
- [ ] Site service: `well exec -s <egg-well> -- bash -c 'curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/'` returns `200`
- [ ] **Talk smoke**: `bun cli/cells.ts talk <name> "reply with just the word ok"` shows `<name>> ok` (connects via the local bridge)
- [ ] If `--channels=slack`: Slack channel `#cells-<name>` exists and the binding shows in `cells channel list`
- [ ] If `--extensions=...`: `well exec -s <egg-well> -- bash -c 'jq .extensions /root/.pi/settings.json'` lists exactly the requested extensions plus the always-on baseline

## 5. Lifecycle

After §3–§4 are green, exercise the rest of the lifecycle on one cell (`ck-smoke`):

- [ ] `cells sleep ck-smoke` → `cells list` shows `hibernating`
- [ ] `cells talk ck-smoke "still here?"` wakes the cell and replies within 60s
- [ ] `cells stop ck-smoke` → `cells list` shows `stopped`
- [ ] `cells wake ck-smoke` → returns to `alive`
- [ ] `cells checkpoint ck-smoke` succeeds

## 6. Cleanup

`cells kill ck-smoke ck-deepseek ck-think-high ck-ext-memory ck-slack ck-cc-opus ck-tui --yes`

Verify clean (kill is deterministic — `well destroy --force` + local sweep):

- [ ] `cells list` empty of `ck-*` cells
- [ ] `well list` empty of `ck-*` / their `egg-*` wells
- [ ] `pool.json` has no `live` members pointing at the killed cells
- [ ] `~/Obsidian/cells/ck-*/` directories absent
- [ ] No CF Workers named `cells-front-ck-*`

## 7. Sign-off

When §1–§6 pass clean in a single run, birth is shippable for the matrix it covers. Tag the run in `state/memory/project_cells_activity.md`:

```
<UTC date HH:MM>  birth-checklist-pass  <commit-sha>  matrix=<rows exercised>
```

If any row failed, the failure mode + which row goes in the same line — incomplete passes are signal worth keeping.

## What this doesn't cover (yet)

- Off-Mac talk path (`wss://<name>.cells.md/agent`) via the per-cell CF Worker — exercise when it comes up
- `harness=codex` — still stubbed, not wired
- `cells dream`, `cells refresh-extensions` — exercise as needed but not gating
