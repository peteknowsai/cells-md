# `cells init`

Design notes for the bootstrap command that turns a fresh Mac into a working cells stack.

This folder is the working spec. The cells team will build from here.

## Files

- **README.md** (this file) — vision, architecture, dependency inventory, principles
- **ux_walkthrough.md** — the mocked conversational session
- **open_questions.md** — design decisions still open

---

## Vision

**Setup IS the first conversation with your chief of staff.**

A new user runs `cells init` on a fresh Mac. ~60 seconds later — gated mostly by one ChatGPT Plus OAuth approval — **Mito** comes alive in the terminal, running on GPT-5.5. She runs the rest of setup conversationally while they chat. At the end there's no "wizard finished, now go do something." Setup just *was* meeting Mito.

This is the 10x version of an installer:

- **Concept compression.** Setup and first-agent-meeting are one thing.
- **The agent is load-bearing immediately** — not an output of setup, the *medium* through which setup happens.
- **The user's first 5 minutes are talking to an agent**, not approving prompts in a wizard.
- **Setup uses the same conversational surface as everything else.** "Add a cell," "fix this," "what's broken" — all the same shape. Setup stops being a special case.

## Stock chief of staff: Mito

**Mito** (mitochondria — "the powerhouse of the cell"). Action-oriented, on-theme with the cells biological vocabulary. Comes ready, no choices to make:

- **Name:** Mito. Fixed. (Forks can override via config.)
- **Personality:** capable, terse, action-first, slightly dry. Cells aesthetic.
- **Model:** `gpt-5.5` on **medium thinking**. Fixed at install. (Mito can switch later if user adds Claude.)
- **Identity baked in:** stock `IDENTITY.md`, `SOUL.md`, `TOOLS.md` ship as part of the cells package and are imaged into Mito's well during init.
- **Role:** the user's primary interface. Dispatches to mother behind the scenes for cell lifecycle work. Holds the user's context, memory, and ongoing relationship.

**Principle:** as few levers to pull as possible to get to "hello from mito." No model picker, no thinking-level picker, no skill picker. She just is.

The user doesn't see mother. Mother is invisible plumbing.

## Architecture grounding (from reading the cells project)

After reading `proto/mother/`, `docs/agency.md`, and `docs/eggs.md` (the latter being deprecated):

- **Mother is the protocell.** Lives at `~/Projects/cells/proto/mother/`, on Pete's Mac, not on a Well. Invoked print-mode per cells command. Has lifecycle authority: `well_create`, `well_destroy`, `well_checkpoint`, `well_exec`. Owns OAuth state for Claude Pro + ChatGPT Plus and runs the `proxy.cells.md` launchd service. **Not a chat partner.**
- **Mito = first cell born during init**, with stock dna shipped in the cells package. Architecturally just a cell; functionally the user's CoS.
- **Eggs are deprecated.** The old egg pool pre-warmed wells before birth. With wells (local, controlled) and baked images, hatching is ~5 seconds — no pre-warming needed. cells_init never has to think about eggs.
- **Wells boot from baked images.** Different agent variants come from different images, instantly available.
- **Local-first thesis** (see `agency.md`): cells run on owned hardware. ~8 alive on a 48GB Mac, hundreds durable on disk via cooperative pause/resume. Self-managing agents own their lifecycle. cells_init aligns with this — local-first, user owns the box.

## Three tiers of friction

Useful frame for what gets provisioned and how.

### Tier 1 — Magic (Stripe Projects)
One OAuth, many provisions:
- Cloudflare account + API token
- Clerk auth (in catalog)
- Future paid services billed via Stripe

### Tier 2 — Smooth (cells init drives each auth)
Provider has its own auth, but the install handles it:
- Anthropic Claude Pro/Max OAuth (already implemented in `cli/proxy.ts`)
- OpenAI ChatGPT Plus/Pro OAuth — same pattern (already implemented)
- wells local install
- Convex (lazy — only when an agent first publishes)
- Mother local setup (state dir, launchd registration)

