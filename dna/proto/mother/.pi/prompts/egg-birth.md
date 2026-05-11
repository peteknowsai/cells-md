---
name: egg-birth
description: Pre-warm a well into an "egg" — fully-installed, no agent identity yet. The CLI later "hatches" the egg into a named cell in seconds.
---

The user wants to birth an egg. well name (immutable, becomes the egg's
permanent well id): $1

Egg variant (JSON): $2

Parse the JSON. It has these fields:
- `harness` — always `"pi"`. If anything else, abort with a clear error.
- `provider` — pi-ai provider ID. Currently in the registry: `"anthropic"`,
  `"openai"`, `"openai-codex"`, `"deepseek"`. This becomes `<PROVIDER>` in
  the birth-egg ritual.
- `model` — model ID (e.g. `claude-opus-4-7`, `gpt-5.5`). This becomes
  `<MODEL>` in the birth-egg ritual.
- `extensions` — in-tree extensions baked into this egg (any subset of
  `memory`, `mentality`, `wiki`, `dream`). The egg only ships the ones
  listed; hatch won't add any later. `<EXTENSIONS>` substitution.
- `packages` — npm packages baked in (e.g. `pi-web-access`). Same idea as
  birth — installed once during egg-birth so hatch doesn't pay for them.
  `<PACKAGES>` substitution.

**Crucial difference from `cell-create`:** an egg has no identity yet.
The DNA's `__NAME__` placeholder stays untouched in egg-birth; hatch
substitutes the eventual cell name. Same for `__THINKING__` — that's a
hatch-time substitution because thinking level is per-cell, not per-egg.

`<MODEL>` and `<PROVIDER>` ARE baked into the egg at birth time. They
shard the pool — different (model, provider) pairs need different eggs.

## Routing

Same as cell-create: subscriptions-routed providers (`anthropic`,
`openai-codex`) go through the local proxy at `proxy.cells.md`;
direct-API providers (`openai`, `deepseek`) read keys from
`~/.cells/secrets.json`. The birth-egg ritual handles both transparently.

1. Invoke the `birth-egg` skill with these substitutions:
   - `<NAME>` = `$1` (the SPRITE name — used by well_create only)
   - `<PROVIDER>` = the parsed `provider` value
   - `<MODEL>` = the parsed `model` value
   - `<EXTENSIONS>` = the parsed `extensions` array (may be empty)
   - `<PACKAGES>` = the parsed `packages` array (may be empty)

2. **After the birth-egg ritual reports success**, the CLI updates
   `~/.cells/eggs.json` itself — you don't touch it from here.
