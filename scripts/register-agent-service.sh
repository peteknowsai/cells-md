#!/usr/bin/env bash
# Register the `agent` service on a cell so Pi auto-starts on VM boot.
# Reads SPRITES_TOKEN from ~/.cell/secrets.json and PUTs the service.
#
# Usage: scripts/register-agent-service.sh <cell-name>
set -euo pipefail

NAME="${1:?usage: $0 <cell-name>}"
SECRETS="$HOME/.cell/secrets.json"
[ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }
TOKEN=$(jq -r '.SPRITES_TOKEN // empty' "$SECRETS")
[ -n "$TOKEN" ] || { echo "no SPRITES_TOKEN in $SECRETS"; exit 1; }

# The service command:
#   1. Source env files (.bashrc.d/*) so ANTHROPIC_AUTH_TOKEN etc. are set.
#   2. Put the on-cell `cell` CLI on PATH.
#   3. Start tmux detached (`-d`) with the `agent` session running Pi.
#      `-A` makes it idempotent (attach if exists, create otherwise).
#   4. Hold the service process alive in a sleep loop while the tmux
#      session exists. If tmux dies, the loop exits → service restarts.
SCRIPT='cd /home/sprite/agent && for f in /home/sprite/.bashrc.d/*; do . $f; done; export PATH=/home/sprite/.local/bin:$HOME/.bun/bin:$PATH; tmux new-session -dA -s agent pi && while tmux has-session -t agent 2>/dev/null; do sleep 10; done'

PAYLOAD=$(jq -n --arg s "$SCRIPT" '{cmd:"bash",args:["-lc",$s],workdir:"/home/sprite/agent"}')

curl -fsS -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "https://api.sprites.dev/v1/sprites/$NAME/services/agent" > /dev/null

echo "service 'agent' registered on $NAME"
