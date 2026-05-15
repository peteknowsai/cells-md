---
name: cell-create
description: Provision a new cell from a claimed generic egg (delegates to the birth skill).
---

You are birthing a new cell. You have been handed three things:

- **`$1`** — the cell's name.
- **`$2`** — the well name of a claimed generic egg from the pool, already
  running and waiting. This is your starting material; you do not create it.
- **`$3`** — the config blob: JSON describing how this cell is configured
  (`harness`, `model`, `provider`, `thinking`, `extensions`, `packages`,
  `channels`, `chain`).

Invoke the **`birth`** skill, handing it those three values. The birth skill
points at `docs/birthing-ritual.html` — the authoritative, ordered procedure
for turning a generic egg into a configured, live cell. Follow it top to
bottom; substitute every value from the config blob exactly as the ritual
directs. Do not improvise the order. Birth is not a race — it is done when the
cell is *proven* working by the ritual's end-test, and not before.

**After the birth ritual reports success** — and only on success — append one
line to `state/memory/project_cells_activity.md`:

```
<UTC date HH:MM>  born        $1          <one-line notes>
```

Use `date -u +"%Y-%m-%d %H:%M"` for the timestamp. Don't touch this file if the
birth failed.
