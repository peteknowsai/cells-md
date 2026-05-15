#!/usr/bin/env bash
# Deploy the wells-dashboard Worker — owns wells.cells.md +
# wells-convex.cells.md and proxies to the wells team's cloudflared
# tunnel. No auth at the edge: hostnames aren't published anywhere
# and the dashboard is for Pete's eyes; layer auth in the dashboard
# itself if it ever matters.
#
# Pre-reqs: ~/.cells/secrets.json carries CLOUDFLARE_ACCOUNT_ID. The
# public→internal hostname mapping is inlined in index.ts (`UPSTREAM`
# const) — edit there if the tunnel hostnames change on the wells side.
#
# Usage: scripts/deploy-wells-dashboard.sh

set -euo pipefail

SECRETS="$HOME/.cells/secrets.json"
[ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }

CF_ACCOUNT_ID=$(jq -r '.CLOUDFLARE_ACCOUNT_ID // empty' "$SECRETS")
[ -n "$CF_ACCOUNT_ID" ] || { echo "no CLOUDFLARE_ACCOUNT_ID in $SECRETS"; exit 1; }
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"

REPO_ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/cli/worker/wells-dashboard"
[ -f "$WORKER_DIR/wrangler.toml" ] || { echo "missing $WORKER_DIR/wrangler.toml"; exit 1; }

cd "$WORKER_DIR"

echo "→ wrangler deploy wells-dashboard"
bunx wrangler deploy

echo "✓ wells-dashboard deployed"
echo "  routes:    wells.cells.md, wells-convex.cells.md"
echo "  upstream:  wells-tunnel.cells.md, wells-convex-tunnel.cells.md"
echo "  url:       https://wells.cells.md"
