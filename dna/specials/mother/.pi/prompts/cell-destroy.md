---
name: cell-destroy
description: Destroy an agent on a well. The CLI has already confirmed with the user.
---

Destroy the agent named: $1

The Bun CLI already confirmed with the user that this is intentional and
irreversible.

The user-facing cell name is not always the same as the underlying well
name — a cell's well is `cells-<name>` (or, for legacy cells, a backfilled
`egg-<hex>` from the retired pool era), and the cell name is just a local
alias. You MUST resolve the well first.

1. Call `cell_resolve` with `name: $1`. Read the result:
   - `well_name=<X>` → use `<X>` as the well name in step 2.
   - "no cell named '$1' in registry" → the registry already lost it. Skip
     step 2 and call `report_outcome` with `success: true, message: "no
     registry entry for $1 — well cleanup skipped"`. Local cleanup is
     handled by the CLI.

2. Call `well_destroy` with `name: <resolved well name>`.

3. Call `report_outcome`:
   - On success: `success: true, message: "destroyed $1 (well=<X>)"`
   - On failure: `success: false, message: "<what failed>"`

4. **On success only**, append to `memory/project_cells_activity.md`:

   `<UTC date HH:MM>  destroyed   $1          <reason if known>`

The CLI updates the local registry based on your outcome report.
