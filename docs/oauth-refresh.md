# Anthropic OAuth refresh — architecture and operations

The fleet's connection to Anthropic is OAuth-based (Pete's Claude Max
subscription) rather than API-key. OAuth tokens expire and rotate, so
the system has to refresh them on a schedule. This doc explains how
the cell project does it, why earlier approaches failed, and what to
do when something looks wrong.

## TL;DR

- The **subscriptions proxy** (`cli/proxy.ts`) is the single entity in the
  fleet that ever calls Anthropic's `/v1/oauth/token`.
- It runs a 5-minute timer that proactively refreshes when the access
  token has < 60 minutes remaining.
- A mutex serializes concurrent refreshes; a 429-backoff prevents
  hammering the endpoint during rate-limit windows.
- Mother pi and cells **only read** `~/.pi/agent/auth.json`. Because
  the proxy keeps tokens fresh with > 60 min headroom, neither one
  ever observes an expired access token, so pi-ai's per-call refresh
  logic stays dormant.
- On upstream `/v1/messages` 401: the proxy forces a refresh and
  retries the original request once.
- On refresh-endpoint 401 (genuine revocation, ≈ months apart): a Mac
  notification fires and a flag file lands at
  `~/.cells/auth-needs-login`. Pete `/login`s pi when convenient.

## Background: how Anthropic OAuth works

Two tokens, very different lifetimes.

| Field in `auth.json` | Source | Lifetime | Used for |
|---|---|---|---|
| `anthropic.access` | OAuth token endpoint | **~10 hours** | `Authorization: Bearer …` on every `/v1/messages` call |
| `anthropic.refresh` | OAuth token endpoint | **~1 year**, rotates on every successful use | Trading for a new `access` |
| `anthropic.expires` | Computed by client (= now + expires_in − 5 min skew) | unix-ms | When to consider `access` stale |

Refresh-endpoint contract (extracted from
`node_modules/@mariozechner/pi-ai/dist/utils/oauth/anthropic.js:291`):

```http
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "client_id":  "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "refresh_token": "<current refresh>"
}
```

Returns `{ access_token, refresh_token, expires_in }` (seconds). **The
refresh token rotates** — the response always contains a new one,
which must be persisted, or the next refresh fails.

## Why we centralize refresh in the proxy

### The original (broken) plan

Pi-ai refreshes lazily: each upstream request that finds an expired
access token kicks off its own refresh attempt. There is no
inter-process mutex. With multiple pi calls in flight, or multiple pi
processes (mother pi + cells via the proxy that read the same
`auth.json`), an expired access token triggers a thundering herd of
refresh requests at Anthropic.

Anthropic's rate limit on `/v1/oauth/token` is sensitive — small
numbers of successive calls trigger HTTP 429. Pi-ai treats any failed
refresh as fatal and bubbles up a 401 to the user. From the user's
perspective, "auth broken." This is the failure pattern that bit us
on 2026-05-01.

