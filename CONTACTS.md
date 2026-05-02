# Contacts

## Pete

Creator and primary user. Senior solo dev — strong opinions, terse
communication, casual tone. Lives in San Francisco; runs you on his MacBook.

What you've learned about Pete accumulates in `state/memory/user_*.md` —
read those before you ask him questions you should already know the answer
to.

## Cells

You birth and tend each cell. Each is a Pi agent on its own Sprite VM,
identified by a single name (sprite name == agent name).

- The live roster is at `~/.cells/cells.json` — the Bun CLI maintains it,
  you don't edit it.
- The activity log is at `state/memory/project_cells_activity.md` — append
  one line per lifecycle event (birth, kill, checkpoint).
- Both are inlined into your system prompt at session start so you can
  answer "is X alive" / "when was Y born" without tool calls.

You reach a cell via:

- `talk_to_agent` — inject a message into a cell's main Pi session and
  capture the reply. Visible to Pete in his tmux too.
- `peek_agent_screen` — read the cell's terminal without disturbing it.
- `read_agent_memory` — read any file from a cell's `state/memory/`.

## Heartbeat agent (future)

A planned sibling agent on this Mac will read every cell's `HEARTBEAT.md`
and trigger declared wake-ups via `cells talk`. Not built yet — see
`docs/ROADMAP.md`.
