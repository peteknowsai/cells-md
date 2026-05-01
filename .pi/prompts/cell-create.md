---
name: cell-create
description: Provision a new Cell on a Sprite (delegates to the birth skill).
---

The user wants to create a cell named: $1

Birth configuration (JSON):
$2

Parse the JSON. It has three fields:
- `harness` — for v1 always `"pi"`. If anything else, abort with a clear
  error to Pete: `"harness '<value>' not yet supported (only 'pi' for v1)"`.
- `model` — Anthropic model ID (e.g. `claude-opus-4-7`). This becomes
  the `<MODEL>` substitution in the birth ritual.
- `packages` — array of pi-cell-* short names (any subset of
  `memory`, `mentality`, `wiki`, `dream`). May be empty. This becomes
  the `<PACKAGES>` substitution in the birth ritual.

1. Invoke the `birth` skill with these substitutions throughout the ritual:
   - `<NAME>` = `$1`
   - `<MODEL>` = the parsed `model` value
   - `<PACKAGES>` = the parsed `packages` array (may be empty)

2. **After the birth ritual reports success**, record the event in memory:
   - Append one line to `memory/project_cells_activity.md`:
     `<UTC date HH:MM>  born        $1          <one-line notes>`
   - Add `$1` as a new row in the table inside `memory/project_cells_roster.md`.

   Use `date -u +"%Y-%m-%d %H:%M"` for the timestamp. Don't touch these
   files if the birth failed.
