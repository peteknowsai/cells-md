---
name: cell-create
description: Provision a new Cell on a Sprite (delegates to the birth skill).
---

The user wants to create a cell named: $1

1. Invoke the `birth` skill. The cell name is `$1` — substitute it for
   `<NAME>` throughout the ritual.

2. **After the birth ritual reports success**, record the event in memory:
   - Append one line to `memory/project_cells_activity.md`:
     `<UTC date HH:MM>  born        $1          <one-line notes>`
   - Add `$1` as a new row in the table inside `memory/project_cells_roster.md`.

   Use `date -u +"%Y-%m-%d %H:%M"` for the timestamp. Don't touch these
   files if the birth failed.
