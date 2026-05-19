# Cells Substrate — Future Roadmap

**Status:** PROPOSED · **Date:** 2026-05-19 · **Author:** drafted with Pete

A vision document for the cells substrate. Ten primitives, ordered by leverage. The intent is to lay out where cells goes *if effort and money are unconstrained* — so we can argue about priorities, not about whether the destination is right.

This is the umbrella doc. The agent-comms primitive (item 2 below) has its own deep-dive at [`agent-comms-primitive.md`](agent-comms-primitive.md) because it is the next thing to build and the spec is ready.

---

## TL;DR — the ten primitives, in priority order

| # | Primitive | One-liner | Leverage |
|---|---|---|---|
| 1 | **Per-cell identity** | Each cell has its own keypair + capability tokens, not a shared `CELLS_PROXY_SECRET` | Unblocks everything else; single shared secret is a fleet-compromise footgun |
| 2 | **Agent-to-agent comms** | `list / send / await / get` between cells, native to the substrate, all harnesses | The universal coordination primitive |
| 3 | **Shared knowledge layer** | Substrate-level vector + fact store cells can publish to and query | Replaces cross-cell chatter with cross-cell reads |
| 4 | **Sandboxed execution within a cell** | Untrusted tasks (scrapers, browser-use) run in a nested isolate inside the well | Scraper exploit can't pivot to the cell's full identity |
| 5 | **Browser / computer-use as substrate primitive** | A "browser cell" (or pooled service) other cells call by comms | Every cell will want a browser; stop reinventing |
| 6 | **Verifier / quorum primitive** | `cells quorum <prompt> --models=opus,gpt-5.5` returns consensus or surfaces disagreement | Codifies N-way cross-validation as the default |
| 7 | **Long-running task queue** | "Park this work, come back to it" — externalized so cells can hibernate aggressively | Cells stay cheap; work outlives the well |
| 8 | **Per-cell spend + observability** | What each cell costs in tokens / CPU / bandwidth / Worker invocations | Becomes load-bearing at 20+ cells |
| 9 | **Cell federation across machines** | Secure mesh between Macs / remote boxes; transparent peer naming | Mac Mini + GPU box + laptop fleets |
| 10 | **Migration / forking primitive** | `cells fork <name> <new-name>` + structured diff over time | The harness-experiment pattern, generalized |

---

## Context

**What cells is today (2026-05-19):**

Cells is an always-on AI agent runtime. Each cell is an LLM (pi / claude-code / codex) running inside a Linux VM (a *well*). The substrate ships:

- A warm egg pool, pure-asleep, ~95s births
- Per-cell persistent disk, public site at `<name>.cells.md`, a Bearer-gated control plane (`/inbox/append`, `/site/publish`, `/image/upload`)
- Three harnesses with feature parity for talk + main-thread comms (Slack and email already routable to all three)
- A subscription proxy that swaps a shared bearer for the real Anthropic-Max / ChatGPT-codex OAuth tokens
- Lifecycle primitives: birth, sleep/wake, stop, checkpoint, kill — all deterministic

**What's load-bearing but missing:**

- Cells can't talk to each other except by going through a human or a Slack channel
- Every cell has the same `CELLS_PROXY_SECRET`; trust is binary
- Cross-cell knowledge sharing means each cell rebuilds its own RAG layer
- Scrapers and browsers run with the cell's full identity — no isolation for untrusted code
- We can't tell what each cell costs us

The ten primitives below are the answer.

---

## 1. Per-cell identity + scoped capabilities

