# Mother's proxy — Anthropic API for the cells fleet

Cells used to ship with a frozen OAuth access token in `ANTHROPIC_API_KEY`
that expired hours after birth → 401s. Replaced with a proxy on the mother
laptop. Single OAuth principal, no token race.

Canonical fleet host is `https://mother.cells.md/` — dashboard at `/`,
Anthropic API at `/v1/*`, health at `/_proxy/health`. (Legacy
`keeper.cells.md` was retired 2026-05-01.)

## Architecture

```
cells (and mother) ──► https://mother.cells.md ──► laptop proxy (port 8787) ──► api.anthropic.com
                              ▲                              ▲
                       cloudflared tunnel           reads + writes ~/.pi/agent/auth.json
                       (cells-proxy, ID             proxy is the SOLE owner of OAuth refresh
                        4d34806f-…)                 (5-min timer + mutex + 429 backoff)
```

- **Tunnel:** `cells-proxy` in cloudflared, ingress in `~/.cloudflared/cells-proxy-config.yml`.
- **DNS:** `mother.cells.md` CNAME, plus wildcard `*.cells.md` (so `pete.cells.md`,
  `rick.cells.md`, … all hit the same tunnel; mother routes by Host header).
- **Proxy code:** `cli/proxy.ts` (Bun.serve).
- **Shared secret:** stored in `~/.cells/secrets.json` as `CELLS_PROXY_SECRET`.
  Format starts with `sk-ant-oat01-` so pi treats it as an OAuth token (Bearer
  auth, not x-api-key). Without the prefix, pi sends the wrong header style.
- **Refresh strategy:** proxy owns refresh end-to-end. 5-min timer
  refreshes when access < 60 min remaining; in-flight mutex serializes
  callers; 10-min backoff on HTTP 429; Mac notification + flag file at
  `~/.cells/auth-needs-login` on hard 401. See `docs/oauth-refresh.md`.

## Why it's the right shape

OAuth refresh tokens **rotate on use** (verified by experiment 2026-04-30).
If multiple cells held the refresh token, they'd brick each other randomly.
Solution: only the mother (laptop) holds the refresh token. Cells get nothing
durable — they authenticate to the proxy with a shared secret, the proxy
swaps in the mother's current OAuth bearer and forwards.

## Pi internals (load-bearing facts)

- Pi does **not** honor `ANTHROPIC_BASE_URL`. Its `pi-ai` package hardcodes
  `baseUrl: "https://api.anthropic.com"` per-model in `models.generated.js`.
  Birth ritual must `sed` this file to point at `https://mother.cells.md`.
  Patch is fragile — a `bun install` on the cell will clobber it. Re-patch
  is part of the boot/health path.
  Files (both must be patched on a cell):
  - `~/agent/node_modules/@mariozechner/pi-ai/dist/models.generated.js`
  - `~/.bun/install/global/node_modules/@mariozechner/pi-ai/dist/models.generated.js`
- Pi picks Bearer vs x-api-key by **substring match `sk-ant-oat`** in the
  token. The proxy secret is prefixed `sk-ant-oat01-cells-proxy-…` for this
  reason.
- Pi reads env via `/proc/self/environ` fallback (Bun bug workaround), so
  env vars set after pi started won't be picked up. Restart pi (kill the
  agent tmux session; the Wells `agent` service respawns it).

## Cell wiring (what birth must do)

`~/.bashrc.d/anthropic_proxy` on each cell:
```sh
export ANTHROPIC_OAUTH_TOKEN=<shared secret, sk-ant-oat01-cells-proxy-…>
export ANTHROPIC_AUTH_TOKEN=<same>
unset ANTHROPIC_API_KEY
```
Plus the `models.generated.js` sed patch above. No `ANTHROPIC_BASE_URL` —
pi ignores it; the patch is the override.

## Mother-side ops

- Proxy launchd plist: TBD (currently runs as a foreground bun process).
- cloudflared launchd plist: TBD (currently a foreground tunnel).
- Both need to run as services so they survive logout/reboot.

## Dashboard / per-cell pages

`mother.cells.md/` serves the fleet dashboard. `<cell>.cells.md/` serves
a per-cell info page rendered by the mother (cells don't host anything).
Source data: roster file, activity log, Wells API. Public read for now;
auth coming.

DNS: `mother.cells.md` is a CNAME to the `cells-proxy` tunnel, plus the
`*.cells.md` wildcard. cloudflared ingress in `~/.cloudflared/cells-proxy-config.yml`
lists it explicitly + the wildcard.
