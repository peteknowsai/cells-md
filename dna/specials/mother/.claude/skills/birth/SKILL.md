---
name: birth
description: Turn a freshly-forked cell well into a configured, live cell. Self-contained — runs the same whether mother is on the Mac or inside her own cell.
---

# Birth

Execute the steps below in order, driving every action through **`cells-bridge`**.
**Do not read other files. Do not grep the codebase. Do not echo env vars to
check them — they're set, trust it.** Everything you need is here.

`cells-bridge` is on your PATH. It runs each step where it has to run (on the
Mac, against welld) — whether you are the Mac-side mother or a mother inside her
own cell. You don't care which; just call it. Use your Bash tool.

## Inputs

The message is `/birth <BIRTH_ID> <NAME> <WELL> <BLOB>`. Four positional args:

- `<BIRTH_ID>` — correlation id. Pass it **verbatim** to `report-outcome`.
- `<NAME>` — the cell's name (e.g. `advisor-josh`).
- `<WELL>` — the cell's well (`cells-<name>`), already cold-forked from
  `cell-base`, running and waiting. You do **not** create it.
- `<BLOB>` — config. May be raw JSON **or** an `@/path/to/blob.json` token.
  Pass it through **verbatim, single-quoted** — never try to parse or re-quote it.

## Step 1 · Imprint — GATED

```bash
cells-bridge mac-exec "bash scripts/imprint-cell.sh '<WELL>' '<NAME>' '<BLOB>'"
```

The last line of output must be `BAKE-OK`. If it isn't → **Failure**.

## Step 2 · Prove the brain — GATED

```bash
cells-bridge mac-exec "bash scripts/end-test.sh '<WELL>' '<BLOB>'"
```

Output must end with the harness's marker (`PI-OK` / `CLAUDE-OK` / `CODEX-OK` /
`HERMES-OK`). If it doesn't → **Failure**. This is the only gate after imprint —
the cell is declared alive once its own CLI answers.

## Step 3 · Fire the post-birth tail in the background, then declare — NOT gated

Site service, public URL, Worker deploy, channel binding, harness update, and
the well checkpoint all run **async** — the cell is already alive. They never
gate success; a failure there is surfaced later by `cells doctor`, not by you.

```bash
cells-bridge mac-exec "bash scripts/birth-postwork-bg.sh '<NAME>' '<WELL>' '<BLOB>'"
```

Then declare success — exactly once:

```bash
cells-bridge report-outcome '<BIRTH_ID>' true 'cell <NAME> alive (post-birth async)'
```

Print exactly: `Cell <NAME> is alive.` and stop. No further checks, no exploration.

## Failure

Any **gated** step fails (no `BAKE-OK`, or no `*-OK` marker):

```bash
cells-bridge report-outcome '<BIRTH_ID>' false 'step <N>: <one-line reason>'
```

Then stop. The CLI sweeps the well — a fresh fork beats a half-born one.
