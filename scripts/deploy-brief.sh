#!/usr/bin/env bash
# Publish the "what is cells" deck to https://brief.cells.md.
#
# Copies the canonical HTML into the brief Worker's asset dir and deploys
# it as the cells-front-brief Worker (custom domain brief.cells.md).
# Re-run any time docs/proposals/what-is-cells.html changes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/docs/proposals/what-is-cells.html"
WORKER_DIR="$REPO_ROOT/cli/worker/brief"
PUBLIC="$WORKER_DIR/public"

[ -f "$SRC" ] || { echo "missing source: $SRC"; exit 1; }

mkdir -p "$PUBLIC"
cp "$SRC" "$PUBLIC/index.html"
echo "staged $(wc -c < "$PUBLIC/index.html" | tr -d ' ') bytes -> $PUBLIC/index.html"

cd "$WORKER_DIR"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-5a6fef07a998d84ec047ef43d0543342}" \
  wrangler deploy

echo
echo "deployed -> https://brief.cells.md"
