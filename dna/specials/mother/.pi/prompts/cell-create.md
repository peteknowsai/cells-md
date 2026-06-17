---
name: cell-create
description: Provision a new cell — imprint the freshly-forked well, prove its brain, fire post-birth tasks in the background. Self-contained.
---

You are birthing a new cell. **Get to work immediately — no environment recon,
no tool probing, no "let me check what I have."** Everything you need is in this
prompt. **Do NOT read other files** (no `docs/birthing-ritual.html`, no codebase
grepping). Execute the three steps below in order, using your tools.

You have been handed four things:

- **`$1`** — the **birthId**. Pass it verbatim to `report_outcome` at the end.
  The cells CLI is long-polling for it.
- **`$2`** — the cell's **name** (e.g. `advisor-josh`).
- **`$3`** — the cell's **well** (`cells-<name>`), already cold-forked from the
  `cell-base` image by the CLI — running and waiting. You do **not** create it.
- **`$4`** — the **config blob** (JSON): `harness`, `model`, `provider`,
  `thinking`, `extensions`, `packages`, `channels`, `chain`.

Your tools (all already wired):

- `mac_exec({script})` — runs bash **on the Mac**, cwd = the cells repo. This is
  how you run the three birth scripts below; they always reflect current code.
- `well_exec({wellName, script})` — runs bash on a well as the `well` user
  (escape hatch only; the scripts below don't need it).
- `report_outcome({birthId, success, message})` — fire **exactly once** at the end.

Pass `$3`/`$2`/`$4` in **single quotes** — the blob already contains double
quotes, and single-quoting it keeps the shell happy. Mind the argument order:
it differs between scripts (it's called out on each).

## Step 1 · Imprint the well — GATED

One Mac-side script does every per-cell mutation (identity, model/provider/
thinking/chain, tmux color, status file, extensions, packages, harness config).
Order: **well, name, blob**.

```
mac_exec({script: "bash scripts/imprint-cell.sh '<$3>' '<$2>' '<$4>'"})
```

The last line of output must be `BAKE-OK`. If it isn't → **Failure**.

## Step 2 · Prove the brain — GATED

Run the end-test. It smoke-tests the blob's harness on the well and echoes the
success marker. Order: **well, blob**.

```
mac_exec({script: "bash scripts/end-test.sh '<$3>' '<$4>'"})
```

Output must end with the harness marker (`PI-OK` / `CLAUDE-OK` / `CODEX-OK` /
`HERMES-OK`). If it doesn't → **Failure**. This is the only gate after imprint —
the cell is declared alive once its own CLI answers.

## Step 3 · Fire post-birth tasks in the background, then declare — NOT gated

Site-service registration, public URL, Cloudflare Worker deploy, channel
binding, harness update, and the well checkpoint all run **async** — the cell is
already alive and talk-able. They do **not** gate success; a failure in any of
them is surfaced later by `cells doctor` / `postwork.json`, never by you. Never
put an external service (Cloudflare, Slack, the checkpoint) in the birth's
critical path. Order: **name, well, blob**.

```
mac_exec({script: "POSTLOG=\"$HOME/.cells/logs/birth-postwork/<$2>.log\"; mkdir -p \"$(dirname \"$POSTLOG\")\"; nohup bash scripts/birth-postwork.sh '<$2>' '<$3>' '<$4>' > \"$POSTLOG\" 2>&1 & disown"})
```

Then declare success — fire `report_outcome` exactly once:

```
report_outcome({birthId: "<$1>", success: true, message: "cell <$2> alive · <model> (post-birth async)"})
```

Finally (success only), append one activity line:

```
mac_exec({script: "printf '%s  born        <$2>          \\n' \"$(date -u +%Y-%m-%d\\ %H:%M)\" >> dna/specials/mother/state/memory/project_cells_activity.md"})
```

Stop. No further checks, no exploration.

## Failure

Any **gated** step fails (no `BAKE-OK`, or no `*-OK` marker):

```
report_outcome({birthId: "<$1>", success: false, message: "step <N>: <one-line reason>"})
```

Then stop. The CLI sweeps the well — a fresh fork beats a half-born one.
