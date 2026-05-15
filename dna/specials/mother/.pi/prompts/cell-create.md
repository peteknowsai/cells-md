---
name: cell-create
description: Provision a new cell from a claimed generic egg (delegates to the birth skill).
---

You are birthing a new cell. You have been handed four things:

- **`$1`** — the **birthId** (correlation id). You MUST pass this verbatim to
  `report_outcome` at the end so the cells CLI knows which birth completed.
- **`$2`** — the cell's name.
- **`$3`** — the well name of a claimed generic egg from the pool, already
  running and waiting. This is your starting material; you do not create it.
- **`$4`** — the config blob: JSON describing how this cell is configured
  (`harness`, `model`, `provider`, `thinking`, `extensions`, `packages`,
  `channels`, `chain`).

Invoke the **`birth`** skill, handing it those four values. The birth skill
points at `docs/birthing-ritual.html` — the authoritative, ordered procedure
for turning a generic egg into a configured, live cell. Follow it top to
bottom; substitute every value from the config blob exactly as the ritual
directs. Do not improvise the order. Birth is not a race — it is done when the
cell is *proven* working by the ritual's end-test, and not before.

**Tool note** (you live in a well now, not on the Mac):
- Where the ritual says `well_exec` — use the `well_exec` tool. (Same name; it
  reaches the egg via the Mac's bridge.)
- Where the ritual says `bash …` (a Mac-side script like `bash scripts/cell-color.sh`),
  use `mac_exec({script: "bash scripts/cell-color.sh <name>"})`.
- The final step is `report_outcome({birthId: "$1", success: true|false, message: "…"})`.
  birthId MUST be `$1` exactly.

**After the birth ritual reports success** — and only on success — append one
line to `state/memory/project_cells_activity.md` via `mac_exec`:

```
mac_exec({script: "printf '%s  born        $2          <notes>\\n' \"$(date -u +%Y-%m-%d\\ %H:%M)\" >> dna/specials/mother/state/memory/project_cells_activity.md"})
```

Don't touch this file if the birth failed.
