# Scratchpad — things to come back to

Loose follow-ups. Not blocking any current work; here so we don't
forget.

## Slack manifest scope minimization (pass-2 leftover)

Bot scopes that aren't actually used by any code path:
- `groups:history`, `groups:read` (private channels — we don't make any)
- `im:history`, `im:read`, `im:write` (DMs with the bot)
- `mpim:history`, `mpim:read`, `mpim:write` (group DMs)
- `users:read` (no code calls users.* APIs)
- `reactions:write` (no code uses reactions)

User scopes (granted to operator's slack-adapter, retired):
- All of `chat:write`, `channels:history`, `groups:history`,
  `im:history`, `mpim:history` likely droppable.

bot_events to drop: `message.groups`, `message.im`, `message.mpim`.

**Keep:** `app_mentions:read`, `chat:write`, `chat:write.customize`,
`channels:history`, `channels:manage`, `channels:read`, plus
`app_mention` and `message.channels` events.

Why deferred: each manifest update + reauth rotates the bot token,
forces re-piping into Wrangler secrets, and Pete just did that
tonight. Batch with the next manifest change.

## refresh-extensions verification

`cells refresh-extensions <cell> <ext>` was made v2-aware in the
bridge work (`pkill -f "pi --mode rpc"` instead of tmux send-keys),
but hasn't been exercised end-to-end. Worth a manual run on jim or
similar to confirm the new path actually picks up new extension code.

## Pre-v2 session migration

Cells born before v2 had session files at
`~/.pi/agent/sessions/--home-sprite-agent--/<timestamp>.jsonl`. New
v2 cells are pinned to `~/.pi/agent/sessions/root-<name>/main.jsonl`.
The cutover for adam/bob/pete dropped their pre-v2 conversation
history.

If recovery is wanted, a one-time copy:
```sh
well exec -s <cell> -- bash -lc \
  'latest=$(ls -t ~/.pi/agent/sessions/--home-sprite-agent--/*.jsonl | head -1); \
   mkdir -p ~/.pi/agent/sessions/root-<name>; \
   cp "$latest" ~/.pi/agent/sessions/root-<name>/main.jsonl'
```

Low priority — cells already have memory + identity files; chat
scrollback is mostly noise.

## Bridge polish items deferred from pass 1b

Per `docs/state-should-move-into-compressed-treasure.md` — review
once bridge has soaked. Most landed; remaining:
- Sub-1Hz Slack edit throttle was implemented (FLUSH_INTERVAL_MS = 400).
  Watch for 429s in production usage; tune if needed.
- Per-cell keepalive window (currently `IDLE_WINDOW_MS = 60_000`).
  Move to per-cell config when a cell actually wants something
  different.

## CLI `cells refresh-extensions` for v2 multi-cell

The current command is single-cell. Bulk re-pushing one extension
across the fleet (e.g. when DNA changes) currently means a for loop
in the shell. Consider `cells refresh-extensions --all <ext>`.

## Birth: `--slack-channel=Cxxx` legacy flag

Still present in `cli/cells.ts` for binding to an existing channel
ID. Now that auto-create is the default, this is rarely useful.
Could remove. Keep for now since it's harmless.

## docs/operator.md retirement banner

Fine as-is — historical reference. If we ever build the "operator
2.0" inbox at `operator.cells.md`, give it its own doc and link
back.

## State memory entries with v1 architecture claims

Some `dna/proto/mother/state/memory/*.md` files describe v1 details
("slack-channel only, drainer+site"). Don't rewrite — they're
historical record. But beware of treating them as current truth in
future sessions.

## CLAUDE.md drift across the project

No repo-root `CLAUDE.md` exists today. If Pete ever wants automated
sessions to start with a load-bearing context block, that's where it
goes. For now, knowledge is split across `docs/ROADMAP.md`,
`proto/*/AGENTS.md`, and the active session.
