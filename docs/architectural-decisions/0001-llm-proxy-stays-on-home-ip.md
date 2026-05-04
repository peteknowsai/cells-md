# 0001 — LLM proxy stays on a home-IP egress, not a Cloudflare Worker

**Status:** accepted (2026-05-04)
**Context branch:** `feature/oauth-worker` (squash-merged then most of it
unwound — see git log around the rollback commit).

## What we tried

Pass 4 in `docs/oauth-worker.md` (now retired) proposed moving the
OAuth-bearing forward proxy off Pete's laptop into a Cloudflare Worker
at `proxy.cells.md`, with a TokenStore Durable Object holding refresh
tokens and Pete's laptop reduced to a "refresh-agent" pushing fresh
access tokens into the DO every ~15 minutes. Goal: cells survive
laptop-off windows without 401ing the fleet.

We built it (Phase A worker + DO, Phase B push-loop in `cli/proxy.ts`,
Phase C re-patch of all five cells), flipped the cutover flag, and
immediately broke every codex-using cell.

## What we found

`chatgpt.com` is fronted by Cloudflare. When a Cloudflare Worker (egress
IP in CF's range) makes an outbound `fetch()` to another CF zone, the
upstream zone fingerprints the egress IP and returns a "Ray ID" anti-
loop challenge page instead of the API response. Stripping `cf-*` and
`x-forwarded-*` headers is not enough — the IP itself is the signal.

Anthropic does not enforce that today, but the same fingerprinting is a
trivial flag-flip away. CF Worker egress IP ranges are public knowledge.
The whole point of routing through Pete's laptop via a cloudflared
tunnel is the residential egress — both subscription providers see a
home IP and behave normally. Moving the request path into a Worker
threw that property away.

## Decision

The LLM proxy lives on Pete's Mac. Both `/v1/*` (Anthropic Claude Max)
and `/codex/*` (OpenAI ChatGPT Plus) requests egress from his home IP
via cloudflared. There is no Cloudflare Worker in the request path for
upstream API calls.

We also separated three roles that v1 had collapsed into "mother":

1. **Mother's identity.** Mother is a cell. Same shape as `pete`, `kev`
   et al — a sprite VM with its own `~/agent`, sessions, memory, identity.
2. **Mother's website.** Like every cell, mother gets a per-cell CF
   Worker + DO at `mother.cells.md` whenever we get around to birthing
   her. That gives her a public face that survives the laptop being off.
3. **The subscriptions proxy.** A standalone laptop service that swaps
   the cell-shared `CELLS_PROXY_SECRET` bearer for real OAuth tokens and
   forwards to `api.anthropic.com` and `chatgpt.com/backend-api`. Lives
   on the laptop forever (or until both subs become real API keys, at
   which point this whole thing goes away). Reachable at
   `proxy.cells.md`, tunneled by cloudflared to `localhost:8787`.

The subscriptions proxy is **not** part of mother. Splitting them out:
mother is free to be a cell that can run anywhere; the proxy is a
single laptop-bound service that exists to stretch Pete's two
subscriptions across the fleet.

## What this means in practice

- Cells are patched to call `https://proxy.cells.md/v1/*` (Anthropic)
  and `https://proxy.cells.md/codex/*` (codex). Same secret, same
  shape — only the hostname changed from `mother.cells.md` to
  `proxy.cells.md`.
- The cloudflared tunnel (`cells-proxy`) routes both `mother.cells.md`
  (legacy, will retire when mother is birthed as a real cell) and
  `proxy.cells.md` (new) to `localhost:8787`.
- The CF Worker `cells-front-proxy` is deleted. `cli/worker/proxy/`
  removed from the tree.
- The push-loop and `MOTHER_REFRESH_SECRET` plumbing in `cli/proxy.ts`
  is removed; the file is renamed/restructured to drop "mother" from
  its identity (subscriptions proxy is just the proxy).

## When to revisit

If both Anthropic and OpenAI ship plain API-key surfaces for their
consumer subs (or Pete moves to API-billing), the proxy goes away
entirely. Cells get an env var with a real key and call the upstreams
directly. No tunnel, no proxy, no laptop dependency. That is the
desired end state.

If we ever want the laptop-can-be-off property back without giving up
home-IP egress, the only honest path is a residential-IP relay (a
Raspberry Pi at home running cloudflared + a copy of the proxy, plus a
sync mechanism for tokens between laptop and Pi). That is more
machinery than two subscriptions justify today.

## Reference

- `cli/worker/proxy/` deletion commit + this ADR are the full record;
  the rollback commit on `feature/oauth-worker` (pre-squash) preserves
  the moment-of-discovery if anyone wants to spelunk the diff.
