#!/usr/bin/env bash
# Register the `agent` service on a cell so Pi auto-starts on VM boot.
# Reads SPRITES_TOKEN from ~/.cells/secrets.json and PUTs the service.
#
# Usage: scripts/register-agent-service.sh <cell-name>
set -euo pipefail

NAME="${1:?usage: $0 <cell-name>}"
SECRETS="$HOME/.cells/secrets.json"
[ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }
TOKEN=$(jq -r '.SPRITES_TOKEN // empty' "$SECRETS")
[ -n "$TOKEN" ] || { echo "no SPRITES_TOKEN in $SECRETS"; exit 1; }

# The service command:
#   1. cd into the agent dir.
#   2. Start tmux detached. The session command is a bash -lc that re-sources
#      .bashrc.d/* before exec'ing pi — necessary because if a tmux server
#      already exists (e.g. spawned by a shell shim), `new-session` would
#      otherwise inherit that server's stale env. Re-sourcing inside the
#      session is the only reliable way to get ANTHROPIC_AUTH_TOKEN etc.
#      into pi's process.
#   3. Hold the service process alive in a sleep loop while the tmux
#      session exists. If tmux dies, the loop exits → service restarts.
PI_LAUNCH='bash -lc "for f in /home/sprite/.bashrc.d/*; do . \$f; done; export PATH=/home/sprite/.local/bin:\$HOME/.bun/bin:\$PATH; exec pi"'
SCRIPT="cd /home/sprite/agent && tmux new-session -dA -s $NAME $PI_LAUNCH && while tmux has-session -t $NAME 2>/dev/null; do sleep 10; done"

PAYLOAD=$(jq -n --arg s "$SCRIPT" '{cmd:"bash",args:["-lc",$s],workdir:"/home/sprite/agent"}')

# Delete first — the sprites API treats PUT as create-only and silently
# no-ops on an existing service, leaving stale config in place.
curl -fsS -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.sprites.dev/v1/sprites/$NAME/services/agent" > /dev/null 2>&1 || true

curl -fsS -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "https://api.sprites.dev/v1/sprites/$NAME/services/agent" > /dev/null

echo "service 'agent' registered on $NAME"
