#!/usr/bin/env bash
# Register the `site` service on a cell so the cell's web server (~/agent/site/)
# auto-starts on VM boot. Mother proxies <name>.cells.md to this server's
# port 8080 inside the sprite.
#
# Reads SPRITES_TOKEN from ~/.cells/secrets.json and PUTs the service.
#
# Usage: scripts/register-site-service.sh <cell-name> [sprite-name]
#
# For slow-birth cells, sprite name == cell name (omit the second arg).
# For hatched cells, the sprite name is the egg's permanent sprite
# (e.g. egg-sonnet-67706a) — different from the cell name. The CELL_NAME
# env var passed into server.ts is always the user-facing cell name;
# the sprite API call targets the sprite name.
set -euo pipefail

NAME="${1:?usage: $0 <cell-name> [sprite-name]}"
SPRITE_NAME="${2:-$NAME}"
# SPRITES_API_URL + SPRITES_TOKEN may be overridden by env (cells.ts injects
# these for backend=well to point at welld on localhost). Default = cloud sprites.
API_URL="${SPRITES_API_URL:-https://api.sprites.dev}"
if [ -n "${SPRITES_TOKEN:-}" ]; then
  TOKEN="$SPRITES_TOKEN"
else
  SECRETS="$HOME/.cells/secrets.json"
  [ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }
  TOKEN=$(jq -r '.SPRITES_TOKEN // empty' "$SECRETS")
  [ -n "$TOKEN" ] || { echo "no SPRITES_TOKEN in $SECRETS"; exit 1; }
fi

# The service command:
#   1. cd into the site dir.
#   2. Source env files (.bashrc.d/*) so CELLS_PROXY_SECRET is set.
#   3. Put bun on PATH.
#   4. Export CELL_NAME + PORT for server.ts.
#   5. exec bun in foreground; if it crashes the service exits and the
#      sprite platform restarts it.
SCRIPT="cd /home/sprite/agent/site && for f in /home/sprite/.bashrc.d/*; do . \$f; done; export PATH=/home/sprite/.local/bin:\$HOME/.bun/bin:\$PATH; export CELL_NAME=$NAME; export PORT=8080; exec bun run server.ts"

PAYLOAD=$(jq -n --arg s "$SCRIPT" '{cmd:"bash",args:["-lc",$s],workdir:"/home/sprite/agent/site"}')

# Delete first — the sprites API treats PUT as create-only and silently
# no-ops on an existing service, leaving stale config in place.
curl -fsS -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  "$API_URL/v1/sprites/$SPRITE_NAME/services/site" > /dev/null 2>&1 || true

curl -fsS -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$API_URL/v1/sprites/$SPRITE_NAME/services/site" > /dev/null

echo "service 'site' registered on $SPRITE_NAME with CELL_NAME=$NAME"
