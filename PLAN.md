# Cells — Plan

## Thesis

A fleet of always-on AI agents, each in its own well (a hardware-isolated Linux VM on Pete's Mac), addressable by name. The product wedge is **the magical first-talk experience**: `cells birth` shows a ~3-second progress animation, drops the user into a talk prompt, and the cell genuinely responds via LLM. Every word from the cell comes from an LLM — no canned text. The system "cheats" only at the orchestration layer (cells CLI animation), never at the cell layer (LLM is the only voice).

The substrate (welld, lume, Cloudflare Workers, cloudflared) is somebody else's problem most of the time. Cells's job is the harness, the DNA, the birth ritual, the talk loop, and the agent ergonomics that make a cell feel alive.

## Phases

### Phase v1 — Magical generic cell (current work)

Two birth flows, distinguished by whether the user names the cell:

**`cells birth` (no name)** — the fast magical path. ~3s animation (waking → warming → ready → alive), drop into talk prompt, **the cell speaks first**: introduces itself and asks the user what to call it. User answers, the conversation continues, the name is captured and applied async. This is the wedge demo path. Deterministic critical path, no mother in the loop, LLM-genuine first-token.

**`cells birth <name>` (named)** — the customizable path. After accepting the name, an interactive picker runs in the local CLI (harness, model, personality, channel binding, etc.). Mother then orchestrates the slower, configured birth. Comes back to a talk prompt with the picked configuration. Slower (10–30s) but flexible. Mother stays in this critical path because the choices are turn-by-turn.

Every cell — fast or named — has the same generic identity DNA baked into cell-base. Customization adds layers on top; doesn't fork the base image.

**Acceptance:**

| ID | Test |
|---|---|
| V1.1 | `cells birth` shows the 3-stage animation, drops into talk prompt |
| V1.2 | Cell speaks first via LLM (greeting + name question), user replies, conversation continues |
| V1.3 | Birth-to-first-LLM-token (cell's greeting) ≤ 5s p50 |
| V1.4 | Pool refill: second `cells birth` immediately after first hits warm path |
| V1.5 | `cells sleep` + talk-wakes round-trips |
| V1.6 | `cells stop` + `cells wake` round-trips |
| V1.7 | `cells kill` cleans up wells + registry |
| V1.8 | Two cells coexist; talking to one doesn't affect the other |
| V1.9 | `cells birth bob` runs the picker (harness/model/etc.), routes to mother slow-birth, finishes at talk prompt |
| V1.10 | Pool depth 10 maintained; `cells birth` × 10 in quick succession all hit warm path |

### Phase v2 — Personality + identity layers (next)

When the user wants this cell to *be something* — a Chief of Staff for their workflow, a Researcher, a personal coding pair — we layer that on top of the generic cell. Cell still wakes generic, says "hi" generic, but as the user is typing their first real message, the personality MD streams in. By turn 2, the cell is itself.

- Per-instance bind: name, color, owner identity, channel binding
- Personality templates: CoS first; others as needed
- Hot-reload of personality MD without pi restart (or restart hidden behind first "hi")
- "Become" extension in DNA handles the runtime identity injection

### Phase v3 — Cloud lifecycle polish

- CF Worker reliable WS upgrade (the Phase 5 in old plan)
- Slack channel binding
- Vault markdown sync
- Multi-device access via `wss://<name>.cells.md`

## Architectural principles (locked)

1. **First-talk latency is the metric that matters.** Every shipped feature reports a delta on `docs/perf/birth-to-greeting.md`.
2. **LLM-genuine at the cell layer.** Cells (the orchestrator CLI) can have progress UI, terminal flair, animation. The cell itself only speaks via LLM, never via pre-staged text.
3. **Identity is internal, not user-facing.** "Cell" is what the user interacts with; pi/claude-code/codex/model-name are implementation details. The cell's voice never advertises its harness or model.
4. **Critical path is deterministic; mother is async cleanup.** The birth flow (thaw → mark alive → drop into talk) is straight TS code, no LLM in the loop. Mother runs after the magical moment to ratify and tidy.
5. **Bake everything common, flip switches at birth.** Cell-base ships with all standard extensions, packages, harnesses pre-installed. Birth = use the canned defaults. Customization (personality, bindings) comes from hot-reloads after the user is already talking.
6. **Don't fight the substrate.** Welld/lume issues go to wells team via the direct chat channel at `/tmp/cells-wells-chat/`. We don't reimplement their fixes.
7. **Anthropic on cell IPs is poison for the OAuth subscription.** Default cell model chain is `openai-codex/gpt-5.5:high → deepseek-v4-pro:high`. Anthropic via API key (paid) is fine; via Pete's Claude Max sub from inside a cell is a ban risk and gets blocked at the worker.
8. **Solo-dev git flow.** Branch off main → commit → squash merge to main. No PRs unless asked.
9. **Night work goes to a `night/<date>` branch, never to main.** The morning steward fire bundles it into one approve-or-discard touch.

## Phase v1 implementation steps

Sequenced. Each step is a worker branch + squash to main on completion.

| Step | Slice | Effort | Outcome |
|---|---|---|---|
| 1 | Bake canned generic cell identity into cell-base. New `IDENTITY.md` (cell voice, no harness reference), default `status.json`, default `settings.json` with model chain set and standard extensions enabled. Update bake recipe. | ~1hr | Cell-base has a working canned cell |
| 2 | Refactor `cmdCreate` fast-path: deterministic TS function, no mother in critical path. Background birth promise + foreground animation + await on first-user-send. Auto-name (`cell-<short-id>` or similar). | ~3hrs | Birth flow uses the canned cell, no LLM-routed orchestration |
| 3 | React Ink birth-animation component. `cli/birth-ui.tsx`. 4 stages, ~750ms each, filling dots + label line beneath. Mounts on `cells birth`, unmounts at animation end. | ~2hrs | Visual flair, ~3s of intentional UX |
| 4 | Hibernated cell-base pool. `cells egg refill` keeps 1 hot egg warm. Refill triggered after consumption. | ~3hrs | Birth grabs warm egg from pool, falls back to cold-fork if pool empty |
| 5 | (Optional) Well-rename support via welld API. Egg from pool is renamed to user-facing cell name at birth. If welld doesn't support this cheaply, skip and use egg's pool-name as cell-name for v1. | ~1hr | Friendlier cell names |
| 6 | Live test: `cells birth` from cold start, measure animation timing + first-LLM-token latency. Tune as needed. Capture numbers in `docs/perf/birth-to-greeting.md`. | ~1hr | V1.3 acceptance landed |
| 7 | Run V1.1-V1.8 acceptance items. Bundle any fixes. | ~1-2hrs | v1 acceptance complete |

Total ~11-13 hrs of focused work to ship Phase v1.

## What's deferred (post-v1)

These were in the old plan; v1 doesn't need them:

- Per-variant matrix (old P1.3-P1.13) — variants come back as personality+binding swaps, not as separate eggs
- Phase 1b CLI surface walk on multiple variants — replaced by V1.x acceptance on the canned cell; CLI smoke happens implicitly during V1.5-V1.7
- CF Worker remote WS — Phase v3
- Slack/vault — Phase v3
- Per-cell color theming, in-flight package install, capability-deferred load — Phase v2

## Loop architecture

The worker is driven by the Pete Loop — a Stop hook in `.claude/hooks/pete-loop-stop.sh` that re-injects the worker prompt after every Claude Code turn until the flag file is removed or 200 turns elapse. The steward fires manually via `/steward`. State lives on disk in this repo (PLAN/BOARD/JOURNAL/STATUS).

`/start-pete-loop` to begin a grinding session. `/stop-pete-loop` to halt. `/steward` for triage.

## Direct cells↔wells chat

Active during day sessions when both teams are working: `/tmp/cells-wells-chat/cells-out.log` (cells appends) and `wells-out.log` (wells appends). Each side runs a persistent `Monitor tail -f` on the other's outbox. Used to root-cause cross-team bugs in real-time without copy-paste relay. See `/tmp/cells-wells-chat/PROTOCOL.md`.
