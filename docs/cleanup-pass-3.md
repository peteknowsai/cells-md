# Cleanup pass 3 — kill operator + mother proxy's cell-routing role

## Status
- Branch: `cleanup/pass-3-architecture` (already created off main).
- Risk: low. Touches code that's confirmed dead in v2.
- Test scope: cells must still answer over Slack and `cells talk` after the cuts.

## Context

Three cleanup passes followed the v2 birth + bridge work:
1. **Pass 1** (`08e3ec5`) — doc/comment drift after v2 landed.
2. **Pass 2** (`3f144e1` → `a68da4a`, four commits) — bridge-aware `cells talk` / `cells stream` rework, CLI TUI rendering, cold-start retry.
3. **Pass 3** (this plan) — architectural deadwood from earlier pivots.

Two things to remove:
- `proto/operator/` — operator was retired in cells-cloud-front Phase 1a. The launchd plist was already booted out tonight. The directory is ~500 LOC of stale docs (SOUL.md, TOOLS.md, AGENTS.md) and adapter code (`.pi/extensions/operator-tools`, `.pi/extensions/slack-adapter` if present). Pete confirmed: "totally zombie. Delete it."
- The mother proxy's `<cell>.cells.md` reverse-proxy role and the `x-mother-secret` HTTP gate on sprite site servers. In v2, Cloudflare custom domains route `<cell>.cells.md` directly to per-cell workers. Mother is bypassed for cell traffic. The HTTP gate on the site server is therefore dead too — only the WS `/agent` upgrade path is gated on bearer (separate, still needed).

**Mother proxy keeps its OAuth role.** `cli/proxy.ts` still serves `mother.cells.md/v1/*` (Anthropic Claude Max) and `/codex/*` (OpenAI Codex). Every cell's pi-ai has its model registry patched to `mother.cells.md` via `proto/mother/dna/scripts/apply-pi-patches.sh`. Touching that role is **pass 4** (separate doc, separate phase).

## Concrete steps

### 1. Delete `proto/operator/`
```sh
rm -rf proto/operator/
```
Then audit references. From earlier greps:
- `cli/cells.ts` — already cleaned tonight (cmdUnscheduleOperator removed in `3f144e1`).
- `docs/operator.md` — already marked RETIRED at the top. Either leave as historical or delete. Recommendation: **leave** — it documents what we *had* in case we re-introduce.
- `proto/mother/CELLS.md` and similar may reference operator. Search and trim mentions to "operator was the v1 Slack edge; now retired."

### 2. Strip `<cell>.cells.md` routing from `cli/proxy.ts`
Look at `cli/proxy.ts:953` — the host-based router has a `if (host.startsWith("mother.cells.md")...)` branch that keeps the mother routes (`/`, `/v1/*`, `/codex/*`). The else-branch routes any other `*.cells.md` host to the corresponding sprite. That else-branch is dead in v2 — Cloudflare custom domains have already taken the request before it reaches mother.

Action:
- Remove the cell-host else branch entirely.
- If a request arrives at mother for a cell host (shouldn't happen anymore, but defensively), return 404.
- Drop any imports/helpers used only by that branch (sprite-host resolution, `x-mother-secret` injection, etc).

This shrinks `cli/proxy.ts` meaningfully (~15-20% of the file is the cell-routing path).

### 3. Drop `x-mother-secret` HTTP gate on sprite site server
File: `proto/mother/dna/site/server.ts`. Around line 247:
```ts
if (SECRET && req.headers.get("x-mother-secret") !== SECRET) {
  return new Response("forbidden", { status: 403 });
}
```
This gates static-route serving (homepage, public/) on the secret. Nobody's hitting these routes through mother anymore — Cloudflare reaches the sprite directly via the `--auth public` URL.

Action: remove the gate. Static + homepage become public at `<sprite>.sprites.app`. The `/agent` WS upgrade keeps its `Authorization: Bearer ${SECRET}` check (load-bearing).

`MOTHER_SECRET` env var stays — the WS gate uses it. Don't unset.

### 4. Audit references
After steps 1-3, run:
```sh
grep -rn "operator\|<cell>\.cells\.md routing\|x-mother-secret" cli proto scripts docs \
  | grep -v "node_modules\|state/memory\|docs/operator.md"
```
Fix any active-tense mentions of operator outside `docs/operator.md` and `state/memory/` (those stay historical). Update comments that describe the old routing flow.

### 5. Verify
- `cells talk pete "ping"` — should still work. The cell's pi calls `mother.cells.md/v1/*` for Claude (unchanged), responds via the bridge.
- `cells talk` interactive on at least 2 other cells (jim, kev, etc) to confirm no regression.
- Send a Slack message to `#kev` (or whichever you used as canary), confirm reply.
- Check that `<cell>.cells.md/debug` still returns the DO state JSON (CF custom domain → cell worker; nothing changed here).

### 6. Commit + merge
- Commit on branch with a thorough message describing what was removed and what stays.
- Squash-merge to main when verified.
- Delete `cleanup/pass-3-architecture` branch.

## Files modified
- `cli/proxy.ts` — strip cell-routing, ~200 lines removed.
- `proto/mother/dna/site/server.ts` — drop HTTP-route secret gate.
- `proto/operator/` — directory deleted.
- `proto/mother/CELLS.md` and any other proto/*.md with active-tense operator references — trim to historical.

## Estimated effort
~30 minutes including verification.

## Out of scope (explicitly deferred)
- Anything touching `cli/proxy.ts`'s `/v1/*` or `/codex/*` handlers.
- The `apply-pi-patches.sh` Anthropic baseUrl substitution.
- The `mother-codex` extension in DNA.
- The `use-codex` extension in proto/pulse.

All of those route to **pass 4** (OAuth Worker migration, separate plan at `docs/oauth-worker.md`).