### Tier 3 — Manual but guided
- Slack workspace (admin required; manifest applied)
- Optional API keys (Gemini, Exa, DeepSeek) — deferred to first use

### Lazy provisioning
Anything not on the critical path defers. The user's first run only auths what's needed for Mito to be alive and functional.

## Dependency inventory

### Cloudflare (Tier 1)
- Account ID + API token via Stripe Projects
- Workers: per-cell HTTP bridge, shared Slack worker, shared email worker
- KV namespace `CHANNELS` (channel ID → cell binding)
- Email Routing on chosen domain (DKIM/SPF verified)
- Custom domains and DNS records for `<cell>.<root>`, `slack.<root>`, `email.<root>`

### Domain (Tier 1, see open_questions Q1)
- Root domain where cells live
- Default for Pete: `cells.md` (he owns it)
- For other users: TBD subdomain claim service, BYO, or buy via Cloudflare Registrar

### wells (Tier 2, required)
- macOS arm64 (Apple Silicon required)
- 32+ GB RAM recommended (~1 GB per live cell)
- Bun+TS daemon `welld` on `localhost:7878`
- Vendored Swift `lume` binary wrapping Apple's Virtualization.framework
- Linux guest VMs (Ubuntu 25.10 arm64) — stateful, sub-second pause/resume
- Sprite-compatible REST — cells code works unchanged with `SPRITES_API_URL=http://localhost:7878`
- State at `~/.wells/`, fully local, fully open source
- Status: v0.1.0 tagged 2026-05-06; cells team Phase B integration in flight
- Install method: TBD — likely `brew install cells/tap/wells`

### OpenAI / Codex (Tier 2, **critical path**)
- ChatGPT Plus/Pro OAuth (default — rides subscription, no API billing)
- API key fallback
- Already implemented in `cli/proxy.ts`
- Reference implementations: OpenAI's official `codex` CLI, OpenClaw, `opencode-openai-codex-auth`
- **Critical path** — required before Mito can think; the only OAuth at boot. Cleanest OAuth flow available today, so we default here.

### Anthropic (Tier 2, deferred — Mito offers it later)
- Claude Pro/Max OAuth (rides subscription, no API billing) or API key
- Already implemented in `cli/proxy.ts`
- **Not on critical path.** Mito offers to set this up after she's alive, same shape as Slack or Convex. Useful if the user wants Claude/opus for some workloads.

### Mother (Tier 2, local protocell setup)
- Lives at `~/Projects/cells/proto/mother/`
- State at `proto/mother/state/` (memory, etc.)
- Print-mode per cells command (no long-running process)
- Owns OAuth state, runs `proxy.cells.md` as launchd
- Has the `birth` skill at `.pi/skills/birth/`

### Mito (the stock chief of staff)
- First cell born during cells_init via mother's birth skill
- Stock dna shipped in the cells package
- Lives in a well on the user's local Mac
- Reachable at the apex of the user's domain slice (e.g., `mito.pete.cells.md`, or just `mito.cells.md` if root)
- Has tools to dispatch to mother when she needs cell lifecycle ops on the user's behalf

