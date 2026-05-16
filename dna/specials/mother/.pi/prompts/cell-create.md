---
name: cell-create
description: Provision a new cell from a claimed generic egg (delegates to the birth skill).
---

You are birthing a new cell. **Get to work immediately — no environment recon,
no tool probing, no "let me check what I have."** Your tools work as advertised.
The egg is real and running. Trust the setup and execute the ritual.

You have been handed four things:

- **`$1`** — the **birthId** (correlation id). Pass it verbatim to
  `report_outcome` at the end. The cells CLI is long-polling for this.
- **`$2`** — the cell's name.
- **`$3`** — the well name of a claimed generic egg from the pool, already
  running and waiting. This is your starting material; you do not create it.
- **`$4`** — the config blob: JSON describing how this cell is configured
  (`harness`, `model`, `provider`, `thinking`, `extensions`, `packages`,
  `channels`, `chain`).

**Start by reading `docs/birthing-ritual.html`** (use the `read` tool with that
relative path — your cwd is /root, which is where the file lives). Then run
the ritual top to bottom. Don't read it twice; don't ask Pete questions;
don't verify the egg exists by probing — just *use* it.

**Tool mapping** (the ritual uses three tools, all already wired):
- `well_exec({wellName: "<egg>", script: "..."})` — runs on the egg. Note
  the SSH user is `well`, NOT root, so prefix file writes to `/root/*`
  with `sudo`. Example: `sudo sed -i 's/__NAME__/<name>/g' /root/AGENTS.md`.
- `mac_exec({script: "bash scripts/cell-color.sh <name>"})` — wherever the
  ritual says `bash …` (Mac-side script). cwd is the cells repo.
- `report_outcome({birthId: "$1", success: true|false, message: "…"})` —
  fire exactly once at the end. birthId MUST be `$1` verbatim.

The ritual's "end-test" (step 8) tells you what to check before declaring
success. If any *critical* check fails, call `report_outcome` with
`success: false` and a one-line message naming the failing step. The CLI
will sweep the egg on a failed outcome — that's fine, fresh egg next time.

**After the birth ritual reports success** — and only on success — append one
line to `state/memory/project_cells_activity.md` via `mac_exec`:

```
mac_exec({script: "printf '%s  born        $2          <notes>\\n' \"$(date -u +%Y-%m-%d\\ %H:%M)\" >> dna/specials/mother/state/memory/project_cells_activity.md"})
```

Don't touch this file if the birth failed.
