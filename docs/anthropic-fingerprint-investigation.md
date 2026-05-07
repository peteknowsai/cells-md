# Anthropic fingerprint investigation — reference

Pete's working theory (2026-05-06): Anthropic has started throttling
his Pi-via-Claude-Max usage by returning `200 OK` with an immediately-
truncated SSE stream (what pi-ai labels `errorMessage: "terminated"`).
Not 429s, not error bodies — just empty streams. This is consistent
with provider-side fingerprinting of "this is Pi/agent traffic, not
interactive Claude.ai user."

Cat-and-mouse: we periodically need to identify what's screaming "bot"
and adjust. This doc captures the current outbound-request shape so
the next investigation doesn't start cold.

## What `cli/proxy.ts:handleApiProxy` currently sends to api.anthropic.com

Source: `cli/proxy.ts` lines ~440–545 (handleApiProxy).

**Request URL:**
```
https://api.anthropic.com/v1/<rest>
```
Path verbatim from cell-side; query string preserved.

**Headers** (built by replaying inbound request headers, then mutating):

- `Authorization: Bearer <access_token>` — set by proxy (replaces the
  cell-side bearer which was just `CELLS_PROXY_SECRET`). The access
  token comes from `~/.pi/agent/auth.json`, refreshed by the proxy's
  refresh manager.
- `anthropic-beta: oauth-2025-04-20` — explicitly added if not present
  (cli/proxy.ts:498-501). **Strong fingerprint candidate**: this header
  signals "OAuth Pi user," which is precisely the population they
  might be throttling.
- All other inbound headers passed through verbatim except:
  - `host` — stripped (let fetch set it)
  - `x-cell-name` — stripped (cells-internal, no need to leak)
  - `authorization` — stripped before Bearer is rebuilt
- Pi-ai's Anthropic SDK adds default headers including:
  - `User-Agent: Anthropic/JS <sdk-version>` — identifies the SDK
  - `X-Stainless-*: <metadata>` — Stainless codegen leaks JS SDK + version + lang + arch
  - `anthropic-version: 2023-06-01` (or whatever pi-ai pins)
  - `accept: application/json` (or text/event-stream for streaming)

**Body**: Anthropic Messages API JSON shape. Conformant to spec.

**Cellular-vs-direct difference**: Anthropic sees the request from
Pete's home IP via cloudflared tunnel → laptop → api.anthropic.com.
Egress IP is residential. ADR-0001 explains why we can't move that.

## Things worth probing if we re-engage the cat-and-mouse

In rough order of "low-effort high-payoff":

1. **`anthropic-beta` header**: try removing the `oauth-2025-04-20`
   value. The cell-side patch that adds it (in pi-ai) might not even
   need it for our use case. If it works without, that header is the
   single most likely fingerprint vector and we can ditch it.
2. **`X-Stainless-*` headers**: pi-ai's Anthropic SDK adds these and
   they identify SDK/lang/arch. If we can strip them at the proxy
   without breaking pi-ai, we look more like generic anthropic-client
   traffic.
3. **User-Agent normalization**: replace `Anthropic/JS <ver>` with
   something less obvious. Possibly mimic Claude.ai's actual UA
   (browser-style) — this is more aggressive but might be what they
   key on.
4. **Token-cache pattern**: if Anthropic is keying on "many requests
   per OAuth session within window," we might split traffic across
   multiple OAuth identities. Out of scope for v1.
5. **Request rate / burstiness**: harden + meta-loop produces bursty
   request patterns. Could insert artificial jitter or smoothing.
   Might just hide symptoms instead of fixing the underlying
   fingerprint though.

## How to gather data when ready

Quick capture: instrument `cli/proxy.ts:callUpstream` to log full
outbound headers + first 200 bytes of response on Anthropic-bound
requests. Capture one cycle of: a happy request (rare lately) and a
terminated request. Compare to what an actual Claude.ai web-app call
looks like (browser devtools network tab).

The deeper experiment: temporarily route one cell through a different
egress (e.g., from a different home IP) to test whether the throttle
is account-wide or IP-specific.

## Live signal we have

cells-proxy.log shows the outcome of every outbound. Today's pattern:
- `/v1/messages` → consistent 200 OK, 1-2s, but body is `terminated`
  (empty stream) per pi-ai's parse
- `/codex/responses` → consistent 429s (real ChatGPT Plus rate-limit
  on the $20 tier; Pete is upgrading to $100)

So Anthropic-side: 200 status, no payload. That's the suspicious shape.

## Don't dive in yet

Tier 3 (DeepSeek API) is carrying the load transparently. The fleet
is fine. This is research material for when Pete wants to tweak,
not an urgent action item.