### Slack (Tier 3, recommended)
- Workspace + admin
- App from `scripts/slack-app-manifest.json`
- 5 tokens: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_ID`, `SLACK_APP_CONFIG_TOKEN`

### Convex (Tier 2, lazy)
- Provisioned via `convex` CLI on first publish from an agent
- OAuth → deployment URL + deploy key

### Optional LLMs (Tier 3, lazy)
- Gemini, Exa, DeepSeek — auth requested only when a feature needs them

### Local tools
- Bun, wells, cf, stripe (with projects plugin), convex (lazy)

### Local state files
- `~/.cells/secrets.json` — collected credentials
- `~/.cells/cells.json` — fleet roster (managed by Bun CLI; mother only reads)
- `~/.wells/` — wells local state
- `~/.pi/agent/auth.json` — OAuth state used by `proxy.cells.md`

## Design principles

1. **Setup IS conversation, not a wizard.** Status output for ~8 seconds while Mito boots, then chat.

2. **Magical defaults, escape hatches via flags.** No menu of options. `--no-slack`, `--anthropic-key`, `--no-prompt` for power users.

3. **Silent degradation, not prompts.** Can't install Slack? Skip and surface at the end. Can't auth ChatGPT? Use Claude only. Never block on a decision the user didn't ask to make.

4. **Mother is invisible. Mito is the relationship.** The user sees Mito; Mito dispatches to mother.

5. **Stock Mito comes ready.** No "name your CoS" prompt, no model picker, no skill picker. She just is. Customization is post-init.

6. **Stripe Projects is the kickoff key.** First credential the user provides, bootstraps everything in the Stripe Projects catalog.

7. **Resumable.** Crash mid-init? Re-run. Mito greets the user back; setup picks up.

8. **Fork-friendly.** Defaults live in `cells.config.toml`. A fork swaps the stock CoS, the domain root, the LLM defaults; the flow stays the same.

9. **No mystery state.** Every credential is in `~/.cells/secrets.json`, redacted-viewable via `cells secrets list`.

10. **Setup uses the agent surface.** Same code path used for "add another cell" or "diagnose what's broken" later. Setup is not a special case.

## What `cells init` actually does (sequence)

The critical path is short on purpose. Everything that *can* be deferred to after Mito is alive *is*.

1. **Pre-flight (silent):** install Bun if missing
2. **ChatGPT Plus OAuth — the only blocking step:** open browser tab, user approves; capture token. Required before Mito can think.
3. **Install wells locally:** download/build wells, register `welld` as LaunchAgent. Pre-fetch Mito's image in parallel during the OAuth wait.
4. **Initialize mother:** ensure `proto/mother/state/` exists, wire OAuth via the captured ChatGPT credential
5. **Mother births Mito** from the stock baked image (~5 seconds)
6. **Hand chat surface to Mito.** Terminal becomes Mito's chat.
7. **Mito narrates and runs the rest** while user can chat:
   - Stripe Projects OAuth + Cloudflare provisioning
   - Domain claim/BYO/buy
   - Slack app install (best-effort)
   - `proxy.cells.md` launchd registration (after Cloudflare is up)
8. **Mito offers a brief tour** and is ready for instructions. If the user wants Claude/opus, she offers to drive the Anthropic OAuth then.
9. User stays in conversation or `/q` to exit; `cells talk mito` to come back.

**Floor: ~60 seconds to "mito: hey pete."** Most of that is the OpenAI OAuth approve.

## Existing scripts cells_init orchestrates

- `cli/cells.ts cmdBirth()` — birth flow
- `proto/mother/.pi/skills/birth/SKILL.md` — mother's birth ritual
- `scripts/slack-app-apply.sh` — slack manifest application
- ~~`scripts/configure-cell-proxy.sh`~~ — deprecated for /root cells; pi-ai patches bake into `cell-base`, the proxy secret routes via `well_create --env=...` → `/etc/environment` → `/etc/profile.d/cells-env.sh`. Retained for legacy `/home/well/agent` retrofit only.
- `scripts/register-site-service.sh` — site service registration on a well
- `scripts/deploy-cell-worker.sh` — Cloudflare Worker deploy

cells_init is a thin orchestrator: drives these existing pieces, captures credentials, and hands the chat surface to Mito as soon as she's alive.

## What `cells init` is NOT

- Not a code generator — cells already exists. cells_init configures and provisions.
- Not multi-tenant — runs once per box, for one user.
- Not strongly idempotent — resumable, but creates real-world side effects (paid signups, Slack apps) that aren't reversible. Always confirms before billable steps.
- Not the only path — power users can edit `~/.cells/secrets.json` by hand. cells_init is the magical path for the magic-wanting majority.
