#!/usr/bin/env bash
# Deploy a per-cell Worker on Cloudflare. Renders the cell-Worker
# template (cli/worker/cell/wrangler.toml) with CELL=<name>, then runs
# `wrangler deploy` against the rendered config. Also pipes the shared
# CELLS_PROXY_SECRET in as a Worker secret.
#
# Pre-reqs (one-time):
#   bunx wrangler login
#   bunx wrangler kv namespace create CHANNELS
#   # paste the returned id into both wrangler.toml files
#
# Usage: scripts/deploy-cell-worker.sh <cell-name>
set -euo pipefail

NAME="${1:?usage: $0 <cell-name>}"
[[ "$NAME" =~ ^[a-z0-9-]+$ ]] || { echo "bad cell name: $NAME"; exit 1; }

SECRETS="$HOME/.cells/secrets.json"
[ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }
SECRET=$(jq -r '.CELLS_PROXY_SECRET // empty' "$SECRETS")
[ -n "$SECRET" ] || { echo "no CELLS_PROXY_SECRET in $SECRETS"; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO_ROOT/cli/worker/cell/wrangler.toml"
[ -f "$TEMPLATE" ] || { echo "missing template $TEMPLATE"; exit 1; }

# Look up the sprite's public host so the cell Worker can push to it.
SPRITE_HOST=$(sprite info -s "$NAME" 2>/dev/null | awk '/^URL:/ {sub(/^https?:\/\//, "", $2); print $2}')
[ -n "$SPRITE_HOST" ] || { echo "could not resolve sprite host for $NAME via 'sprite info'"; exit 1; }

# Render alongside index.ts so wrangler resolves main = "index.ts"
# correctly (it's relative to the config file, not cwd).
RENDERED="$REPO_ROOT/cli/worker/cell/.wrangler.${NAME}.toml"
LOG="$(mktemp -t deploy-cell-${NAME}.XXXXXX)"
trap 'rm -f "$RENDERED" "$LOG"' EXIT
sed -e "s/{{CELL}}/${NAME}/g" -e "s/{{SPRITE_HOST}}/${SPRITE_HOST}/g" "$TEMPLATE" > "$RENDERED"

cd "$REPO_ROOT/cli/worker/cell"

# Run wrangler quietly. On failure, dump captured output so the user
# has something to debug with; on success, stay silent — the caller
# prints the summary line.
if ! bunx wrangler deploy --config "$RENDERED" >>"$LOG" 2>&1; then
  echo "✗ wrangler deploy failed:"
  cat "$LOG"
  exit 1
fi
if ! echo "$SECRET" | bunx wrangler --config "$RENDERED" secret put CELLS_PROXY_SECRET >>"$LOG" 2>&1; then
  echo "✗ wrangler secret put failed:"
  cat "$LOG"
  exit 1
fi
