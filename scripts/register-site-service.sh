#!/usr/bin/env bash
# Register the `site` service on a cell so the cell's web server (/root/site/)
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
# WELL_API_URL + WELL_TOKEN may be overridden by env (cells.ts injects
# these for backend=well to point at welld on localhost). Default
# matches the legacy hosted-wells API.
API_URL="${WELL_API_URL:-https://api.sprites.dev}"
if [ -n "${WELL_TOKEN:-}" ]; then
  TOKEN="$WELL_TOKEN"
else
  SECRETS="$HOME/.cells/secrets.json"
  [ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }
  TOKEN=$(jq -r '.WELL_TOKEN // empty' "$SECRETS")
  [ -n "$TOKEN" ] || { echo "no WELL_TOKEN in $SECRETS"; exit 1; }
fi

# Wells's services API hardcodes the systemd unit's User=ubuntu (see
# wells/lib/services.ts). The agent runs as root inside the VM (since
# the root-cell migration, 2026-05-15) so we sudo to root for filesystem
# access; ubuntu has NOPASSWD sudo per the wells base. HOME=/root so the
# server resolves DNA relative paths the same way the agent does.
#
# Inner (root) script:
#   1. cd into /root/site (server.ts lives there).
#   2. Source /etc/profile.d/cells-env.sh (env shim re-exports secret).
#   3. Prepend /home/well/.bun/bin to PATH (bun installed there at bake).
#   4. Export HOME, CELL_NAME, PORT.
#   5. exec bun in foreground; if it crashes systemd restarts it.
INNER='cd /root/site && . /etc/profile.d/cells-env.sh; export HOME=/root PATH="/home/well/.bun/bin:$PATH"; export CELL_NAME='"'$NAME'"'; export PORT=8080; exec bun run server.ts'
SCRIPT="sudo bash -c $(printf '%q' "$INNER")"

PAYLOAD=$(jq -n --arg s "$SCRIPT" '{cmd:"bash",args:["-lc",$s],workdir:"/root"}')

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
