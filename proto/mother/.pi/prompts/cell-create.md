---
name: cell-create
description: Provision a new Cell on a Well (delegates to the birth skill).
---

The user wants to create a cell named: $1

Birth configuration (JSON):
$2

Parse the JSON. It has six fields:
- `harness` — currently always `"pi"`. If anything else, abort with a clear
  error to Pete: `"harness '<value>' not yet supported (only 'pi' today)"`.
- `provider` — pi-ai provider ID. The CLI is authoritative — accept
  whatever it sends. Currently in the registry: `"anthropic"`,
  `"openai"`, `"openai-codex"`, `"deepseek"`. This becomes the
  `<PROVIDER>` substitution in the birth ritual.
- `model` — model ID (e.g. `claude-opus-4-7`, `gpt-5.5`). This becomes
  the `<MODEL>` substitution in the birth ritual.
- `thinking` — Pi thinking level: one of `off|minimal|low|medium|high|xhigh`.
  This becomes the `<THINKING>` substitution in the birth ritual.
- `extensions` — array of *in-tree* extension names the cell should keep
  (any subset of `memory`, `mentality`, `wiki`, `dream`). May be empty.
  Birth pushes the full DNA, then deletes the unselected ones.
  This becomes the `<EXTENSIONS>` substitution in the birth ritual.
- `packages` — array of npm/git package short names to install via
  `pi install` (e.g. `pi-web-access`). May be empty. This becomes the
  `<PACKAGES>` substitution in the birth ritual.
- `chain` — array of strings, the cell's model fallback chain in
  `<provider>/<modelId>:<thinking>` shorthand. The first entry is the
  primary model (typically matching `provider`/`model`/`thinking`); each
  subsequent entry is a fallback pi-coding-agent will swap to when the
  prior tier exhausts retries. May have one entry (no fallback). This
  becomes the `<CHAIN_JSON>` substitution in the birth ritual — pass it
  as a literal JSON array string (e.g. `["a","b"]`) into the sed
  substitution so settings.json ends up with `"modelChain": ["a","b"]`.

## Routing

Two routing modes coexist, and the birth ritual handles both without
branching:

- **Subscription-routed** (`anthropic`, `openai-codex`): traffic goes
  through the local subscriptions proxy at `proxy.cells.md` so cells
  share Pete's Claude Max + ChatGPT Plus subs. Wired by the bake:
  `cells bake` patches `pi-ai`'s `models.generated.js` to point at
  `proxy.cells.md` and stubs the codex `extractAccountId` so OAuth-
  rejected calls don't crash. Patches re-apply via `bun install`'s
  postinstall hook (`/cell/scripts/apply-pi-patches.sh`) on every
  extension install.
- **Direct-API** (`openai`, `deepseek`, anything else pi-ai natively
  supports): pi-ai reads the upstream key from env (e.g.
  `DEEPSEEK_API_KEY`). Birth step 6b already passes every key in
  `~/.cells/secrets.json` to `well_create --env=KEY=VAL`, welld lands
  them in `/etc/environment`, and `/etc/profile.d/cells-env.sh`
  re-exports under pi-ai's expected names — no per-key files.

Both modes share the same wiring path (env into `/etc/environment`,
patches in `cell-base`), so neither mode needs a per-cell retrofit.

1. Invoke the `birth` skill with these substitutions throughout the ritual:
   - `<NAME>` = `$1`
   - `<HARNESS>` = the parsed `harness` value
   - `<PROVIDER>` = the parsed `provider` value
   - `<MODEL>` = the parsed `model` value
   - `<THINKING>` = the parsed `thinking` value
   - `<EXTENSIONS>` = the parsed `extensions` array (may be empty)
   - `<PACKAGES>` = the parsed `packages` array (may be empty)
   - `<CHAIN_JSON>` = the parsed `chain` array re-serialized as a JSON
     array literal string (e.g. `["claude-opus-4-7","openai-codex/gpt-5.5:high"]`).
     Use `jq -c` or equivalent — settings.json must end up with valid JSON
     in `modelChain`, not a TOML-ish or partial render.

2. **After the birth ritual reports success**, append one line to
   `memory/project_cells_activity.md`:

   `<UTC date HH:MM>  born        $1          <one-line notes>`

   Use `date -u +"%Y-%m-%d %H:%M"` for the timestamp. Don't touch this
   file if the birth failed.
