# Colony skill — design log

Notes captured while walking the first example colony, with Pete acting as user and Claude playing Creator. Source material for backfilling the part files (decompose.md, cast.md, kit.md, name.md, style.md, wire.md, repos.md, bringup.md, plus capabilities/ and patterns/).

## Decisions locked before the conversation started

- `cells create colony` is the entry point. Naming happens *in* the conversation, not as an argument.
- Creator runs on `claude-code` + Opus 4.7 + max effort. Ephemeral; hibernates after handoff.
- Creator communicates in text **and** pix diagrams. Diagrams live in `design/*.png`.
- Repo per artifact under `pete/<colony>-<artifact>`. Mito's repo is `pete/<colony>`. No GitHub orgs.
- Submodule-free: Mito's repo holds `artifacts.json` as the index.
- Pi's library of skills/packages/extensions is canonical. Other harnesses are ports/adapters.
- Mixed-harness pods are encouraged (designer/engineer/PM pod for the portal is the canonical example).
- Each cell gets a portrait (pix-generated), consistent within colony via a locked `portrait.template`.
- Style phase comes after cast (Creator knows who's in the colony before proposing visual identity).

## Phase-by-phase notes

(Populated as we walk through them.)

### decompose

**Example colony: port of `~/Projects/archived/jurypool`.**

Source shape: pi extension. Foreman (Sonnet) orchestrates 9 jurors (Haiku) on sprites. `deliberate` tool fans out, jurors return takes, Foreman synthesizes. Each juror has its own memory + dream cycle. TUI-only.

Cells shape (in progress):
- **Foreman** = colony's CoS. Pi harness. Ports same TUI widgets from original jurypool extension. Subsumes the orchestrator role; no separate "Mito + Foreman" split.
- **9 juror cells** = thinker cells (no published artifact). Pi harness each. Personalities ported verbatim from `.pi/agents/`.
- **Memory + dream skills** = port direct from `.pi/skills/memory`, `.pi/skills/dream` — both already pi-canonical.
- **`deliberate` tool** = port the pi extension at `.pi/extensions/jury-pool/` direct.
- Sprites → wells. Free migration.

**Decompose locked — full-upgrade jurypool port.**

Cells in the colony (13 total):
- **Foreman** ×1 — CoS, pi harness, TUI + Slack + email channels
- **Jurors** ×9 — thinker cells, pi harness, persona-driven (Jesus, Buddha, Rumi, Marcus Aurelius, Lao Tzu, Confucius, Tesla, Fuller, Gandhi), each with their own per-juror `<juror>.cells.md` page (free with cells)
- **Portal pod** ×3 — designer + engineer + PM, mixed harnesses, builds the `jury.cells.md` web UI

Artifacts produced:
- `pete/jurypool` — Foreman's repo (the colony)
- `pete/jurypool-portal` — the `jury.cells.md` web UI (portal pod stewards)
- Per-juror web pages on `<juror>.cells.md` (Foreman's repo can hold the templates if shared, else each juror writes its own `site/`)
- Persistent juror memories (live in each juror's well, not in a repo)

Shape: **with-CoS** (Foreman synthesizes). The 9 jurors are pure-thinker. The 3 portal cells are pure-builder.

**Skill discovery #1:** CoS name is per-colony. The skill's SKILL.md assumed Mito is universal — needs softening to "Mito is the stock name; colonies override (jurypool → Foreman)." Backfill into `name.md` when written.

**Skill discovery #2:** Some cells in a colony are *thinker* cells (no artifact, no per-cell repo). The 9 jurors are pure-thinker. The distinction between thinker and builder cells should be explicit in `cast.md` and `repos.md` (thinkers don't get a repo; builders do).

**Skill discovery #3:** **The CoS role is universal; the name is domain-driven.** Mito is a stock fallback only. Jurypool's CoS = Foreman. Film colony = Director. Advisory = Counsel. Captured in SKILL.md with a table.

**Skill discovery #4 (refinement of #3):** **With-CoS and without-CoS are co-equal shapes**, not "default with, sometimes without." Three shapes: with CoS (synthesizer), peer (distinct voices preserved), hybrid (router CoS). Pin in decompose before naming — shapes everything downstream. Updated SKILL.md to make this a fork, not an exception.

**Skill discovery #5: experiment mindset, don't avoid harness/model combos.** Default chain skips Anthropic on cell IPs (fingerprint risk), but that's a *cell-side* rule — claude-code harness routes through the Max subscription proxy and is fine. Lean: use the right harness for the job, not the safest one. Architectural cost of switching harness (e.g., claude-code skips pi extensions) is a real consideration; model bias is not.

**Skill discovery #6: pix for diagrams works, but with constraints.**
- Cloudflare Images caps metadata at **1024 bytes** — pix prompts must stay tight (~600 chars max). Verbose prompts fail at upload time, not at gen time. Bake this constraint into pix usage guidance.
- For architecture diagrams, prompt for: "technical architecture diagram, white background, labeled rectangular boxes with thin gray borders, black arrows" + explicit content. Pix will produce something info-dense and readable. Don't drift into illustration vocabulary ("cute purple cell with...") — that produces the marketing aesthetic.
- **Two media, used together:** pix for diagrams (in-line), HTML for the surrounding doc (cast tables, capabilities matrices, decision log). Each plays to its strengths. Don't try to make pix render dense tables; don't try to make HTML draw boxes-and-arrows.

**Skill discovery #7: `colonies/<name>/` in the cells repo is the canonical local map.** Distinct from `pete/<colony>` on GitHub (Mito's live repo). The map is the cartography — design notes, diagrams, cast, decisions; lives in the cells repo, evolves through Creator + post-hoc edits. The GitHub repo is the colony's *live* home where Mito/Foreman steward day-to-day. Two artifacts, two purposes. Update SKILL.md "repo layout you produce" section to show both.

**Skill discovery #8: NO MCPs — CLIs only.** Cells team's architectural commitment: external integrations (Figma, Linear, Slack, browsers, GitHub) are wired as CLIs against the underlying APIs, not MCP servers. Reasoning:
- **Portability** — CLIs work on any harness that shells out (every harness). MCP needs harness-specific MCP client support.
- **Debuggable** — you can run a CLI yourself in a terminal. MCP tool calls are opaque.
- **Composable** — pipes, grep, jq, redirect. Unix philosophy.
- **Native medium** — cells team already builds CLIs (`cells`, `well`, `pi`, `pix`, `gh`). No parallel infrastructure.

Changes to the colony skill:
- Drop `capabilities/mcps.md`. Add `capabilities/clis.md`.
- Port-candidate vocabulary shifts: "build a `figma-cli`" not "wire figma MCP."
- "Prefer skills + MCPs" guidance becomes "prefer skills + CLIs."
- The base-kit + by-role files need a sweep for any lingering MCP language.

**Skill discovery #9: pix CAN do diagrams, but prompts must be tight.** Cloudflare Images metadata caps at 1024 bytes — pix prompts must stay under ~600 chars or the upload fails (gen succeeds, upload doesn't). Prompt for diagram aesthetic explicitly ("technical architecture diagram, white background, labeled rectangular boxes with thin gray borders, black arrows") — don't drift into illustration vocabulary. Use pix and HTML together: pix renders diagrams, HTML structures the surrounding doc.

**Skill discovery #10: three tiers of visual artifact — and the medium has to match.**
- **Tier 1 — illustrative/brand** (cells gallery, cover art, cell portraits): pix is perfect. Stylized, no dense text needed.
- **Tier 2 — quick architecture sketch** (a rough boxes-and-arrows sense of who talks to whom): pix can do this if you prompt hard for "technical diagram, white background, labeled boxes, arrows" — but text labels are unreliable for dense diagrams, and complex layouts drift.
- **Tier 3 — engineering-doc infographic** (Pete's reference: multi-section operating model with numbered lifecycle cards, open-questions panel, dense crisp labels, palette discipline, inline icons): **HTML + inline SVG**. Pix cannot produce this. Don't try. The visual contract — text fidelity, exact placement, brand-aligned palette — is what HTML/SVG buys you.

Implication for Creator: **the medium choice is part of the design phase output.** Decompose → pix sketch is fine. The final colony operating model belongs in HTML+SVG. The colony map at `colonies/<name>/index.html` is the canonical artifact; pix diagrams are supplementary sketches inside it.

**Skill discovery #11: skill-first, CLI only for external-integration necessity.** Creator's first pass over-loaded kits with CLIs (`figma-cli`, `browser-cli`, `linear-cli` etc.) — the "every integration is a CLI" instinct went too far. The actual rule:
- **Default:** the cell already has filesystem + shell + git from base DNA. Prose work, file work, repo work needs no extra kit beyond a *skill* that teaches how to do the thing well.
- **Add a CLI only when** the work requires API-shaped interaction with a service that has no good skill-only path (e.g., you genuinely need to talk to Linear's GraphQL, or actuate a browser).
- **Don't reach for tooling that "would be nice to have"** — that's how kits balloon and port candidates multiply. Ship lean; add a CLI later if a cell actually needs one.

Concrete on jurypool: designer doesn't need `figma-cli` (designing is judgment + skill + pix); engineer doesn't need `browser-cli` for V1 (can verify via dev-server output); PM doesn't need `linear-cli` for V1 (tracks via a SPECS.md in the portal repo + scratch ring chat). Cut from 8 port candidates to 5, of which 2 are already pi-canonical.

### cast + kit

**Cast locked** (2026-05-16, after trim pass).

| Cell | Harness | Model · Effort | Kit |
|---|---|---|---|
| `foreman` | pi | gpt-5.5 · high | jurypool-extension *(port)*, memory, dream, comms |
| jurors ×9 | pi | gpt-5.5 · medium | memory, dream, persona |
| `portal-designer` | pi | gpt-5.5 · medium | pix, design-system *(port)* |
| `portal-engineer` | claude-code | opus-4-7 · high | nextjs *(port-verify)*, convex-oss *(port)* |
| `portal-pm` | pi | gpt-5.5 · medium | colony-skill |

Dropped from earlier proposals:
- Foreman modes (moderator/elder/socratic) — single neutral synthesis voice
- V2 claude-code/opus Foreman experiment — out of scope entirely
- Email channel — Slack + TUI + portal only
- `figma-cli`, `browser-cli`, `linear-cli` — overreach; skill-first commitment

Web stack: **Next.js + self-hosted OSS Convex** (not Convex's hosted product). Convex provides the realtime subscription layer that backs the portal UI.

**Skill discovery #12 [SUPERSEDED]:** initially thought "portal → CoS wake path" was a colony architectural call. **Wrong** — it's a substrate primitive (see #13). Don't surface it as a colony decision.

**Skill discovery #13: substrate-primitive-first design.** Whenever a colony needs cell-to-cell or external-to-cell communication, **use the existing cells substrate primitives** — don't invent a colony-specific pattern. Pete's framing: "every cell has a Worker/DO for web; it should have an API layer that wakes the cell" — that's a SUBSTRATE feature, not a colony-design feature. Same idea for channels (already there), talk (already there), wake-on-traffic (already there).

Added a "Substrate primitives — use them, don't reinvent them" section to SKILL.md with a table mapping common needs to the right substrate primitive. Creator's discipline: if you find yourself inventing an RPC convention, a wake path, or an integration layer, *flag it as a substrate gap* and stop. Colony design composes primitives — it doesn't build them.

**Substrate gap candidate (not a colony port-candidate):** the per-cell API layer at `<name>.cells.md/api/*`. The web layer exists (Worker/DO serves static `site/public/`); the API layer with wake-on-traffic routing to a cell-side handler is the natural extension Pete's pointing at. Cells team's call whether this exists or needs to be built — not the colony's.

**Skill discovery #14: portal "submit question" is just the cells comms layer.** Portal handler hits Foreman via the cell's API layer (or `cells talk` if API isn't ready); the substrate handles wake-on-traffic. The colony doesn't author a "wake" pattern. Engineer cell figures out the exact API call at build time — not a Creator decision.

### name

### style

### wire

### repos

### bringup

**Bringup executed 2026-05-16 21:44–22:01 — all 13 cells alive.**

Sequence:
1. Precheck (cells doctor, pool list, gh auth) — 30s
2. `gh repo create` × 2 + local scaffolds + push — 90s
3. Birth Foreman — sub-second (warm pool)
4. Birth jurors 1–5 — fast (warm pool)
5. **Memory pressure hit at 5 cells alive** — Mac at ~130MB free, lume can't start new VMs
6. Hibernate all 5 with `cells sleep` — frees ~5GB
7. Birth jurors 6–9 + portal pod, sleeping each immediately after — sub-second per cell
8. Verify web presence for all 13 (HTTP 200 across the board)

**Skill discovery #15: hibernate-on-birth pattern for large colonies.** On a 48GB Mac, you fit ~8 cells alive at once. For a 13-cell colony, you have to hibernate as you go. Add to `bringup.md`:

> If the colony has > 6 cells, **hibernate each cell immediately after birth** with `cells sleep <name>`. Wake them on demand. Birth burns ~1GB per cell of host RAM; if you don't sleep, you'll hit a wall mid-colony with cryptic "lume restore-state failed" errors.

**Skill discovery #16: pool-refill can steal the boot gate.** A background `cells egg refill` consumed the single boot gate (collapsed from 3 under vCPU pressure), blocking my births with "pool is empty" (actually wake_failed). Killed it. For a bringup, **suspend the auto-refill until births are done**, or accept that births might queue.

**Skill discovery #17: `cells talk <cell> "msg"` one-shot is unreliable in non-TTY.** Connection succeeds, prompt is flushed to pi, but agent_end never surfaces to the client. The talk one-shot exits in ~150ms with no output. Worth a cells-substrate bug ticket. Workaround for scripted testing: use interactive `cells talk` or drive pi via `well exec`.

**Skill discovery #18: cells repo's `colonies/<name>/` doubles as bringup artifact.** Map starts as design notes; after bringup it becomes the colony's permanent record. The status pills, cell roster green-dots, and BRINGUP.md in the live repo together form a complete picture: design intent + bringup state + remaining functional work. Other colonies' Creators should leave their colony in this shape.

## Surprises / port candidates

(Things the user wants that don't exist in pi's library yet — these are work to be done.)

