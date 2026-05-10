#!/usr/bin/env bash
# Register the `site` service on a cell so the cell's web server (~/agent/site/)
# auto-starts on VM boot. Mother proxies <name>.cells.md to this server's
# port 8080 inside the well.
#
# Reads WELL_TOKEN from ~/.cells/secrets.json and PUTs the service.
#
# Usage: scripts/register-site-service.sh <cell-name> [well-name]
#
# For slow-birth cells, well name == cell name (omit the second arg).
# For hatched cells, the well name is the eggs permanent well
# (e.g. egg-sonnet-67706a) — different from the cell name. The CELL_NAME
# env var passed into server.ts is always the user-facing cell name;
# the well API call targets the well name.
set -euo pipefail

NAME="${1:?usage: $0 <cell-name> [well-name]}"
SPRITE_NAME="${2:-$NAME}"
# WELL_API_URL + WELL_TOKEN + AGENT_HOME may be overridden by env
# (cells.ts injects these for backend=well to point at welld on localhost
# and to set the well's home dir). Defaults match the wells layout.
API_URL="${WELL_API_URL:-https://api.sprites.dev}"
AGENT_HOME="${AGENT_HOME:-/home/well}"
if [ -n "${WELL_TOKEN:-}" ]; then
  TOKEN="$WELL_TOKEN"
else
  SECRETS="$HOME/.cells/secrets.json"
  [ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }
  TOKEN=$(jq -r '.WELL_TOKEN // empty' "$SECRETS")
  [ -n "$TOKEN" ] || { echo "no WELL_TOKEN in $SECRETS"; exit 1; }
fi

# The service command:
#   1. cd into the site dir.
#   2. Source env files (.bashrc.d/*) so CELLS_PROXY_SECRET is set.
#   3. Put bun on PATH.
#   4. Export CELL_NAME + PORT for server.ts.
#   5. exec bun in foreground; if it crashes the service exits and the
#      well platform restarts it.
# Paths use $HOME so the in-VM agent user's shell resolves them (works for
# the agent home (currently /home/well)). The PUT payload's workdir field below
# needs an absolute path — that's where AGENT_HOME applies.
SCRIPT='cd "$HOME/agent/site" && for f in "$HOME/.bashrc.d/"*; do . "$f"; done; export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; export CELL_NAME='"$NAME"'; export PORT=8080; exec bun run server.ts'

PAYLOAD=$(jq -n --arg s "$SCRIPT" --arg w "$AGENT_HOME/agent/site" '{cmd:"bash",args:["-lc",$s],workdir:$w}')

# Delete first — the wells API treats PUT as create-only and silently
# no-ops on an existing service, leaving stale config in place.
curl -fsS -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  "$API_URL/v1/wells/$SPRITE_NAME/services/site" > /dev/null 2>&1 || true

curl -fsS -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$API_URL/v1/wells/$SPRITE_NAME/services/site" > /dev/null

echo "service 'site' registered on $SPRITE_NAME with CELL_NAME=$NAME"
