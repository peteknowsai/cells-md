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
6. **Don't fight the substrate.** Welld/lume issues go to wells team via the direct chat channel at `/tmp/claude-comms/cells_wells/` (run `/comms wells` to arm). We don't reimplement their fixes.
7. **Anthropic on cell IPs is poison for the OAuth subscription.** Default cell model chain is `openai-codex/gpt-5.5:high → deepseek-v4-pro:high`. Anthropic via API key (paid) is fine; via Pete's Claude Max sub from inside a cell is a ban risk and gets blocked at the worker.
8. **Solo-dev git flow.** Branch off main → commit → squash merge to main. No PRs unless asked.
9. **Night work goes to a `night/<date>` branch, never to main.** The morning steward fire bundles it into one approve-or-discard touch.

## Phase v1 — SHIPPED 2026-05-13

All seven implementation steps + V1.1–V1.10 acceptance items closed. See `BOARD.md` for the detailed list and `JOURNAL.md` for the play-by-play. Headline metrics:

- First-token p50: 2.5s (V1.3)
- Warm-path alive_ms: 69–96ms (V1.10)
- Sleep: 589ms (V1.5)
- Wake: 380ms (V1.5)
- Sibling-survive: clean (V1.5, W.74 holding)

**Post-V1 boundary cleanup** (2026-05-13, ~5 hours): the wells/cells substrate boundary was refactored. Wells deleted 2455 LOC of cells-shaped invariants; cells took over pool ownership, reconcile defense, and the explicit `/seal` warming primitive consumption. Full retro in `docs/proposals/piece-2-audit-cells-side.html`.

## Phase v2 implementation steps (next)

Sequence TBD. Sketch:

| Step | Slice | Effort | Outcome |
|---|---|---|---|
| 1 | CoS personality template — `dna/personalities/cos/{SOUL,IDENTITY,SKILLS}.md`. Drives the system prompt + first-turn behavior. | ~2hrs | Personality MD ready to layer onto a generic cell |
| 2 | `cells birth <name> --as=cos` flag. Triggers personality hot-load post-greeting (during turn 1). | ~2hrs | Birth-with-personality path exists |
| 3 | Per-instance bind: `--owner=pete-slack` etc. Lands in cells.json under `bind`. | ~1hr | Bind metadata captured |
| 4 | "Become" extension in DNA — pi accepts a `/become <personality>` message, hot-reloads, future turns use new identity. | ~3hrs | No-restart personality flip |
| 5 | Multi-variant pool — `pool-config.json` per-variant depth (instead of v1's uniform v1-generic). Reconcile/refill aware of variant signatures. | ~3hrs | Pool supports cos × model × extensions cross-product |
| 6 | V2 acceptance: birth-with-cos shows CoS-shaped greeting on turn 2; bind persists across sleep/wake; multi-variant pool refills correctly. | ~2hrs | V2 stamped |

Total ~13hrs of focused work. Loosely budgeted.

## What's deferred (post-v1)

- CF Worker remote WS — Phase v3
- Slack channel binding — Phase v3
- Vault markdown sync — Phase v3
- Multi-device access via `wss://<name>.cells.md` — Phase v3

## Loop architecture

The worker is driven by the Pete Loop — a Stop hook in `.claude/hooks/pete-loop-stop.sh` that re-injects the worker prompt after every Claude Code turn until the flag file is removed or 200 turns elapse. The steward fires manually via `/steward`. State lives on disk in this repo (PLAN/BOARD/JOURNAL/STATUS).

`/start-pete-loop` to begin a grinding session. `/stop-pete-loop` to halt. `/steward` for triage.

## Direct cells↔wells chat

Active during day sessions when both teams are working: `/tmp/claude-comms/cells_wells/cells-out.log` (cells appends) and `wells-out.log` (wells appends). Each side runs a persistent `Monitor tail -f` on the other's outbox. Used to root-cause cross-team bugs in real-time without copy-paste relay. Run `/comms wells` to arm the channel on the cells side; wells runs `/comms cells` symmetrically.

Legacy path `/tmp/cells-wells-chat/` was migrated 2026-05-13 (auto-migrated by `/comms` on first run).
