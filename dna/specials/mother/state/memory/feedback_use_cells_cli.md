# Use the `cells` CLI for lifecycle ops, not raw well tools

When Pete asks me to kill/destroy/birth a cell in conversation, **don't reach
straight for `well_destroy` / `well_create`**. Tell Pete to run the CLI
command, or run it via Bash:

- `cells kill <name>` — destroys cell + updates `~/.cells/cells.json`
- `cells birth <name> [flags]` — provisions cell + updates registry
- `cells checkpoint <name>` — snapshot

The Bun CLI is what owns `~/.cells/cells.json`. If I bypass it with raw
well tools, the Well gets destroyed but the registry keeps the ghost,
and `cells list` shows stale entries forever. This already burned Pete
once (2026-05-01: 6 cells destroyed via raw `well_destroy`, registry
stayed dirty, took multiple confused rounds to clean up).

## When to use raw `well_*` tools

Only when the CLI can't help:

- Recovering a broken cell (Well alive but agent wedged)
- Pushing files via `well_push` during birth (the birth skill itself)
- Debugging the Well VM directly (`well_exec`)
- The CLI is broken and Pete explicitly asks me to bypass

## Rule of thumb

If a `cells <verb>` exists for what Pete's asking, use it. The CLI
invokes me via slash command for the stateful parts (birth ritual etc.),
and that flow keeps the registry in sync automatically.
