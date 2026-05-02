---
name: health-check
description: Run a thorough end-to-end health check on a cell. Covers the Sprite VM, the runtime stack (tmux/Pi/bun), auth (OAuth + shared secrets), the agent template (extensions + memory), and live agent behavior (responsiveness, tool calls, egress). Produces a one-table report with pass/fail per capability.
allowed-tools: [bash, sprite_exec, sprite_checkpoint, talk_to_agent, peek_agent_screen, read_agent_memory, report_outcome, read]
---

# Health Check Ritual

Substitute `<NAME>` with the cell name from the user's message. Run every
check below. Don't stop on the first failure — collect them all and report
a table at the end. Be terse: one line of narration per group.

The checks are split into three tiers. Run tier 1 first; if the VM is dead
there's no point running 2 or 3. Otherwise run all three, even if some fail.

## Tier 1 — Infrastructure (Sprite VM)

Single `sprite_exec` call, capture everything:

```bash
echo "== HOSTNAME =="; hostname
echo "== UPTIME =="; uptime
echo "== DISK =="; df -h /home/sprite | tail -1
echo "== NETWORK =="; curl -sS --max-time 5 -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/ 2>&1 || echo "egress fail"
echo "== EXA =="; curl -sS --max-time 5 -o /dev/null -w "%{http_code}\n" https://api.exa.ai/ 2>&1 || echo "exa fail"
```

Pass criteria:
- `hostname` equals `<NAME>`
- disk has free space (not 100% used)
- network curl prints any HTTP code (DNS resolved, TCP/TLS worked) — exact code doesn't matter

## Tier 2 — Runtime stack

One more `sprite_exec`:

```bash
echo "== TMUX =="; tmux ls 2>&1
echo "== PI PROC =="; pgrep -af pi | grep -v grep || echo "no pi running"
echo "== BUN =="; /home/sprite/.bun/bin/bun --version 2>&1
echo "== PI BIN =="; ls -la /home/sprite/.bun/bin/pi 2>&1
echo "== AGENT DIR =="; ls /home/sprite/agent/ 2>&1
echo "== NODE_MODULES =="; test -d /home/sprite/agent/node_modules && echo ok || echo MISSING
echo "== EXTENSIONS =="; ls /home/sprite/agent/.pi/extensions/ 2>&1
echo "== PI-WEB-ACCESS =="; test -d /home/sprite/agent/.pi/npm/node_modules/pi-web-access && echo ok || echo MISSING
echo "== SPRITE CLI =="; which sprite 2>&1
echo "== ENV FILES =="; ls -la /home/sprite/.bashrc.d/ 2>&1
echo "== PROXY TOKEN =="; awk -F"'" '/ANTHROPIC_AUTH_TOKEN/{print substr($2,1,12)"...("length($2)" chars)"}' /home/sprite/.bashrc.d/anthropic_proxy 2>/dev/null || echo "MISSING"
echo "== MODEL URL =="; grep -o 'https://[a-z.]*\.anthropic\.com\|https://keeper\.cells\.md' /home/sprite/agent/node_modules/@mariozechner/pi-ai/dist/models.generated.js 2>/dev/null | sort -u | head -3
echo "== SHELL SHIM (bashrc) =="; grep -c "tmux new-session" /home/sprite/.bashrc 2>/dev/null
echo "== SHELL SHIM (zshrc) =="; grep -c "tmux new-session" /home/sprite/.zshrc 2>/dev/null
echo "== MEMORY INDEX =="; head -3 /home/sprite/agent/state/memory/MEMORY.md 2>&1
```

Pass criteria:
- `agent` tmux session is listed (start it if not — use `tmux new-session -d -s agent 'bash -lc "for f in /home/sprite/.bashrc.d/*; do . \$f; done; exec pi"'`)
- bun version prints, pi binary exists
- `node_modules` exists; `identity`, `memory`, `self-tools` in `agent/.pi/extensions/`; `pi-web-access` present at `agent/.pi/npm/node_modules/pi-web-access`
- `sprite` CLI installed
- `anthropic_proxy` env file exists and contains a `CELLS_PROXY_SECRET` of expected length (~64 chars). Cells route through `https://mother.cells.md`; they don't hold real Anthropic credentials.
- Model URL is `https://mother.cells.md` (NOT `https://api.anthropic.com`) — if it's the latter, run `scripts/configure-cell-proxy.sh <NAME>` from the mother to re-patch.
- Both shimss have at least one match for `tmux new-session`
- `MEMORY.md` exists

If `agent` tmux session was missing, start it (per command above) before tier 3.

## Tier 3 — Live agent behavior

Talk to the agent. `talk_to_agent` strips newlines, so write the probe as
one line with `;` separators. Use `wait_seconds: 25`.

Probe:

> health probe. reply in this exact format, no prose: NAME=<your name>; EGRESS=<call info_self and paste its egress allowlist line>; WEB=<use web_search for "current year" — paste 1 line of the answer>; MEMORY_OK=<use write_memory on file reference_health_probe.md with body "ok" then say done>

Pass criteria:
- agent responds at all (no 401, no timeout) — **critical**
- `NAME` equals `<NAME>` (use-max extension working)
- `WEB=` line has content (web_search + egress + Anthropic API all work)
- `MEMORY_OK=done` (memory extension working)
- `EGRESS=` line is non-empty — if `(unavailable)`, that means `SPRITES_TOKEN`
  isn't set (cell was born before secrets contained it). Mark ⚠️, not ❌
  — `talk_to_self` and other self-tools still work without it.

Verify the memory write actually hit disk + clean up with one `sprite_exec`:

```bash
cat /home/sprite/agent/state/memory/reference_health_probe.md && rm /home/sprite/agent/state/memory/reference_health_probe.md && echo cleaned
```

File should contain `ok` and `cleaned` should print.

## Final report

Print a single markdown table to the user with one row per capability and
a status emoji (✅ / ❌ / ⚠️ for non-critical) and a terse note. Group rows
by tier. End with a one-line verdict: "healthy", "degraded (X issues)", or
"unhealthy".

Then call `report_outcome` with `success: true` if all critical checks
passed, `false` otherwise. Critical = tier 1 network + tier 2 auth + tier 3
agent responsiveness. Other failures are degradations, not full failures.

Finally, append one line to `memory/project_cells_activity.md`:

```
<UTC date HH:MM>  health      <NAME>      <verdict + terse notes>
```

Use `date -u +"%Y-%m-%d %H:%M"`.

## On a totally dead VM

If tier 1's `sprite_exec` itself errors (Sprite gone, name unknown), skip
tiers 2/3 and report `unhealthy: VM unreachable` immediately.
