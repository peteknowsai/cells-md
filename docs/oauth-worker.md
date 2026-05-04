# Pass 4 — OAuth proxy as a CF Worker + Durable Object

## Status
- Not yet implemented. Design only.
- Branch: TBD when work starts (suggest `feature/oauth-worker`).
- Risk: high. Touches the LLM-access path for every cell. Done wrong, the whole fleet 401s.

## Goal

Move the OAuth/LLM-forwarding role of the local mother proxy
(`cli/proxy.ts`) into a Cloudflare Worker + Durable Object at
`proxy.cells.md`. Local mother becomes a **token-refresh agent** —
periodically refreshes Anthropic and OpenAI Codex tokens, pushes new
access tokens to the DO. Cells call the Worker directly.

End-state: mother is no longer a load-bearing HTTP gateway. It's just
an agent (running on Pete's laptop today, eventually maybe in a VM)
whose only ongoing infra duty is keeping tokens fresh.

## Why this matters

Today the entire fleet's LLM access depends on Pete's laptop being
on AND mother proxy being up AND its tunnel being healthy. If any of
those fail, every cell silently 401s. Moving the request path to CF
gives us:
- Cell requests don't traverse Pete's home network.
- Pete's laptop can be off for short windows (until access_token
  expires — typically ~1 hour for Anthropic) without breaking cells.
- Mother becomes interchangeable with cells in the architecture.

## Architecture

```
                    ┌────────────────────────────────────────┐
                    │  proxy.cells.md  (CF Worker + DO)      │
                    │                                        │
                    │  routes:                               │
                    │    POST /v1/messages → Anthropic       │
                    │    POST /codex/*     → OpenAI Codex    │
                    │    PUT  /tokens      → mother only     │
                    │    GET  /tokens/state → mother only    │
                    │                                        │
                    │  DO storage:                           │
                    │    anthropicAccessToken                │
                    │    anthropicAccessTokenExpiresAt       │
                    │    anthropicRefreshToken               │
                    │    codexAccessToken                    │
                    │    codexAccessTokenExpiresAt           │
                    │    codexRefreshToken                   │
                    │                                        │
                    │  bearer auth:                          │
                    │    cell calls    → CELLS_PROXY_SECRET  │
                    │    mother PUT    → MOTHER_REFRESH_SECRET│
                    └─────────┬────────────────────┬─────────┘
                              │                    │
                       /v1, /codex                /tokens
                              │                    │
              ┌───────────────┴────┐         ┌─────┴─────────┐
              │   Cells (sprites)  │         │ Mother (Mac)  │
              │   pi-ai →          │         │  refresh-agent│
              │   proxy.cells.md   │         │  every ~15min │
              └────────────────────┘         └───────────────┘
```

## Storage decision (committed)

**Use DO storage in the Worker for ALL tokens, including refresh
tokens.** Storage option (i) from earlier discussion. Rationale: get
it working. Security tightening — moving refresh tokens off the Worker
into local-only storage with a thinner Worker that only sees access
tokens — is on the scratchpad (`docs/scratchpad.md`).

## Components

### 1. CF Worker at `cli/worker/proxy/`

```
cli/worker/proxy/
├── index.ts        — entry, routes /v1/*, /codex/*, /tokens/*
├── proxy-do.ts     — TokenStore Durable Object class
├── wrangler.toml   — proxy.cells.md custom domain, DO binding
└── package.json
```

**Routes:**

- `POST /v1/messages` (and any other Anthropic API path under `/v1/*`)
  - Bearer auth: `CELLS_PROXY_SECRET`.
  - DO returns current `anthropicAccessToken`.
  - Forward to `https://api.anthropic.com/<path>` with that token as
    `x-api-key` (or whatever pi-ai's existing auth shape requires —
    check `cli/proxy.ts` current logic for the exact header name +
    any `anthropic-beta`, `anthropic-version` headers).
  - Stream the response body back unchanged.
  - On 401 from Anthropic: don't retry (token is stale; mother will
    refresh on next poll). Return 502 with a hint header so cells can
    surface "mother is offline / token expired."

