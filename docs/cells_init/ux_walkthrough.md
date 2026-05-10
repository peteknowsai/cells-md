# `cells init` — first-run UX walkthrough

The vibe: type `cells init`, approve one tab, meet Mito in ~60 seconds. Setup IS the conversation with her.

This is the spec for what the experience *feels* like. The cells team builds the orchestration to produce this experience.

---

## Pre-conditions

- A Mac (Apple Silicon, 32+ GB RAM)
- A web browser
- **ChatGPT Plus or Pro** (the one hard requirement — Mito boots on GPT-5.5 via Codex OAuth)
- A Slack workspace where you're admin (recommended, not required)

That's the entire pre-flight. Everything else — Cloudflare, the domain, wells, Bun, Anthropic auth (if you ever want Claude), Stripe, Slack — Mito sets up after she's alive.

---

## The session

```
$ cells init

   welcome to cells. one tab to approve, then meet mito.

   ⠋ chatgpt plus     ↗ approve in browser    ✓
   ⠋ wells installing                          ✓
   ⠋ booting mito                              ✓ 5s

   ─────────────────────────────────────────────────

   mito: hey pete. (got your name from git — say so if it's wrong.)
         I'm mito — your chief of staff. running on gpt-5.5.
         I'll set up the rest of your platform while we talk.
         ignore me while I work, or ask anything.

   mito: opening 2 tabs:
            ↗ stripe        (cloudflare provisioning)
            ↗ slack         (so I can chat with you there too)
         approve when they pop.

   you: what's stripe doing here

   mito: stripe is the credential wallet. one sign-in and I provision
         your cloudflare account through it — no manual token-pasting.
         it's also how billing works if you ever want paid services.

   mito: ✓ cloudflare provisioned
   mito: ✓ pete.cells.md DNS wired
   mito: ✓ slack app installed in your-team.slack.com

   mito: setup's done. things you can ask me:
            "spin up a team that researches X"
            "summarize my email"
            "remind me about Y at 3pm"
            "set up claude pro auth too" (if you want me on opus)
         or just chat. /q to leave; `cells talk mito` to come back.
```

**~60 seconds from `cells init` to "mito: hey pete."** The rest happens in conversation while you talk.

---

## Why ChatGPT Plus is the only up-front requirement

Mito needs an LLM to think. ChatGPT Plus has the cleanest OAuth flow available right now (OpenAI's official Codex CLI does it; we copy that pattern). One tab, ride your subscription, no API charges.

Anthropic could be added later, but for v1 we don't take on a second OAuth flow at boot. Mito offers to set up Claude Pro auth herself if the user wants it — same shape as setting up Slack or Convex.

---

## Opinionated defaults (no prompts)

- **Chief of staff name:** mito. Fixed.
- **Mito's personality and skills:** stock dna shipped with cells.
- **Initial model:** gpt-5.5 on medium thinking, via ChatGPT Plus OAuth. Fixed. (Mito can switch later if user adds Claude.)
- **Domain:** `<your name>.cells.md` for cells.md root, or `--domain` to BYO.
- **Subdomain pattern:** Mito at the apex; new cells at `<name>.<your-root>`.
- **wells:** install silently, daemon as LaunchAgent.
- **Convex:** deferred. Provisioned only when an agent first publishes.
- **Anthropic:** deferred. Mito sets it up if asked.
- **Eggs:** gone. Baked images make hatch ~5s.

---

## Silent edge case handling

| Situation | What happens |
|---|---|
| No ChatGPT Plus | Inline ask for OpenAI API key |
| No ChatGPT Plus AND no API key | Exit clearly: "Subscribe at chat.openai.com or grab a key at platform.openai.com." |
| Not admin of any Slack workspace | Skip Slack, mention at the end, link to wire up later |
| Already have a Cloudflare account | Detect, reuse silently |
| Subdomain on cells.md taken | Inline retry: "name's taken — try another?" |
| Apple Silicon check fails | Hard stop with a clear message |
| RAM under 16 GB | One-line warning, ask to continue |

---

## Power user escape hatches (flags only)

```
cells init                                # the magical default
cells init --no-slack                     # skip slack inline
cells init --domain mything.com           # BYO domain
cells init --openai-key sk-...            # skip OAuth, use API key
cells init --no-prompt                    # CI; everything via flags/env
cells init --no-chat                      # silent wizard mode
```

`--no-chat` falls back to a status-bar wizard. Mito still gets born; she just doesn't narrate. For users who'd rather things complete silently.

---

## Resumability

Init died mid-way? Re-run. Mito reads `~/.cells/secrets.json` and probes existing resources, picks up where she stopped.

```
$ cells init

   welcome back. resuming setup.

   ⠋ chatgpt plus already authed             ✓
   ⠋ wells already installed                  ✓
   ⠋ mito already alive                       ✓

   ─────────────────────────────────────────────────

   mito: hey pete. picking up where we left off.
         I've got your cloudflare account and pete.cells.md wired.
         still need: slack.

         opening:
            ↗ slack
         approve when ready.
```

Same conversation surface, no wizard-step framing.

---

## Failure modes

| Failure | Message |
|---|---|
| No internet | "Can't reach OpenAI. Try again when you're online." |
| Not Apple Silicon | "wells needs Apple Silicon. cells can't run locally on this machine." |
| RAM under 16 GB | "You have <N> GB. Cells use ~1 GB each — tight. Continue? [y/N]" |
| ChatGPT auth fails | "Couldn't auth ChatGPT Plus. Paste an OpenAI API key, or rerun with `--openai-key`." |
| No subscription, no key | "You need a ChatGPT Plus subscription or an OpenAI API key. Subscribe at chat.openai.com or get a key at platform.openai.com." |
| Subdomain taken | "<name>.cells.md is taken. Try another?" |
| welld can't start | "Port 7878 in use. Check `lsof -i :7878`." |
| wells install fails | "Wells install hit an error. Often `xcode-select --install` fixes it. Re-run after." |

---

## What success looks like

A first-time user goes from `cells init` to "I'm chatting with Mito and she's setting up my whole stack" in under a minute. No docs lookups. No wizard. Just one tab approval and a conversation.

That's the bar.
