# Birth checklist

A deterministic checklist for verifying that `cells birth` works across all the dimensions a user can pick. Run top-to-bottom; each section gates the next. If a step fails, stop and fix before continuing — partial passes are noise.

This is not the harden-birth loop (`/harden-birth`) — that runs continuously to catch flakes. This is a one-shot acceptance pass: when this whole doc passes clean, birth is shippable for the matrix it covers.

## 0. Setup once

- `cd ~/Projects/cells` is your cwd for everything below
- `WELL_TOKEN=$(cat ~/.wells/token)` exported (some checks need it directly)
- `SECRET=$(jq -r '.CELLS_PROXY_SECRET' ~/.cells/secrets.json)` exported

## 1. Pre-flight — substrate health

These check welld + lume + the cell-base image are alive and the operator's machine is in a fit state to birth anything at all.

- [ ] `curl -s http://127.0.0.1:7878/healthz | jq` → `ok: true`, `degraded: false`, `respawns_last_5min: 0`
- [ ] `well doctor` exits 0 (`RESULT: wells is HEALTHY`)
- [ ] `well image list` shows `cell-base` (any age, any size)
- [ ] `~/.cells/secrets.json` exists and has at minimum `CELLS_PROXY_SECRET`, `WELL_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- [ ] `cat ~/.cells/config.json` shows `well_public_base: "cells.md"`
- [ ] Cloudflared tunnel running: `pgrep -f cloudflared`
- [ ] Mother cell talkable: `bun cli/cells.ts talk mother "say ok" -p` returns within 30s

If any of these fail, fix substrate before touching birth.

## 2. Bake verification — cell-base actually has what birth assumes

Birth's prose says cell-base ships "bun, pi-coding-agent, terminal toolkit, the DNA at `~/agent` (with placeholders intact), `bun install` done, pi-ai patches applied, and `~/.bashrc.d/` env shims in place." That has historically lied. Verify before betting on it.

Fork a throwaway well from cell-base and inspect:

- [ ] `well create bake-verify --from-image cell-base --env CELLS_PROXY_SECRET=$SECRET` succeeds
- [ ] `well exec -s bake-verify -- bash -c 'cat /etc/environment | grep CELLS_PROXY_SECRET'` returns the secret (cloud-init re-runs on fork and lands env)
- [ ] `well exec -s bake-verify -- bash -c 'ls ~/.bashrc.d/ | sort'` shows at least `anthropic_proxy`, `bun`, `codex_proxy` (and ideally `site_proxy`)
- [ ] `well exec -s bake-verify -- bash -c 'ls ~/agent/'` shows the DNA root (AGENTS.md, SOUL.md, IDENTITY.md, .pi/, site/, scripts/, package.json, node_modules/)
- [ ] `well exec -s bake-verify -- bash -c 'ls ~/agent/node_modules/@mariozechner/' | wc -l` is non-zero (bun install was done in bake)
- [ ] `well exec -s bake-verify -- bash -c 'grep -c "" ~/agent/.pi/settings.json'` shows `__NAME__` / `__MODEL__` / `__PROVIDER__` placeholders intact
- [ ] `well exec -s bake-verify -- bash -lc 'cd ~/agent && for f in ~/.bashrc.d/*; do . "$f"; done; echo OPENAI_CODEX_API_KEY=${OPENAI_CODEX_API_KEY:0:14}'` — should print 14 chars (not empty)

Cleanup: `well destroy bake-verify --yes`

If any fail, the bake is incomplete — re-bake (`cells bake --force`) before continuing. Don't paper over with manual pushes.

## 3. Birth matrix — by harness × model × thinking

For each combination below, run `bun cli/cells.ts birth <name> [flags]` and let mother do the work. Each row's expected outcome is "Agent `<name>` is alive" and ≤ 6 minutes wall-clock.

| Cell name           | Flags                                                        | Tests                                              |
|---------------------|--------------------------------------------------------------|----------------------------------------------------|
| ck-pi-gpt55         | `--harness=pi --model=gpt-5.5`                               | Default-shape birth (fastest model that works)     |
| ck-pi-gpt55-pro     | `--harness=pi --model=gpt-5.5-pro`                           | gpt-5.5-pro path through codex-proxy               |
| ck-pi-deepseek-pro  | `--harness=pi --model=deepseek-v4-pro --thinking=high`       | Deepseek pro path                                  |
| ck-pi-deepseek-fl   | `--harness=pi --model=deepseek-v4-flash`                     | Deepseek flash path                                |
| ck-pi-think-low     | `--harness=pi --model=gpt-5.5 --thinking=low`                | Thinking level honored in `.pi/settings.json`      |
| ck-pi-think-adapt   | `--harness=pi --model=gpt-5.5 --thinking=adaptive`           | Adaptive (model decides); pi-coding-agent patches needed |
| ck-pi-ext-memory    | `--harness=pi --model=gpt-5.5 --extensions=memory`           | Extension installed, others pruned                 |
| ck-pi-ext-many      | `--harness=pi --model=gpt-5.5 --extensions=memory,wiki,dream`| Multi-extension                                    |
| ck-pi-pkg-web       | `--harness=pi --model=gpt-5.5 --packages=pi-web-access`      | Optional pi package install via `pi install`       |
| ck-pi-slack         | `--harness=pi --model=gpt-5.5 --channels=slack`              | Auto-creates `#cells-ck-pi-slack`, binds, mirrors  |
| ck-pi-tui           | (no flags — interactive TUI walks defaults)                  | Sanity check the picker UX                         |

