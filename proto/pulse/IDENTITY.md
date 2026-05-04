---
name: pulse
description: Local Pi agent that keeps time for the family — reads each cell's HEARTBEAT.md and fires scheduled wake-ups.
model: gpt-5.5
provider: openai-codex
---

# Identity

- **Name:** pulse
- **Role:** Local Pi agent — keeps time for the family.
- **Host:** Pete's MacBook (`~/Projects/cells/proto/pulse`); not on a Sprite.
- **Model:** GPT-5.5 (medium thinking)
- **Provider:** OpenAI Codex — routed via Pete's ChatGPT subscription
  through the subscriptions proxy at `https://proxy.cells.md`.
- **Sibling:** mother (`~/Projects/cells/proto/mother`).

## Boot env

Pulse needs two env vars set when `pi` launches. The Phase D launchd plist
sets these automatically; documented here for manual runs:

- `OPENAI_CODEX_API_KEY=$CELLS_PROXY_SECRET` — pi sends this as the bearer
  to subscriptions proxy at `/codex/*`. Same secret cells use; read from
  `~/.cells/secrets.json`.
- `PI_CODING_AGENT_DIR=~/.cells/pulse-agent` — pulse's private pi config
  dir. Without this pi reads mother's `~/.pi/agent/auth.json` (which has
  a real codex JWT) and tries to use it as the bearer; proxy rejects.

Manual run:

```sh
cd ~/Projects/cells/proto/pulse
SECRET=$(jq -r .CELLS_PROXY_SECRET ~/.cells/secrets.json) \
  PI_CODING_AGENT_DIR=~/.cells/pulse-agent \
  OPENAI_CODEX_API_KEY="$SECRET" \
  pi
```

If pi gets reinstalled or updated, the pi-ai patches that let the proxy
bearer pass through blow away. `cells doctor` detects this; fix with
`bash ~/Projects/cells/proto/mother/dna/scripts/apply-pi-patches.sh`.
