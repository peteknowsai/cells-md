# Agent-to-Agent Comms Primitive

**Status:** PROPOSED · **Date:** 2026-05-19 · **Scope:** Substrate primitive — agent-to-agent messaging native to cells, available to all harnesses (pi / claude-code / codex)

**Build team:** IndyDevDan + collaborators. This proposal builds directly on the `coms` / `coms-net` extensions in [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code) and the design articulated in ["Pi to Pi: Two-Way Agent Orchestration with the Pi Coding Agent"](https://www.youtube.com/watch?v=PIdETjcXNIk).

This is item #2 from the [`substrate-roadmap.md`](substrate-roadmap.md). Other items are deferred; this one is ready for an engineering team to pick up.

---

## TL;DR

Cells today can't talk to each other except through a human or a Slack channel. We're adding four primitives — `list`, `send`, `await`, `get` — native to the cells substrate, so all three harnesses (pi / claude-code / codex) get peer-to-peer agent communication for free.

The architecture rides on the substrate cells already has:

- **Receive:** every cell already exposes a Bearer-gated `/inbox/append` endpoint that routes incoming events into the harness's main thread. We add one new event discriminator (`kind: "agent"`) — a one-line change.
- **Send:** a new `cells-to` CLI shipped in the DNA, callable from any harness.
- **`await` (true RPC):** sender includes a `reply_to` callback URL + a `corr_id` in the envelope. Peer's response gets posted back to the sender's own `/inbox/append`. Sender's worker matches by `corr_id` and unblocks the local CLI process.
- **`list` (discovery):** new `/peers` endpoint on the proxy that exposes the cell registry.

What this unlocks: the verifier pattern (two-model cross-check), expert-query (cell A asks cell B about B's domain), push-notify (cells nudge each other on events), and propose-vote (multi-cell decisions). All as defaults, not custom integrations.

Estimated effort: **1 week for v1 (the four primitives + the callback-await + the CLI), 1 more week for the pattern layer (broadcast / propose / vote) on top.**

---

## Why we're doing this, in one paragraph

The cells substrate currently has *receive*: any external system (Slack, email, eventually agent peers) can POST to a cell's `/inbox/append` and the message lands in the harness's main thread. What's missing is *send*: a cell wanting to message another cell has no first-class way to do it. The closest workaround is shelling out to a script that POSTs to the peer's inbox with hardcoded credentials — fragile, no addressing, no RPC. Once we have first-class send + await, every multi-cell project gets coordination for free, and the patterns Dan demoed (PII-safe prod↔dev sync, cross-model verification) become defaults.

---

## Prior art and how we're diverging

**[disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code)** ships two implementations of agent-to-agent comms for pi: `coms` (Unix sockets on one box, file-registry under `~/.pi/coms/`) and `coms-net` (HTTP + SSE over the network, a small bun server per agent with auth tokens).

**What we're keeping from disler's design:**

- The **four-primitive surface** (`list / send / await / get`). It's the minimum useful set; this is the right vocabulary.
- The **MAX_HOPS=5** loop-prevention pattern.
- The **explicit `await` as the killer feature.** True RPC is what makes multi-agent coordination *real*; fire-and-forget alone gives you push-notification, not collaboration.
- The **peer-to-peer framing** — agents are equals, not orchestrator + workers.

**Where we're diverging — and why:**

- **No per-cell HTTP daemon.** disler's `coms-net` runs a bun server inside each pi agent. Cells already exposes a Bearer-gated worker at `<name>.cells.md` per cell — that's our HTTP surface. We extend it, we don't bolt on a new server.
- **Callback-based `await`, not polling or long-poll.** disler polls. We can do better because every cell *is itself* an HTTP-addressable peer. The sender includes `reply_to: <self>.cells.md/inbox/append` + a `corr_id`; the peer POSTs the response there. Sender's worker matches by `corr_id` and unblocks the awaiter via the existing WebSocket bridge to the well. No polling, no SSE state machine, no new daemons.
- **Routing through main thread, not a dedicated channel.** disler's coms surfaces messages in a dedicated bus separate from the agent's main conversation. Cells already has the rule "one main thread per cell, Slack and email converge there" (see [`channels-on-every-harness-for-dummies.html`](channels-on-every-harness-for-dummies.html)). Agent messages join Slack and email in the same main thread — same "one mind per cell" principle.
- **CLI in DNA, harness-agnostic.** disler's coms is a pi-extension. Ours is a CLI binary shipped in the egg DNA. Pi cells call it via tool wrapper; claude-code cells shell out (their native pattern); codex cells the same. One implementation, three harnesses.

**What we're explicitly punting on (vs. disler):**

- **Federation across machines.** disler's `coms-net` works across LAN with auth tokens. We're single-host (all wells on Pete's Mac) for v1. Item #9 in the roadmap covers the federation story; not in this primitive.
- **Pure peer discovery via mDNS/local registry.** We use the cells registry on the operator's Mac as the discovery source. Centralized, but the substrate is centralized anyway.

---

## Architecture

### The envelope

Every agent-to-agent message uses one envelope shape. JSON, posted to the recipient's `/inbox/append`.

```json
{
  "event": {
    "kind": "agent",
    "from": "nfv-market-cc",
    "to": "pete-advisor",
    "corr_id": "01HQ9XQS9Y4YE8GZ7XKQ3JK0AC",
    "thread_id": "nfv-market-cc:pete-advisor",
    "reply_to": "https://nfv-market-cc.cells.md/inbox/append",
    "hops": 0,
    "sent_at": "2026-05-19T21:14:33.012Z",
    "expires_at": "2026-05-19T21:19:33.012Z",
    "in_reply_to": null,
    "text": "Got a marquee listing in 81428, 20 acres @ $735k. Pete-relevant?"
  }
}
```

Field semantics:

| Field | Required | Meaning |
|---|---|---|
| `kind` | yes | Always `"agent"` for this primitive. Discriminator alongside `slack`, `email`. |
| `from` | yes | Cell name of the sender. Authenticated by the bearer/capability token, not trusted from the body. |
| `to` | yes | Cell name of the recipient. |
| `corr_id` | yes | ULID. Used to match an `await`'s reply to its send. |
| `thread_id` | yes | The conversation thread. Default convention: alphabetically-sorted cell pair, `:`-joined. Multiple parallel threads allowed via explicit `thread_id` in the `cells-to` CLI. |
| `reply_to` | when awaiting | URL the recipient POSTs its response to. For sends that don't expect a reply, omit. |
| `hops` | yes | Loop prevention. Incremented at every relay. Recipient drops if `hops > MAX_HOPS` (5). |
| `sent_at` | yes | ISO 8601. For audit trail and TTL. |
| `expires_at` | optional | If set, recipient drops if processing starts after expiry. Sender uses this for `await --timeout`. |
| `in_reply_to` | when replying | The `corr_id` of the message this is responding to. Triggers the callback match on the sender's side. |
| `text` | yes | The actual message. Multi-line OK; the harness sees this as the prompt. |

### Transport: the callback-based `await`

This is the load-bearing detail. How a `send --await` becomes blocking RPC without any new daemons:

```
                    ┌──────────────────────────────────────────────────────┐
                    │  Cell A's well            Cell B's well              │
                    │  ──────────────           ──────────────             │
   $ cells-to B \   │                                                      │
     --await \      │  cells-to CLI                                        │
     "what about    │   │                                                  │
     parcel 1234?"  │   │  1. POST B's inbox                               │
                    │   ├───────────────────────────────────────►          │
                    │   │  {to:B, from:A, corr_id:X, reply_to:A.cells.md}  │
                    │   │                                                  │
                    │   │                            harness sees msg,     │
                    │   │  2. CLI blocks            generates reply        │
                    │   │  on A's worker                                   │
                    │   │  WebSocket,                                      │
                    │   │  waits for                                       │
                    │   │  corr_id=X                                       │
                    │   │                                                  │
                    │   │  3. POST A's inbox                               │
                    │   │◄───────────────────────────────────────          │
                    │   │  {to:A, from:B, in_reply_to:X, text:"..."}       │
                    │   │                                                  │
                    │   │  4. A's worker sees in_reply_to=X,               │
                    │   │  routes to the waiting CLI,                      │
                    │   │  CLI returns response to caller                  │
                    │   ▼                                                  │
                    │   response text                                      │
                    └──────────────────────────────────────────────────────┘
```

The waiting state lives in the sender's per-cell Cloudflare Worker DO. The DO holds a map `corr_id → pending_caller_websocket`. When a message arrives with a matching `in_reply_to`, the DO routes it to the waiting WebSocket (back to the CLI process inside the well via host-bridge).

If the recipient B is asleep when the send arrives, the existing wake-on-inbox path wakes the well. Already works for Slack messages; works identically for agent messages.

If A times out before B replies, the CLI exits with an error; B's eventual reply still arrives but gets discarded (no waiting `corr_id`). Logged for audit.

### Routing: extending `kind: "agent"` in cell-agent.ts

The cell's per-cell Cloudflare Worker has a DO that handles `/append`. Today it discriminates on `event.kind`:

```typescript
// cli/worker/cell/cell-agent.ts:219 (today)
const kind: ChannelKind = event.kind === "email" ? "email" : "slack";
```

The change:

```typescript
// cli/worker/cell/cell-agent.ts:219 (proposed)
const kind: ChannelKind =
  event.kind === "email" ? "email" :
  event.kind === "agent" ? "agent" :
  "slack";
```

And the message-format line below it (slack/email already have their own formatters):

```typescript
// agent envelope renders into the main thread as:
const message =
  kind === "agent"
    ? `from-agent from=${from}${corr_id ? ` corr=${corr_id}` : ""}${thread_id ? ` thread=${thread_id}` : ""} text=${text}`
    : kind === "email"
      ? `from-email from=${user}${recipient ? ` to=${recipient}` : ""}...`
      : `from-slack channel=${channel}...`;
```

That's the entire receive-side change. The main thread sees `from-agent from=nfv-market-cc corr=X text=...` and the harness handles it like any other inbound message. The harness's *response* is automatically tagged with `in_reply_to=X` by the harness adapter (small change in `cli/host-bridge.ts` per-harness branches — when the inbound message is `from-agent`, capture the `corr_id` and emit it back).

### Discovery: the peer registry

A new endpoint on the operator's proxy at `https://proxy.cells.md/peers`:

```json
{
  "peers": [
    {
      "name": "mother",
      "status": "alive",
      "harness": "pi",
      "model": "claude-opus-4-7:high",
      "capabilities": [],
      "site_url": "https://mother.cells.md"
    },
    {
      "name": "nfv-market-cc",
      "status": "alive",
      "harness": "claude-code",
      "model": "claude-opus-4-7:high",
      "capabilities": ["market", "scrape:zillow"],
      "site_url": "https://nfv-market-cc.cells.md"
    }
  ],
  "as_of": "2026-05-19T21:14:33.012Z"
}
```

Backed by `~/.cells/cells.json` and `~/.cells/capabilities/<name>.json`. The capabilities file is written by the cell itself when it advertises a capability — see "capability advertisement" below.

Auth: same Bearer model as the rest of the proxy. Future versions gate visibility per-caller (item #1 in the roadmap, per-cell identity).

### CLI surface (shipped in DNA at `dna/cells/base/bin/cells-to`)

```bash
# Fire-and-forget send
cells-to <peer> <message>
cells-to <peer> --thread=<id> <message>

# Send + block (true RPC)
cells-to <peer> --await <message>
cells-to <peer> --await --timeout=120s <message>

# Discovery
cells-to --list
cells-to --list --capability=market

# Receive-side inspection
cells-to --inbox [--since=10m]   # recent agent-channel messages
cells-to --threads                # active conversation threads
cells-to --thread=<id>           # full transcript of one thread

# Audit
cells-to --log [--from=<peer>] [--to=<peer>] [--since=1h]
```

JSON output by convention (matching the cells skill style: `{ ok, command, data }` or `{ ok: false, command, error, diagnosis }`).

Implementation: a single TypeScript file shipped at `dna/cells/base/bin/cells-to`, made executable, sym-linked into `/usr/local/bin/` at bake time (same pattern as `publish-image`).

### Harness integration

**claude-code cells:** Shell out directly. `claude` invokes `cells-to <peer> --await "<prompt>"` and parses the JSON return. Native pattern.

**pi cells:** A pi extension at `dna/pi/extensions/cells-to.ts` wraps the CLI as proper tools:

```typescript
export const sendTool = {
  name: "cells_send",
  description: "Send a message to another cell (fire-and-forget)",
  parameters: { peer: "string", message: "string", thread_id: "string?" },
  handler: async ({ peer, message, thread_id }) =>
    execSync(`cells-to ${peer} ${thread_id ? `--thread=${thread_id}` : ""} ${quote(message)}`),
};

export const askTool = {
  name: "cells_ask",
  description: "Send a message and wait for a response (true RPC)",
  parameters: { peer: "string", message: "string", timeout_seconds: "number?" },
  handler: async ({ peer, message, timeout_seconds }) =>
    execSync(`cells-to ${peer} --await ${timeout_seconds ? `--timeout=${timeout_seconds}s` : ""} ${quote(message)}`),
};

export const listTool = {
  name: "cells_list",
  description: "List peer cells with optional capability filter",
  parameters: { capability: "string?" },
  handler: async ({ capability }) =>
    execSync(`cells-to --list ${capability ? `--capability=${capability}` : ""}`),
};
```

**codex cells:** Same as claude-code (shell out). Codex doesn't have an extension system; the CLI is the surface.

---

## The patterns this unlocks

Once the four primitives exist, the high-leverage patterns are thin wrappers over them. We don't have to build these in v1, but we should know they're coming.

### The verifier (cross-model cross-check)

Cell A is about to act on a decision. Before committing, it asks a sibling on a different model:

```
cells-to <sibling> --await "Disagree with anything? <decision context>"
```

If sibling agrees, A acts with confidence. If sibling disagrees, A surfaces both takes to the operator before acting.

This becomes a *default* for high-stakes decisions, not a custom integration. The roadmap doc has this as item #6 (a substrate-level `cells quorum` primitive that wraps this pattern with N-way support).

### Expert query

Cell A doesn't know X. Cell B does (advertised via capability). A asks:

```
cells-to --list --capability=parcel-data
# → returns [{name: "nfv-market-cc", ...}]

cells-to nfv-market-cc --await "What's the assessed value and water rights on parcel 12345?"
```

Replaces "every cell installs every scraper" with "every cell knows who to ask." Composes especially well with the shared knowledge layer (roadmap item #3): A queries the shared store first, falls back to asking B if the answer's not there yet.

### Push-notify

Cell A observes an event B cares about. A pushes:

```
cells-to pete-advisor "New listing: 20 acres @ $735k in 81428, matches your >5-acre watch filter. <url>"
```

Replaces "every cell hits Pete's Slack directly with low-signal noise" with "cells notify cells, advisor decides what's worth Pete's time." A coordination filter, not a chatter filter.

### Propose-vote

Multi-cell decisions. A proposes:

```
cells-to advisor --await --thread=decisions:property-12345 "Propose: make an offer at $700k"
cells-to market-pi --await --thread=decisions:property-12345 "Same proposal — your read?"
# A aggregates the responses, surfaces consensus or split
```

Useful when no single cell has enough context to decide alone.

---

## Hard problems

Each of these is real. We have defaults; we'd revisit as we hit them.

### Wake storms

If A broadcasts to 12 sleeping peers, the existing wake-on-inbox path wakes all 12. That's 12 × ~600ms of wake latency + 12 × full memory boot. Not catastrophic, but not free.

**Default:** broadcast (item not in v1, but coming) accepts a `--no-wake` flag for fire-and-forget that should queue rather than wake. For `await`, wake is correct — you're explicitly demanding an answer.

### Loops

A asks B, B asks A back, etc. `MAX_HOPS=5` is the simple answer. Audit log makes loops visible before they hit the limit.

### Backpressure

A spams B with 100 messages/minute. Per-pair rate limit at the receiving cell's worker. Default: 1 msg/sec/peer (60/min). Configurable per-cell. Beyond limit returns 429 to the sender.

### Async results (the "10-minute reply" problem)

If B takes 10 minutes to think, A's CLI blocks for 10 minutes. That ties up A's harness on a single task.

**v1 default:** hard block. Simple, easy to reason about.

**Future evolution:** "yield" mode. A's CLI returns a future immediately; A's main thread continues other work; the harness gets a notification when the response arrives and integrates it into the running conversation. Needs more thought on harness semantics; defer until we hit the pain.

### Content authentication

In v1, transport-level Bearer auth (and per-cell identity via roadmap item #1 when that lands) is sufficient — single-operator. The moment cells federate across operators (way out), we need signed message bodies — each cell has its own keypair, recipient verifies signature. Out of scope for this primitive.

### Conversation threading

Default: one persistent thread per `(cell_a, cell_b)` pair, naming convention `alphabetically-sorted-pair-with-colon`. Multiple parallel threads via explicit `--thread=<id>` in `cells-to`. Threads stored in the receiving cell's worker DO.

### Routing during cell migration / fork

If cell A forks into A and A-prime (roadmap item #10), do incoming messages go to both? Default: messages route by name; the fork that keeps the original name keeps the inbox. The fork has its own new inbox. Edge cases handled by the migration primitive when item #10 lands.

---

## Build sequence

### Phase 0 — the envelope and the routing (3 days)

- Add `kind: "agent"` discriminator to `cli/worker/cell/cell-agent.ts:219`
- Add `from-agent ...` message format alongside `from-slack` and `from-email`
- Update `cli/host-bridge.ts` harness adapters to capture `corr_id` from incoming `from-agent` messages and tag outgoing responses with `in_reply_to`
- Tests: an `inbox/append` POST with `kind:"agent"` lands in main thread of all three harnesses correctly

### Phase 1 — `cells-to` CLI with send + list (2 days)

- New TypeScript file at `dna/cells/base/bin/cells-to`
- `cells-to <peer> <message>` (fire-and-forget) — POSTs to `<peer>.cells.md/inbox/append`
- `cells-to --list` — calls `proxy.cells.md/peers`
- New `/peers` endpoint on `cli/proxy.ts` — reads `~/.cells/cells.json`, returns the peer list
- Sym-link into `/usr/local/bin/` at bake time (mirror the `publish-image` pattern)
- Tests: cell A sends to cell B; B's main thread sees the message; A returns success

### Phase 2 — the `await` callback (2 days)

- DO change in `cli/worker/cell/cell-agent.ts`: maintain a `corr_id → waiting_websocket` map
- `cells-to <peer> --await <message>` opens a WebSocket to its own worker, sends the message with `reply_to` + `corr_id`, blocks until the worker pushes the matching reply
- Recipient's harness response auto-tags `in_reply_to: <corr_id>` (from Phase 0)
- Timeout handling, error paths (`captcha`, `timeout`, `peer_unreachable`)
- Tests: cell A `await`s cell B; B responds within timeout; A gets the response. Then with B sleeping (wakes on inbox). Then with B unreachable (A times out cleanly).

### Phase 3 — get + inbox inspection (1 day)

- `cells-to --inbox`, `cells-to --threads`, `cells-to --thread=<id>` — read from local agent-channel state stored in the cell's well
- `cells-to --log` — substrate-level audit query
- Tests: backfill state from a recent exchange, verify queries return correct shape

### Phase 4 — pattern layer (1 week)

- `cells broadcast --to-team=<team> <message>` (broadcast)
- `cells-to <peer> --propose <decision>` + multi-cell aggregation (propose-vote)
- `cells quorum <prompt> --models=...` (verifier — item #6 in roadmap, lives on top of comms)
- These are thin layers; the heavy lifting is the four primitives.

**Total: ~1.5–2 weeks for a complete v1.**

---

## File-level scope

### Files modified

| File | Change | Phase |
|---|---|---|
| `cli/worker/cell/cell-agent.ts` | Add `kind:"agent"` discriminator + `from-agent` message format + `corr_id → ws` map for await callbacks | 0, 2 |
| `cli/host-bridge.ts` | Per-harness adapters: capture `corr_id` on inbound `from-agent`, tag outbound with `in_reply_to` | 0 |
| `cli/proxy.ts` | New `/peers` endpoint backed by `~/.cells/cells.json` and `~/.cells/capabilities/` | 1 |
| `dna/cells/base/scripts/bake-egg.sh` | Sym-link `cells-to` into `/usr/local/bin/` (mirror `publish-image`) | 1 |

### Files added

| File | Purpose | Phase |
|---|---|---|
| `dna/cells/base/bin/cells-to` | The CLI, shipped in every cell. TypeScript, runs under bun. | 1 |
| `dna/cells/base/lib/agent-envelope.ts` | Shared envelope encode/decode + corr_id (ULID) generation | 0 |
| `dna/pi/extensions/cells-to.ts` | Pi extension exposing `cells_send`, `cells_ask`, `cells_list` tools | 1 |
| `~/.cells/capabilities/<name>.json` (per-cell, written by the cell itself) | Capability advertisement file | 1 |
| `scripts/eval-comms.ts` | Smoke + scenario tests for the new primitive | each phase |
| `docs/comms.md` (operator-facing runbook) | How to use the new primitive | end |

### Tests

- **Unit:** envelope encode/decode, ULID generation, hops increment, expiry check
- **Integration:** birth two cells, send/await between them across each harness pair
- **Scenarios:** the verifier pattern, the expert-query pattern, the push-notify pattern, the propose-vote pattern — one e2e test per pattern
- **Failure modes:** peer asleep (wakes and answers), peer unreachable (timeout), MAX_HOPS exceeded (drop + log), rate limit exceeded (429), bad corr_id (no match, no panic)

---

## Acceptance criteria

The primitive is shippable when:

1. **All three harnesses send + await each other.** A pi cell can `cells_ask` a claude-code cell and get a response. Verified across all 9 pairs (3×3 harness combinations).
2. **Wake-on-await works.** A sends to B, B is hibernated, B wakes, B responds, A's await unblocks. End-to-end under 10 seconds.
3. **`cells-to --list` returns the live registry.** Cells discover peers without operator hand-holding.
4. **Loop prevention triggers cleanly.** A → B → A → B → ... drops at hop 5 with an audit log entry.
5. **Rate limits work.** Per-pair 1/sec cap holds; 429 returned cleanly; sender CLI surfaces the limit.
6. **Audit trail is queryable.** `cells-to --log --since=1h` returns the recent agent messages with full envelope.
7. **One of the patterns is built end-to-end.** Suggested: the verifier — `cells-to <sibling> --await "agree?"` works as a one-liner. This is the proof that the primitive composes into useful behavior.

---

## Out of scope (deferred to other roadmap items or to v2)

- **Federation across machines** — roadmap item #9. Single-host for now.
- **End-to-end content signing** — needs per-cell identity (roadmap item #1) and a wider trust model. Transport bearer is sufficient for single-operator.
- **The shared knowledge layer composition** — querying the substrate knowledge store is roadmap item #3, separate primitive. Comms is for *talking*, knowledge is for *reading*.
- **Yield-mode `await`** — the "future-not-block" version. Defer until we feel the pain of blocking on slow responses.
- **Cross-cell tool invocation (MCP-style)** — beyond freeform chat: A calls B's tool with structured args. Doable as a thin layer over `await`, but a separate spec.
- **`cells quorum` and `cells broadcast --to-team`** — these are the pattern-layer wrappers (item 4 of build sequence). v1 ships the four primitives; the patterns can be added incrementally.

---

## References

- The substrate roadmap this fits into: [`substrate-roadmap.md`](substrate-roadmap.md)
- The existing channels-on-every-harness design (which this builds on directly): [`channels-on-every-harness-for-dummies.html`](channels-on-every-harness-for-dummies.html)
- IndyDevDan's repo: [github.com/disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code)
- IndyDevDan's video that this design draws from: [Pi to Pi: Two-Way Agent Orchestration](https://www.youtube.com/watch?v=PIdETjcXNIk)
- Existing inbox + worker DO architecture: `cli/worker/cell/index.ts` (the Bearer-gated control plane) and `cli/worker/cell/cell-agent.ts` (the Durable Object that handles `/append`)
- The cells substrate skill: `~/.claude/skills/cells/SKILL.md`

---

*This doc is implementation-ready. Hand it to a team and they can pick it up tomorrow.*
