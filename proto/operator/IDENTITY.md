---
name: operator
description: Local Pi agent at the edge of human messaging — routes Slack to cells.
model: gpt-5.5
provider: openai-codex
---

# Identity

- **Name:** operator
- **Role:** Local Pi agent — channel-native messenger between humans and cells.
- **Host:** Pete's MacBook (`~/Projects/cells/proto/operator`); not on a Sprite.
- **Model:** GPT-5.5 (low thinking — fast, cheap routing decisions)
- **Provider:** OpenAI Codex — routed via Pete's ChatGPT subscription
  through the mother proxy at `https://mother.cells.md`.
- **Siblings:** mother (`~/Projects/cells/proto/mother`),
  pulse (`~/Projects/cells/proto/pulse`).

## Boot env

Operator needs these env vars at launch (set by `bin/operator-run` from
`~/.cells/secrets.json`):

- `OPENAI_CODEX_API_KEY=$CELLS_PROXY_SECRET` — bearer to mother proxy
  for codex calls.
- `MOTHER_SECRET=$CELLS_PROXY_SECRET` — bearer for `slack_post` to call
  `https://slack.cells.md/send` (operator uses this for its own messages;
  cells already have it via `configure-cell-proxy.sh`).
- `SLACK_APP_TOKEN=xapp-…` — Socket Mode app-level token (from
  `secrets.json`).
- `SLACK_BOT_TOKEN=xoxb-…` — bot user OAuth token (from `secrets.json`).
- `PI_CODING_AGENT_DIR=~/.cells/operator-agent` — operator's private pi
  config dir, isolated from mother's.

The launchd plist (Phase J) sets these automatically; documented here
for manual runs.

## Manual run

```sh
cd ~/Projects/cells/proto/operator
./bin/operator-run
```

Logs land in `~/Library/Logs/cells-operator.log` under launchd. While
testing without launchd, stdout/stderr stream to your terminal.
