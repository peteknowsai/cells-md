# `cells init` — open design questions

Decisions still up for grabs. Resolve these before the cells team starts building.

---

## 1. Domain default

**Resolved (in part):** `cells.md` is the canonical root for Pete's own use. Pete owns it; new users default to a slice on `cells.md` (e.g., `mito.<your-name>.cells.md`).

`cells.live` is **not available** (registered, status ACTIVE).

**Still open — operational questions on running cells.md as a shared root for other users:**

- **Subdomain claim service.** Need a small service (likely a Worker on cells.md) that:
  - `claim/check?name=alice` and `claim/reserve?name=alice`
  - Tracks reservations in KV or D1
  - Returns a deploy token scoped to that subdomain so the user's `cf` calls only affect their slice
- **First-come-first-served vs verified.** Anyone can grab `pete` if they're first? Or tied to identity (Stripe email, GitHub login, etc.)?
- **Abuse story.** One user runs sketchy cells under their subdomain — reputation impact on the parent zone? Kill switch?
- **Renewal liability.** `cells.md` renewal is on Pete. If users build on `<their>.cells.md` and the parent lapses, they all break.
- **Fork story.** Open-source forks need their own equivalent root. How easy is it to swap?

**Sub-options:**
- BYO domain (user provides one they own)
- Buy via Cloudflare Registrar ($10/yr, automated)

---

## 2. Slack as a hard requirement?

**Resolved:** Recommended-but-skippable. Default tries; skips silently if user isn't workspace admin and surfaces at the end.

**Sub-question still open:** Channel abstraction for Discord/Telegram/etc. — v2.

---

## 3. LLM authentication strategy

**Resolved (final):**