- `POST /codex/*` (existing routing strips `/codex` prefix, forwards
  to `https://chatgpt.com/backend-api/codex/*` per current proxy.ts
  logic — verify in `cli/proxy.ts:558+`)
  - Bearer auth: `CELLS_PROXY_SECRET`.
  - DO returns `codexAccessToken`.
  - Forward with appropriate headers; mirror the existing
    `extractAccountId` stub patch (worker injects `chatgpt-account-id`
    server-side from a stored value, since cells send bearer-secret-
    as-token, not the JWT pi-ai's vendor extractor expects).

- `PUT /tokens` (mother only)
  - Bearer auth: a separate `MOTHER_REFRESH_SECRET` distinct from
    `CELLS_PROXY_SECRET`. Cells must NOT have this.
  - Body: `{ provider: "anthropic" | "codex", accessToken, expiresAt,
    refreshToken? }`.
  - Writes to DO storage.

- `GET /tokens/state` (mother only)
  - Returns `{ anthropic: { expiresAt, hasRefreshToken },
    codex: { expiresAt, hasRefreshToken } }`.
  - Mother polls this to decide if a refresh is needed.

**Durable Object:**

Single-instance DO (id `tokens` — global singleton). Stores all the
fields above via `state.storage.put/get`. Methods:
- `getAnthropic()` → `{ accessToken, expiresAt }`
- `getCodex()` → `{ accessToken, expiresAt }`
- `setAnthropic(accessToken, expiresAt, refreshToken?)`
- `setCodex(accessToken, expiresAt, refreshToken?)`
- `state()` → metadata for `/tokens/state` route

**wrangler.toml:**
```toml
name = "cells-front-proxy"
main = "index.ts"
compatibility_date = "2026-01-01"

[[routes]]
pattern = "proxy.cells.md"
custom_domain = true

[[durable_objects.bindings]]
name = "TOKENS"
class_name = "TokenStore"

[[migrations]]
tag = "v1"
new_classes = ["TokenStore"]
```

Secrets:
- `CELLS_PROXY_SECRET` (cells use)
- `MOTHER_REFRESH_SECRET` (mother uses for token PUTs)

Both piped via `wrangler secret put` from `~/.cells/secrets.json`.

### 2. Local mother — `cli/proxy.ts` retires HTTP serving

After this lands, `cli/proxy.ts` becomes a **refresh-agent**, not an
HTTP server. Run via launchd. Loop:

```ts
async function refreshLoop() {
  while (true) {
    const state = await fetch("https://proxy.cells.md/tokens/state", {
      headers: { authorization: `Bearer ${MOTHER_REFRESH_SECRET}` }
    }).then(r => r.json());

    // If anthropic expires within 10 min → refresh + push.
    if (state.anthropic.expiresAt - Date.now() < 10 * 60 * 1000) {
      const fresh = await refreshAnthropicToken();   // existing logic in cli/proxy.ts
      await pushToken("anthropic", fresh);
    }
    // Same for codex.
    if (state.codex.expiresAt - Date.now() < 10 * 60 * 1000) {
      const fresh = await refreshCodexToken();
      await pushToken("codex", fresh);
    }

    await sleep(15 * 60 * 1000);  // 15 min between checks
  }
}
```

The actual refresh logic — Anthropic OAuth refresh, OpenAI Codex
refresh, where local refresh tokens live — is already implemented in
the current `cli/proxy.ts`. We're moving the *forwarding* out and
keeping the *refresh* logic local; both halves talk to the DO.

The launchd plist (`com.pete.cells-proxy`) keeps running but its
only job becomes the refresh loop. The HTTP server portion of
`cli/proxy.ts` gets removed.

### 3. Re-patch every cell

`proto/mother/dna/scripts/apply-pi-patches.sh` currently does:
```sh
sed 's|https://api.anthropic.com|https://mother.cells.md|g' models.generated.js
```

Change to:
```sh
sed 's|https://api.anthropic.com|https://proxy.cells.md|g' models.generated.js
```

Same for the codex baseUrl in `mother-codex` and `use-codex`
extensions: change `mother.cells.md/codex` to `proxy.cells.md/codex`.

To deploy: bump the patch version, then for each cell:
- `scripts/apply-pi-patches.sh <cell>` (or whatever the per-cell
  re-patch invocation is — verify path).
- Or simpler: re-run `bun install` + `configure-cell-proxy.sh` on
  each cell, which already handles the patch.

## Migration order (the careful part)

1. **Build the Worker, deploy to `proxy.cells.md`.** Don't seed the
   DO yet — Worker rejects with "no token" until mother seeds.
2. **Write the refresh-agent half locally.** Keep mother's HTTP
   server alive during this — cells continue to hit `mother.cells.md`.
3. **First seed.** Have mother do an initial `PUT /tokens` for both
   providers using its current in-memory state. DO now has fresh
   tokens.
4. **Test the Worker** end-to-end with a curl as a fake cell:
   ```sh
   curl -H "authorization: Bearer $CELLS_PROXY_SECRET" \
        -d '{"model":"claude-opus-4-7","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
        https://proxy.cells.md/v1/messages
   ```
   Confirm it returns Claude's response.
5. **Flip ONE cell** as canary. Re-patch its pi-ai to point at
   `proxy.cells.md` instead of `mother.cells.md`. Send a Slack
   message; confirm reply. Bake for a day.
6. **Roll out fleet-wide.** Re-patch remaining cells.
7. **Retire mother proxy's HTTP serving.** Once no cell still routes
   to `mother.cells.md`, delete the HTTP server bits from
   `cli/proxy.ts`. Mother is just refresh-agent now.

Each step is reversible until step 7. Steps 1-6 leave both proxies
alive in parallel.

## Verification gates per step

- After step 1: `curl https://proxy.cells.md/_health` returns OK.
- After step 3: `GET /tokens/state` returns `expiresAt` in the future
  for both providers.
- After step 4: curl test succeeds with a real Claude response.
- After step 5: canary cell answers a Slack ping within 10s.
- After step 6: `wrangler tail cells-front-proxy` shows traffic from
  every cell name.
- After step 7: `mother.cells.md/v1/messages` returns 404 (proxy.ts
  no longer handles it). `proxy.cells.md/v1/messages` carries 100% of
  traffic.

## What this does NOT change

- Pi-ai's `extractAccountId` patch — still needed (in the Worker
  now, instead of in `cli/proxy.ts`).