For each row, run section §4 immediately after birth before moving on.

**Anthropic models (`opus`, `sonnet`, `haiku`) are deliberately omitted from this matrix.** The pi harness on a cell IP gets terminated by Anthropic's OAuth detection — Pete's Claude Max subscription is at ban risk if we exercise that path. Anthropic models will be re-enabled in a future phase only via the Claude Code harness (which sends genuinely Claude-Code bytes, not pi-emulated). Until then: don't birth Anthropic-routed cells.

## 4. Per-birth verification

Run for each cell birthed in §3, in order:

- [ ] Outcome reported: `cells list | grep <name>` shows status `alive`
- [ ] Step 4b verify hit (re-read `~/.cells/logs/birth-timings/<name>.log`) — should include lines for steps 1, 2, 3, 3b-3e, 4, 4b, 5, 6, 7, 8 in order. No step skipped
- [ ] Env landed: `well exec -s <name> -- bash -c 'grep -q CELLS_PROXY_SECRET /etc/environment && echo OK'` prints `OK`
- [ ] Identity substituted: `well exec -s <name> -- bash -c 'grep -c __NAME__ ~/agent/IDENTITY.md ~/agent/.pi/settings.json'` returns `0` for both files (no leftover placeholders)
- [ ] `well exec -s <name> -- bash -c 'cat ~/agent/.pi/status.json | jq -r .harness'` matches the requested harness
- [ ] Tmux color set: `well exec -s <name> -- bash -c 'grep -c __CELL_BG__ ~/.tmux.conf'` returns `0`
- [ ] Site service running: `well exec -s <name> -- bash -c 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/'` returns `200`
- [ ] CF Worker deployed: `curl -s -H "Authorization: Bearer $SECRET" https://<name>.cells.md/debug | jq -r .well` returns `<name>.cells.md`
- [ ] **Talk smoke**: `bun cli/cells.ts talk <name> "reply with just the word ok" 2>&1 | tail -3` shows `<name>> ok` within 30s
- [ ] If row has `--channels=slack`: Slack channel `#cells-<name>` exists; channel binding visible in `cells channel list`
- [ ] If row has `--extensions=...`: `well exec -s <name> -- bash -c 'jq .extensions ~/agent/.pi/settings.json'` includes only the requested extensions plus the always-on five (`use-max`, `codex-proxy`, `self`, `thinking`, `heartbeat-watch`)
- [ ] If row has `--packages=pi-web-access`: `well exec -s <name> -- bash -c 'pi list 2>&1 | grep pi-web-access'` shows it installed

## 5. Lifecycle

After all rows in §3-§4 are green, exercise the rest of the lifecycle on one cell (`ck-pi-gpt55`):

- [ ] `cells sleep ck-pi-gpt55` → `cells list` shows `hibernating`
- [ ] `cells talk ck-pi-gpt55 "still here?"` wakes the cell and replies within 60s
- [ ] `cells stop ck-pi-gpt55` → `cells list` shows `stopped`
- [ ] `cells wake ck-pi-gpt55` → returns to `alive`
- [ ] `cells checkpoint ck-pi-gpt55` succeeds
- [ ] `cells see ck-pi-gpt55` opens the browser to `https://ck-pi-gpt55.cells.md` (manual eyeball: page renders)

## 6. Cleanup

`cells kill ck-pi-gpt55 ck-pi-gpt55-pro ck-pi-deepseek-pro ck-pi-deepseek-fl ck-pi-think-low ck-pi-think-adapt ck-pi-ext-memory ck-pi-ext-many ck-pi-pkg-web ck-pi-slack ck-pi-tui --yes`

Verify clean:

- [ ] `cells list` empty of `ck-*` cells
- [ ] `well list` empty of `ck-*` wells
- [ ] `~/.cells/logs/birth-timings/ck-*.log` deleted (kill should sweep these; if not, file a bug)
- [ ] `~/Obsidian/cells/ck-*/` directories absent
- [ ] No CF Workers named `cells-front-ck-*` (`bunx wrangler deployments list 2>/dev/null | grep ck-`)

## 7. Sign-off

When all of §1-§6 pass clean in a single run, birth is shippable for the harness=pi matrix. Tag the run in `state/memory/project_cells_activity.md`:

```
<UTC date HH:MM>  birth-checklist-pass  <commit-sha>  matrix=pi×11rows
```

If any row failed, the failure mode + which row goes in the same line — incomplete checklist passes are signal worth keeping.

## What this doesn't cover (yet)

- `harness=claude-code` — stubbed, not in v1 matrix
- `harness=codex` — stubbed, not in v1 matrix
- Off-Mac talk path (`wss://<name>.cells.md/agent`) — known broken on the per-cell CF Worker (1002 protocol error). Surface it when it comes up
- Eggs (pre-warmed cell pool) — see `docs/eggs.md`; separate checklist when shipped
- `cells dream`, `cells refresh-extensions`, `cells channel link` to legacy IDs — exercise as needed but not gating
