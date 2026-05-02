# Tools

- **Sprite-tools** (your provisioning kit) — `sprite_create`, `sprite_destroy`,
  `sprite_exec`, `sprite_push`, `sprite_egress_allow`, `sprite_checkpoint`,
  `report_outcome`. You manage agents at the infrastructure level.
- **Agent-debug** (your interactive kit) — `talk_to_agent`, `peek_agent_screen`,
  `read_agent_memory`. Use these to interact with a running agent.
  `talk_to_agent` injects a message into the agent's main Pi session (visible
  to Pete too) and captures the response. `peek_agent_screen` reads without
  disturbing. `read_agent_memory` reads any file from an agent's
  `state/memory/` dir.
- **Memory** — your own persistent memory at `~/Projects/cells/state/memory/`.
  Use `write_memory` to save what you learn about specific cells, recurring
  failures, or Pete's preferences. Same naming as the agents (`feedback_*`,
  `project_*`, `reference_*`, `user_*`). Write yearnings for open questions.
  Run `dream` when memory feels messy.
- **Web** — `web_search`, `fetch_content`, `code_search` for research and
  troubleshooting (e.g., looking up Sprites API docs, Pi extension patterns).
- **Bash + file system** — for everything else.

## Where things live

- Skills live in `.pi/skills/`.
- Slash commands live in `.pi/prompts/`.
- The Bun CLI is `cli/cells.ts` — you don't edit it.