The architectural sin was: **refresh ownership wasn't anyone's job.**
The proxy explicitly punted ("mother's own pi keeps that file
fresh"), but mother pi isn't always running, and even when it is,
it doesn't coordinate with concurrent cell traffic.

### The fix

Single responsibility: the proxy owns refresh.

| Component | Refresh? | Reads `auth.json`? |
|---|---|---|
| Mother proxy | **yes — sole owner** | yes (writes it too) |
| Mother pi | no (would only fire if proxy fails — never in practice) | yes |
| Cells | no | no — they don't have OAuth credentials |

The proxy is the right home because it's:
1. **Always running** (driven by the Cloudflare tunnel daemon).
2. **The central auth point** for the whole fleet (it's already the
   one process that injects the Bearer token into upstream calls).
3. **The only fleet component with the refresh token** in practice
   (cells just have a shared bearer secret, not OAuth credentials).

### Behavior contract

```
Timer (every 5 min):
  if (refresh-in-flight)        → wait
  if (now < blocked_until_ms)   → skip (429 backoff)
  if (expires_ms - now > 60m)   → skip
  → POST refresh_token to /v1/oauth/token

  on 200: write new access+refresh atomically to auth.json
  on 429: blocked_until_ms = now + 10m, log
  on 401: notify human, write ~/.cells/auth-needs-login flag, log
  on other: log; next tick retries
```

```
Upstream /v1/messages handler:
  fetch with current access
  if response.status === 401 && !already-retried:
    forceRefresh()  // re-uses the mutex
    fetch again with fresh access (mark x-cells-retried)
  return response
```

The mutex: a single in-flight `Promise<void>` in module scope. While
non-null, every caller awaits the same promise instead of starting a
new refresh. Set to null in a `finally` after the refresh completes.

## Reading the system

### Liveness check

```
GET https://proxy.cells.md/_proxy/health
```

Returns:
```json
{
  "ok": true,
  "access_prefix": "sk-ant-oat01-...",
  "expires_in_min": 487,
  "last_refresh": { "at": 1777680000000, "outcome": "ok" },
  "blocked_until": null
}
```

`expires_in_min` should be 60+ in steady state. If it drops below 60
between two checks, the next timer tick refreshes.

### Local CLI

```sh
cells doctor
```

Reads `auth.json` directly, hits the proxy's local health endpoint,
warns if the `auth-needs-login` flag file exists. First-line
diagnostic for "cells acting weird."

### Where things live

| Path | What |
|---|---|
| `~/.pi/agent/auth.json` | OAuth access + refresh tokens (managed by proxy) |
| `~/.cells/secrets.json`  | Shared secret for cells→proxy auth, plus OpenAI/DeepSeek keys |
| `~/.cells/auth-needs-login` | Flag file: presence means refresh got 401, `/login` needed |
| `cli/proxy.ts` | Refresh manager + Anthropic forwarder + dashboard |

## Operations

### Steady state

You should never need to think about this. The proxy handles
expiries silently. Refresh count is 2–4 per day — same as a normal
single-Pro-user usage pattern. No abuse-flag risk.

### "Things look broken"

Run `cells doctor` first. Three scenarios:

**1. `expires_in_min` is positive, all proxy-health fields look healthy.**
The auth is fine. The bug is elsewhere — usually proxy not reachable
(tunnel down) or cell-side issue.

**2. `last_refresh.outcome === "429"` and `blocked_until` is in the future.**
Anthropic is currently rate-limiting our refresh endpoint. Wait for
`blocked_until` to pass; the next 5-min timer tick will retry. If you
see this often, something is wrong with the backoff logic.

**3. `auth-needs-login` flag exists, doctor warns about it.**
The refresh token has been genuinely revoked. Run pi `/login`,
re-authorize Anthropic, fresh tokens land in `auth.json`. The proxy's
next timer tick will see fresh tokens, succeed, and the flag clears
on its own (or you can `rm ~/.cells/auth-needs-login`).

### Manual refresh probe

If you want to verify the refresh token works without triggering pi:

```bash
REFRESH=$(jq -r .anthropic.refresh ~/.pi/agent/auth.json)
curl -s -X POST https://platform.claude.com/v1/oauth/token \
  -H "Content-Type: application/json" \
  -d "{\"grant_type\":\"refresh_token\",\"client_id\":\"9d1c250a-e61b-44d9-88ed-5944d1962f5e\",\"refresh_token\":\"$REFRESH\"}" \
  | jq '.access_token = (.access_token | .[0:20] + "...")'
```

- HTTP 200 with `access_token` + `refresh_token` → all good.
- HTTP 429 → rate-limited; wait 10 min and retry.
- HTTP 401 → refresh token revoked; `/login` needed.

(Don't hammer this manually — it counts toward our rate-limit budget
just like the proxy does.)

## Lessons learned (2026-05-01 incident)

For about 15 minutes, the entire fleet returned 401 errors. Key
takeaways, captured here so we don't re-derive them under pressure:

1. **HTTP 429 from refresh ≠ HTTP 401 from /v1/messages.** They look
   identical at the user level (auth broken) but mean different
   things. The fix in this doc handles them differently.

2. **Anthropic's rate-limit on `/v1/oauth/token` is tight.** A handful
   of refresh attempts in close succession will trigger 429. Always
   serialize, always back off.

3. **Pi auto-refresh is per-process.** Multiple pi processes (or
   even one process with concurrent in-flight requests) racing each
   other to refresh is a real failure mode, not a theoretical one.

4. **Claude Code and pi have separate OAuth stores.** Don't be misled
   by Claude Code working — its tokens live elsewhere. Always inspect
   `~/.pi/agent/auth.json` directly.

5. **Pi's `/reload` does not reload settings.json.** A full pi exit +
   restart is required for any config change in `.pi/settings.json`.
   Tangential to OAuth, but learned the same day.

6. **"It just started working again" usually means a 429 cooldown
   cleared.** Anthropic's rate-limit windows are around 10 min. If
   things heal without intervention in roughly that window, that's
   the signature.
