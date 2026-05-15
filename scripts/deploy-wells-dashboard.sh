#!/usr/bin/env bash
# Deploy the wells-dashboard Worker — owns wells.cells.md +
# wells-convex.cells.md, gates with cookie/token, proxies to the
# wells team's cloudflared tunnel.
#
# Pre-reqs: ~/.cells/secrets.json carries WELLS_DASHBOARD_BEARER and
# CLOUDFLARE_ACCOUNT_ID. The public→internal hostname mapping is inlined
# in index.ts (`UPSTREAM` const) — edit there if the tunnel hostnames
# change on the wells side.
#
# Usage: scripts/deploy-wells-dashboard.sh

set -euo pipefail

SECRETS="$HOME/.cells/secrets.json"
[ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }

BEARER=$(jq -r '.WELLS_DASHBOARD_BEARER // empty' "$SECRETS")
[ -n "$BEARER" ] || { echo "no WELLS_DASHBOARD_BEARER in $SECRETS"; exit 1; }

CF_ACCOUNT_ID=$(jq -r '.CLOUDFLARE_ACCOUNT_ID // empty' "$SECRETS")
[ -n "$CF_ACCOUNT_ID" ] || { echo "no CLOUDFLARE_ACCOUNT_ID in $SECRETS"; exit 1; }
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"

REPO_ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/cli/worker/wells-dashboard"
[ -f "$WORKER_DIR/wrangler.toml" ] || { echo "missing $WORKER_DIR/wrangler.toml"; exit 1; }

cd "$WORKER_DIR"

echo "→ wrangler deploy wells-dashboard"
bunx wrangler deploy

echo "→ wrangler secret put WELLS_DASHBOARD_BEARER"
echo "$BEARER" | bunx wrangler secret put WELLS_DASHBOARD_BEARER

echo "✓ wells-dashboard deployed"
echo "  routes:    wells.cells.md, wells-convex.cells.md"
echo "  upstream:  wells-tunnel.cells.md, wells-convex-tunnel.cells.md"
echo "  bookmark:  https://wells.cells.md/?token=$BEARER"
