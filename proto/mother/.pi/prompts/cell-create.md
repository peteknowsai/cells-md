---
name: cell-create
description: Provision a new Cell on a Sprite (delegates to the birth skill).
---

The user wants to create a cell named: $1

Birth configuration (JSON):
$2

Parse the JSON. It has six fields:
- `harness` — for v1 always `"pi"`. If anything else, abort with a clear
  error to Pete: `"harness '<value>' not yet supported (only 'pi' for v1)"`.
- `provider` — Pi provider ID (`"anthropic"` or `"openai"`). This becomes
  the `<PROVIDER>` substitution in the birth ritual.
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

1. Invoke the `birth` skill with these substitutions throughout the ritual:
   - `<NAME>` = `$1`
   - `<PROVIDER>` = the parsed `provider` value
   - `<MODEL>` = the parsed `model` value
   - `<THINKING>` = the parsed `thinking` value
   - `<EXTENSIONS>` = the parsed `extensions` array (may be empty)
   - `<PACKAGES>` = the parsed `packages` array (may be empty)

2. **After the birth ritual reports success**, append one line to
   `memory/project_cells_activity.md`:

   `<UTC date HH:MM>  born        $1          <one-line notes>`

   Use `date -u +"%Y-%m-%d %H:%M"` for the timestamp. Don't touch this
   file if the birth failed.
