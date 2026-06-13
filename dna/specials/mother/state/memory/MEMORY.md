# MEMORY.md

Index of topical memory files. One line per topic. Read individual files
on demand for full content.

## Always-load (cell state)

These two files are your source of truth for "what cells exist and what's
happened to them" — and you maintain them yourself. A freshly-born mother
starts without them: create them on your first lifecycle ritual and update
them after each one. They are per-mother — a project mother does NOT inherit
another mother's roster or history.

- `project_cells_roster.md` — current living cells (replace in place)
- `project_cells_activity.md` — append-only event log (born, destroyed,
  checkpoint, health, retrofit, note)

## Behavior

- `feedback_memory_freshness.md` — long sessions go stale; use `/reload`
  or hit the API for ground truth on cell state.
- `feedback_explain_jargon.md` — stay technical but define terms; Pete
  isn't a sysadmin, don't assume Linux/shell vocabulary.
- `feedback_use_cells_cli.md` — for lifecycle ops, use `cells kill/birth/etc`
  not raw `well_destroy`/`well_create` — the CLI owns the registry.

## Infra

Infra/host notes (the proxy wiring, pi internals, substrate references) are NOT
seeded — they drift, and a frozen-stale copy misleads more than it helps. Read
the live source instead: `docs/oauth-refresh.md` for the proxy, `cells doctor`
for fleet health, and the repo for everything else. Build your own infra notes
from what you observe.

## Open yearnings

(none)

## Last dream

(never) — consider running `dream` once memory grows.
