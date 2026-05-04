#!/usr/bin/env bash
# Apply scripts/slack-app-manifest.json to the cells Slack app via
# apps.manifest.update. Reads SLACK_APP_CONFIG_TOKEN + SLACK_APP_ID
# from ~/.cells/secrets.json.
#
# After scope/event changes, Slack flags the app as needing
# re-installation — visit api.slack.com/apps/<APP_ID>/install-on-team
# and click "Reinstall to Workspace".
#
# Usage: scripts/slack-app-apply.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST_FILE="$REPO_ROOT/scripts/slack-app-manifest.json"
SECRETS="$HOME/.cells/secrets.json"

[ -f "$MANIFEST_FILE" ] || { echo "missing $MANIFEST_FILE"; exit 1; }
[ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }

TOKEN=$(jq -r '.SLACK_APP_CONFIG_TOKEN // empty' "$SECRETS")
APP_ID=$(jq -r '.SLACK_APP_ID // empty' "$SECRETS")
[ -n "$TOKEN" ] || { echo "no SLACK_APP_CONFIG_TOKEN in $SECRETS (generate one at api.slack.com/authentication/config-tokens)"; exit 1; }
[ -n "$APP_ID" ] || { echo "no SLACK_APP_ID in $SECRETS"; exit 1; }

# apps.manifest.update accepts the manifest as a JSON string.
MANIFEST=$(jq -c . "$MANIFEST_FILE")

RESP=$(curl -sS -X POST "https://slack.com/api/apps.manifest.update" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "app_id=$APP_ID" \
  --data-urlencode "manifest=$MANIFEST")

OK=$(echo "$RESP" | jq -r '.ok')
if [ "$OK" != "true" ]; then
  echo "✗ manifest update failed:"
  echo "$RESP" | jq
  exit 1
fi

echo "✓ manifest applied"
echo "$RESP" | jq '{permissions_updated, app_id}'
PERMS=$(echo "$RESP" | jq -r '.permissions_updated')
if [ "$PERMS" = "true" ]; then
  echo ""
  echo "⚠  scopes changed — reinstall needed:"
  echo "   open https://api.slack.com/apps/$APP_ID/install-on-team"
  echo "   click 'Reinstall to Workspace' and re-pipe the new bot token:"
  echo "   jq -r .SLACK_BOT_TOKEN ~/.cells/secrets.json | (cd cli/worker/slack && bunx wrangler secret put SLACK_BOT_TOKEN)"
fi
