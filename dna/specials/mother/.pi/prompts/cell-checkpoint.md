---
name: cell-checkpoint
description: Take a filesystem checkpoint of an agent's well.
---

Take a checkpoint of the agent named: $1

1. Call `cell_resolve` with `name: $1` to get the underlying well name —
   hatched cells live on a permanent well named differently from the
   cell, and the well API rejects cell-name lookups for them.
2. Call `well_checkpoint` with `name: <resolved well name>`.
3. Call `report_outcome`:
   - On success: `success: true, message: "checkpoint created for $1: <checkpoint id from response>"`
   - On failure: `success: false, message: "<what failed>"`

4. **On success only**, append one line to
   `memory/project_cells_activity.md`:
   `<UTC date HH:MM>  checkpoint  $1          <checkpoint id>`