- **OpenAI / ChatGPT Plus is the critical path.** Mito boots on GPT-5.5 via ChatGPT Plus OAuth. The cleanest OAuth flow available today (OpenAI's Codex CLI does it; we copy the pattern), and the most likely subscription a target user has.
- **No Anthropic at boot.** Mito offers to set up Claude Pro auth later, conversationally — same shape as setting up Slack or Convex. Treats Claude as one more thing she can wire up after she's alive.
- **Fallback for no ChatGPT Plus:** inline OpenAI API key paste.
- **No subscription, no key:** exit clearly with subscription/key links. We don't take on Workers AI as a free fallback in v1.

**Reference implementations** for the OAuth pattern: OpenAI's official `codex` CLI, `opencode-openai-codex-auth`, OpenClaw. Already working in `cli/proxy.ts`.

**Why not also do Anthropic at boot:** doubling OAuth flows doubles the floor time and the failure surface. Mito running on GPT-5.5 is plenty for everything `cells init` needs to accomplish. Claude can come later as a chat-driven setup, like everything else non-critical.

---

## 4. wells (cell runtime)

**Resolved:** Local Linux VMs on Mac via wells. macOS arm64, 32+ GB RAM recommended, ~1 GB per live cell, welld on localhost:7878, sprite-compatible REST so cells works unchanged. State at `~/.wells/`, fully local, no external account.

**Eggs deprecated.** Baked images replace them. ~5-second hatches with no pre-warm.

**Still open:**

- **Install method:** brew tap (`brew install cells/tap/wells`) vs curl-pipe-bash vs npm. Likely brew. Affects `cells init` step 3 wording.
- **Daemon lifecycle:** LaunchAgent for auto-start at install (recommended — invisible to user) vs run-on-demand from cells.
- **Hardware warning thresholds:** warn at <32 GB RAM, block at <16 GB? or always allow with warning?
- **Sleep/wake behavior on Mac sleep:** sub-second pause/resume should make it trivial — confirm in wells docs and surface to user if relevant.
- **Multi-Mac:** v1 is one-Mac-at-a-time. `SPRITES_API_URL` already lets you point to a remote welld, so power users can run welld on a Mac mini and connect from a MacBook today.
- **Networking from cell to internet via Cloudflare:** outbound websocket from cell to Worker? cloudflared tunnel from welld? Confirm with the cells team — should be answerable from existing repo.

---

## 5. First cell mandatory?

**Resolved:** Yes — `cells init` ends with Mito alive and chatting with the user. The whole point.

`--no-first-cell` flag for power users who want to configure the platform but defer cell creation.

---

## 6. Idempotency vs resumability

**Resolved:**
- Re-running with the same project: resume from last incomplete step, Mito greets user back
- Re-running with a different project name: error — explain how to resume or start fresh elsewhere
- Existing Cloudflare account in this Stripe: detect and reuse
- Existing domain configured: skip silently, surface in resumption banner

Never overwrite without confirmation.

---

## 7. Multi-machine secrets sync

**Open.** What if a user runs `cells init` on a second machine?

- A. Each machine independent — re-run init on each box (v1 default)
- B. `cells secrets push/pull` — sync vaulted version (v2)
- C. Detect existing `~/.cells/`, prompt to import

**Recommendation:** A for v1; B as a roadmap item. With wells running locally on each machine, multi-machine is interesting because each Mac runs its own welld but shares the Cloudflare/Slack identity.

---

## 8. Detect and adopt existing setup

**Resolved:** Yes — Mito probes for existing config (Cloudflare account, domain, Slack tokens, Anthropic auth, existing welld) and asks "use these existing resources, or create new ones?" Most respectful of existing state.

---

## 9. Fork story / config file format

**Proposal:** `cells.config.toml` at the framework root with init defaults a fork can swap:

```toml
[init]
default_domain_root = "cells.md"
slack_required = false
default_llms = ["anthropic", "openai"]
default_anthropic_model = "claude-opus-4-7"
default_openai_model = "gpt-5.5"

[init.cos]
name = "mito"                              # forks swap this
dna_path = "proto/cos-mito"                # where stock dna lives
personality = "capable, terse, dry"

[init.slack]
manifest_path = "scripts/slack-app-manifest.json"

[init.providers]
default_stack = ["cloudflare/workers"]

[init.runtime]
runtime = "wells"
wells_install = "brew install cells/tap/wells"
```

**Sub-question:** Per-user config at `~/.cells/config.toml` to override framework defaults?

---

## 10. v1 surface — what ships

**Must-have for v1:**

- Mito boots and runs the chat-driven install (the magic)
- Anthropic OAuth (critical path)
- Stripe Projects + Cloudflare provisioning
- wells install + welld auto-start
- Mother local setup + `proxy.cells.md` launchd
- Domain claim (cells.md slice, BYO, or buy)
- Resumability + detect-and-adopt
- `--no-prompt` headless mode
- `--no-chat` silent-wizard fallback for users who'd rather

**Could be v1.1:**

- Slack — recommended, but if not ready, ship without and add as next iteration. Losing Slack loses a lot of magic; aim to ship in v1.
- Multi-machine secrets sync
- `cells.config.toml` fork story (could hardcode for v1)
- Workers AI as a free LLM fallback for users without Pro subscriptions

**Definitely v2:**

- Subdomain claim service for `cells.md` multi-tenant
- Channel abstractions (Discord/Telegram)
- Multi-Mac wells coordination (synced cell state across machines)

**Recommendation:** Aim for "the chat-first install + all 8 steps + resumability + adoption" in v1. That's the magical surface.

---

## 11. Mito's stock dna

**New question.** Mito ships with stock `IDENTITY.md`, `SOUL.md`, `TOOLS.md`. What goes in each?

**Open:**
- **Personality voice:** terse + capable + slightly dry to match cells aesthetic. How dry? How terse? Worth a short style guide example.
- **Tools at birth:** what does Mito have on day one? At minimum:
  - Talk to mother (for cell lifecycle ops the user requests)
  - Memory (already standard for cells)
  - Slack send/receive
  - Email send/receive
  - Web search
  - File system on her well
- **Skills at birth:** common asks she should be ready for — "spin up a team that does X," "summarize my inbox," "remind me about Y."
- **Memory bootstrapping:** anything the user mentions during install should auto-save as a `user_*` memory so Mito remembers it next session.
- **First-message hook:** Mito's opening line on first run. Match the cells voice. Short.

**Resolved:** Mito runs on `gpt-5.5` at **medium thinking**, fixed at install. No model or thinking-level picker. Forks can override via `cells.config.toml`.

**Recommendation:** Have someone on the cells team draft IDENTITY.md / SOUL.md / TOOLS.md with the cells voice. Start small — Mito doesn't need 50 tools on day one. Memory + Slack + email + cell lifecycle is plenty.

---

## 12. The chat surface during install

**New question.** When Mito takes over the chat surface during install, what does that look like technically?

- Pi running in TUI mode in the same terminal where `cells init` was invoked?
- Mito boots and her standard talk surface inherits the terminal?
- Special "install mode" with a slimmer UI than `cells talk`?

**Recommendation:** Use the existing `cells talk mito` surface — same code path. The install just transitions into it once Mito is alive. Same surface used for ongoing chat. One less thing to build.

---

## 13. Anthropic OAuth — when and how

**Resolved.** Anthropic is not at boot. Mito offers to set it up later, in conversation. Same flow shape as Slack/Convex.

If a user mentions wanting Claude/opus, or asks Mito for a workload that benefits from Claude (e.g., long-context reasoning), she can offer:

> "want me to wire up Claude Pro auth so I can use opus for that?"

User approves the OAuth tab; Mito captures it; she switches model for the right workloads going forward.

This keeps Mito's first-run path single-OAuth (ChatGPT only) and treats Claude as a non-critical extension — consistent with how we treat everything else outside the critical path.