**What:** Replace the shared `CELLS_PROXY_SECRET` with per-cell keypairs. Each cell gets its own public/private key at birth, registered in a substrate identity service. Calls between cells (and from cells to the operator's services) carry a signed token specifying which capabilities the caller is exercising.

**Why this is #1:** Today, one compromised cell is the whole fleet compromised. A scraper exploit in `nfv-market-cc` could read mother's OAuth refresh tokens by hitting `/debug` with the shared bearer. Until cells have identities, there's no trust gradient, no audit trail beyond IP, and no way to revoke a single cell's access without rotating every secret.

**Shape:**
- Birth ritual issues a keypair, stores private key in the well, public key in `~/.cells/identity/<name>.pub`
- All control-plane endpoints accept either the shared secret (back-compat) or a signed capability token
- Capability tokens are short-lived JWTs: `{ iss: cell_name, exp, capabilities: ["inbox:write:pete-advisor", "site:publish:self"] }`
- The proxy verifies signatures against the public key registry

**Effort:** ~2 weeks. Touches every Bearer check in `cli/worker/`, the proxy, the birth ritual, the kill flow (key revocation).

**Why not just rotate the shared secret per cell:** that's just N shared secrets, not N identities. Need real public-key cryptography for non-repudiation and proper revocation.

---

## 2. Agent-to-agent comms primitive

**What:** Four primitives — `list / send / await / get` — let cells talk to each other peer-to-peer. The `await` semantics give true RPC (sender blocks until peer responds), not just fire-and-forget messaging.

**Why:** Every multi-cell project will need this. Without it, every project re-invents agent-comms in its own shape (file-based / Slack-as-bus / HTTP-direct), or routes through a human. With it, patterns like verifier-cross-check, expert-query, push-notify, propose-vote become *defaults*.

**Status:** Deep-dive at [`agent-comms-primitive.md`](agent-comms-primitive.md). Ready for a team to pick up.

**Effort:** ~1 week for the v1 (envelope + CLI + callback routing + the `kind:"agent"` discriminator). Pattern layer (broadcast, propose, vote) is another week on top.

---

## 3. Shared knowledge layer

**What:** A substrate-level vector store + typed fact graph that cells can publish to and query. Each cell maintains its private state; the shared layer is for facts that have cross-cell utility.

**Why:** Today, every multi-cell project that wants RAG re-imports Stoolap (Pete's pattern) or stands up its own embedding pipeline. When the market cell learns "Liz Heidrick is a Needlerock broker," that fact should live somewhere Pete-advisor and any future home-cell can read without an agent-comms round-trip. Cross-cell chatter is expensive; cross-cell reads are cheap.

**Shape:**
- A "knowledge cell" (special, like mother and pulse) runs the substrate-level Stoolap instance
- Cells publish via `cells knowledge publish <fact-or-doc>`; query via `cells knowledge query <natural-language>` or structured query
- Facts are typed (parcel, person, transaction, listing) with a registry of types maintained in `dna/knowledge/types/`
- Vector search + symbolic facts in the same store (Stoolap supports both)
- Access control via per-cell identity (item 1): cells can scope reads / writes by namespace

**Why a special cell vs an external service:** keeps the substrate self-contained. No SaaS dependency. Cells already know how to talk to other cells once item 2 ships.

**Effort:** ~3 weeks. Mostly type-registry design + the publish/query CLI + the special cell birth flow. Stoolap itself is already built.

---

## 4. Sandboxed execution within a cell

**What:** A nested isolate inside each well for running untrusted code. Scrapers, browser-use, anything that touches external input, runs in the isolate. The cell's full identity (private key, secrets, residential IP attribution) lives outside the isolate; the isolate only sees what's explicitly handed to it.

**Why:** Currently the market cell's Zillow scraper runs with the cell's full identity. A PerimeterX-side exploit could pivot to read `~/.cells/secrets.json` (no, the well's `/root/`, but same principle), exfiltrate cookies for every other site, or use the cell's residential IP attribution to attack Pete's bank. The cell's egress IP is Pete's home IP — that's a load-bearing trust assumption we should defend at the substrate level.

**Shape:**
- `cells run-isolated <command>` — runs the command in a Firecracker-in-the-well, or a gvisor sandbox, or a network-namespaced subprocess
- Isolate has its own filesystem (ephemeral or scoped), its own network namespace, only the capabilities the cell explicitly grants
- For browser-use: a per-task ephemeral Chromium that exits with the isolate
- Capabilities: cells can hand the isolate a one-shot token to call back ("fetch this URL, write to /out, exit")

**Effort:** ~4 weeks. Hardest item in the list because it's real systems work — Firecracker-in-Firecracker is non-trivial; gvisor is lighter but less isolation; namespaces are easiest but weakest. Worth a spike before committing.

**Why this matters more than it looks:** the cells substrate is going to be used to scrape, automate, and act on the open web. Every interaction with untrusted input is a potential pivot point. Sandboxing is the deeper answer than "be careful what you install."

---

## 5. Browser / computer-use as substrate primitive

**What:** A pooled browser service (could be a special cell — "browser-cell") that other cells call via comms (item 2). Other cells request browser tasks; the browser cell maintains the actual Chromium pool, cookie state, residential-proxy rotation, fingerprint warmup, captcha-solver integration.

**Why:** Every cell that scrapes, browses, or does computer-use will reinvent this. Each new scraper means installing Playwright + Chromium + playwright-extra/stealth + cookie management + retry logic. Centralize once; expose via the comms layer.

**Shape:**
- `cells-to browser --await "navigate to <url>, extract <selector>, return text"` (declarative, JSON return)
- `cells-to browser --await "open <url>, take screenshot, return base64"` (visual, for computer-use)
- `cells-to browser --await "warm up session for <domain>, return session-id"` (for cells that want long-running browser context)
- Sessions stored in the browser-cell; cells reference them by id
- Backed by Playwright + a residential-proxy rotation pool

**Composes with:**
- Item 4 (sandboxing): the browser cell itself runs each browser task in an isolate
- Item 1 (identity): the browser cell can scope what URLs a calling cell may request
- Item 2 (comms): how cells invoke it

**Effort:** ~2 weeks for v1 (Playwright + a clean RPC surface). Residential-proxy integration + captcha solving adds another 1-2 weeks but can come later.

---

## 6. Verifier / quorum primitive

**What:** `cells quorum <prompt> --models=opus,gpt-5.5,deepseek` returns either a consensus response or surfaces the disagreement explicitly. Wraps item 2 (comms) into the most useful pattern.

**Why:** IndyDevDan's pi-to-pi demo (PIdETjcXNIk) showed two different-model agents catching 10 corrections by cross-checking. That pattern is currently a custom integration for every project. Codify it.

**Shape:**
- `cells quorum "<prompt>" --models=opus,gpt-5.5,deepseek --consensus=strict|majority|any-flag`
- Substrate spins up (or selects existing) cells with the requested models
- Routes the prompt in parallel
- Returns: `{ consensus: bool, responses: [...], disagreement_axes: [...] }`
- Optional `--judge=<model>` to have a fourth model arbitrate

**Effort:** ~1 week on top of item 2. Mostly orchestration logic; the underlying comms does the work.

**The deeper bet:** *most* decisions a single LLM makes are cheaper to verify than to make. Quorum makes verification the default for anything Pete-affecting.

---

## 7. Long-running task queue / parking

**What:** A substrate-level "park this work and come back to it" primitive. Backed by external storage (host Mac, S3, an addressable persistence well).

**Why:** Today, if a cell starts a 4-hour Stoolap reindex or a 90-minute scrape backfill, the well can't hibernate without losing the work. Pete's wells are RAM-constrained; aggressive hibernation matters. Need a way for cells to park work that outlives their alive-window.

**Shape:**
- `cells park <task-id> --resume-at=2026-05-20T07:00Z --resume-with="bun zillow.ts enrich-all"` (deferred work)
- `cells park <task-id> --on-event=new-listing --resume-with=...` (event-driven)
- Park state lives outside the well — could be in the per-cell Cloudflare Worker DO, or in the operator's mac, or in a special "park cell"
- When the resume condition fires, the well wakes (existing wake-on-message path) and runs the resume command

**Composes with:** item 2 (comms) for event-driven resumes; item 8 (observability) for tracking pending parks.

**Effort:** ~2 weeks. Most of it is the orchestration layer; the wake-on-message path already exists.

---

## 8. Per-cell spend + observability

**What:** A first-class billing/usage view per cell. Anthropic tokens, OpenAI tokens, well CPU minutes, residential bandwidth, Cloudflare Worker invocations, image-CDN bytes.

**Why:** Right now, you cannot answer "what is `nfv-market-cc` costing me per day." The dashboard at `:7881` is shallow. At 20+ cells, the question becomes load-bearing — one runaway cell could quietly burn $.

**Shape:**
- The subscription proxy already sees every LLM token request (it's swapping the auth header). Add per-cell attribution to the proxy's log.
- Welld already knows VM CPU. Add per-cell rollups.
- Per-cell Cloudflare Worker → CF analytics API, scrape into local store.
- Residential bandwidth: from the wells gateway logs.
- Aggregate in a "billing cell" or directly in the dashboard.

**Effort:** ~2 weeks. Mostly plumbing — no novel primitives.

**Why this matters in the long run:** without it, the unit-economics of multi-cell systems are invisible. We won't know when an architectural choice (e.g., embeddings on every cell vs. shared) is justified.

---

## 9. Cell federation across machines

**What:** Cells substrate spans multiple physical hosts. A wireguard-style secure mesh lets cells on Pete's Mac Mini talk transparently to cells on a remote GPU box or another operator's laptop. Cell naming stays flat — peers don't know (and don't care) which hypervisor a peer lives on.

**Why:** Single-Mac topology has a ceiling. Heavy compute (training, big scrapes) wants a beefier host. Always-on cells want the Mac Mini. Personal-context cells want Pete's laptop. The natural growth shape is multi-host.

**Shape:**
- A "federation daemon" on each host runs alongside welld
- Daemons mesh via wireguard (or similar) with mutual auth via per-cell identity (item 1)
- Cell DNS becomes substrate-aware: `nfv-market-cc.cells.md` resolves to whichever host currently owns it
- Cell migration: `cells migrate <name> --to-host=<host>` checkpoint-and-restore across the mesh

**Composes with:**
- Item 1 (identity): mesh auth is keypair-based, not shared-secret
- Item 2 (comms): peer-to-peer comms is host-transparent

**Effort:** ~6-8 weeks. The hardest item after sandboxing. Realistically defer until single-host pain is acute.

---

## 10. Migration / forking primitive

**What:** `cells fork <name> <new-name>` creates a clone, starting from the same checkpoint, with a separate identity. The two evolve in parallel. Structured diff over time lets you A/B compare and either merge or kill one.

**Why:** The harness-experiment pattern (claude-code/opus + pi/gpt-5.5 sibling for the same role) is exactly fork-and-compare. Currently done by hand: birth twice, plant the same brief, compare manually. Make it substrate-native.

**Shape:**
- `cells fork nfv-market-cc nfv-market-pi --harness=pi --model=gpt-5.5` — clones state, swaps harness/model
- Forks are tracked: `cells lineage <name>` shows the family tree
- Diff: `cells diff <name-a> <name-b>` shows divergent state — sites, knowledge contributions, capabilities advertised, recent messages
- Merge: `cells merge <child> --into=<parent>` (rarely useful in agent space, but the primitive exists)

**Effort:** ~2 weeks. Most of the machinery (checkpoint, restore, registry) exists; this is a clean CLI on top.

**Why this matters:** the only way to actually test what different models / harnesses do for a given role is to fork. Forking should be one command.

---

## Priorities & sequencing

If we ship one per quarter, the order is:

**Q1 (now):** Items 1 (identity) + 2 (comms). Identity unblocks comms safely. Comms is the universal primitive everything else relies on.

**Q2:** Items 3 (knowledge) + 5 (browser). Both ride on comms. Both immediately useful for the HomeZero direction.

**Q3:** Items 4 (sandboxing) + 6 (quorum). Sandboxing is the deeper security answer. Quorum is the killer pattern once comms exists.

**Q4:** Items 7 (parking) + 8 (observability). Both become load-bearing at scale. Defer until we feel the pain.

**Later (when warranted):** 9 (federation) + 10 (forking). Both have real value but the single-host single-operator topology has years of headroom.

---

## What we are explicitly NOT building

**A cells marketplace.** People will want to share/sell cell personas. The natural commercialization move. *But* the right shareable unit is the *pattern* (recipe.json, brief.md, prompt + tool surface), not the running agent. Build a pattern library, not a marketplace.

**Autonomous self-modification.** Cells that rewrite their own DNA. Sounds powerful, is mostly a footgun — alignment, debugging, and reproducibility all get harder. Cells can write *adjacent* tools (a market cell writing its own scraper is fine), but the cell DNA itself stays operator-controlled.

**Cell teams as first-class objects.** "The housing team = market-cc + advisor + foreclosure-cell" is tempting but premature. Once we have comms (item 2) + capabilities (item 1), teams emerge naturally as named groups of capability subscribers. Don't bake teams into the substrate as their own type until we see what naturally accretes.

**Cross-operator trust.** Federation (item 9) is between machines *owned by one operator*. Federating with another operator's cells is a category of problem entirely on top — operator identity, legal context, billing splits, abuse handling. Out of scope for the substrate; will be its own product layer if it ever happens.

---

## Open questions

- **Should the knowledge layer (item 3) be one substrate-level store, or one per "team"?** A single store is simpler; per-team avoids leakage across logically-unrelated projects. Probably start with one, namespace by capability.
- **Browser cell (item 5) — substrate-level singleton or per-team instance?** Singleton is cheaper, multi-tenant; per-team avoids one project's scrape backfill starving another. Probably start with singleton.
- **Per-cell spend (item 8) — substrate-bundled or external (Honeycomb, Datadog)?** Substrate-bundled keeps the system self-contained; external gets better tooling for free. Probably substrate-bundled with an export path.
- **Migration across hosts (item 9) — live or stop-the-world?** Live is fancy and fragile. Stop-the-world (hibernate → checkpoint → ship → restore) is what we'd do for v1.

---

*This doc is the umbrella. The agent-comms primitive (item 2) is the next thing to build, and its spec is at [`agent-comms-primitive.md`](agent-comms-primitive.md). Everything else here is for arguing about priorities, not for picking up tomorrow.*
