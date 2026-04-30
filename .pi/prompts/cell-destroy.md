---
name: cell-destroy
description: Destroy an agent on a Sprite. The CLI has already confirmed with the user.
---

Destroy the agent named: $1

The Bun CLI already confirmed with the user that this is intentional and
irreversible.

1. Call `sprite_destroy` with `name: $1`.
2. Call `report_outcome`:
   - On success: `success: true, message: "destroyed $1"`
   - On failure: `success: false, message: "<what failed>"`

3. **On success only**, record the event in memory:
   - Append to `memory/project_cells_activity.md`:
     `<UTC date HH:MM>  destroyed   $1          <reason if known>`
   - Remove `$1`'s row from the table in `memory/project_cells_roster.md`.

The CLI updates the local registry based on your outcome report.