- The `MOTHER_SECRET` env var on cells — still used for the WS
  `/agent` upgrade gate. Unrelated to this migration.
- The `apply-pi-patches.sh` mechanism — same script, different
  baseUrl substitution.

## Estimated effort
~1.5 days, ~half spent on Codex token-refresh subtleties (Anthropic
refresh is straightforward; OpenAI Codex token format is gnarlier).

## Open design questions (resolve before code)

1. **DO instance strategy.** Singleton (one DO holds all tokens for
   the whole fleet) or per-provider DOs? Singleton is simpler.
   Per-provider gives finer-grained alarm-driven token-status checks
   if we ever want them. **Recommendation: singleton.**

2. **What happens when access token expires AND mother is offline?**
   Worker has stale token → forwards → Anthropic returns 401 →
   Worker returns 502. Cells see 502. Should the bridge render a
   useful message ("LLM access offline — try again in a moment")?
   Probably yes; bridge polish item.

3. **Bootstrapping a new install.** The very first `PUT /tokens`
   needs `MOTHER_REFRESH_SECRET` to already be deployed to the
   Worker. Order: deploy worker → seed secret → mother refresh-agent
   does first PUT.

4. **Who knows `MOTHER_REFRESH_SECRET`?** Mother does (in
   `~/.cells/secrets.json`). Cells must NOT (otherwise a compromised
   cell can write tokens). Worker secret is set by Pete via wrangler.

## See also
- `docs/cleanup-pass-3.md` — the prerequisite cleanup that removes
  mother proxy's *cell-routing* role. This pass-4 plan only touches
  the *OAuth* role.
- `docs/scratchpad.md` — list of follow-ups not blocking pass-4
  including security hardening of refresh-token storage.
