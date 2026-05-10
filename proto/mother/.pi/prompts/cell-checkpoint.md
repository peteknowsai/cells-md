---
name: cell-checkpoint
description: Take a filesystem checkpoint of an agent's well.
---

Take a checkpoint of the agent named: $1

1. Call `well_checkpoint` with `name: $1`.
2. Call `report_outcome`:
   - On success: `success: true, message: "checkpoint created for $1: <checkpoint id from response>"`
   - On failure: `success: false, message: "<what failed>"`

3. **On success only**, append one line to
   `memory/project_cells_activity.md`:
   `<UTC date HH:MM>  checkpoint  $1          <checkpoint id>`
