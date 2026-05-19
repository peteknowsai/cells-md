#!/usr/bin/env bash
# Publish the "what is cells" deck + the image gallery to https://brief.cells.md.
#
# Copies the canonical HTML files into the brief Worker's asset dir and deploys
# them as the cells-front-brief Worker (custom domain brief.cells.md).
# Re-run any time docs/proposals/what-is-cells.html or cells-gallery.html changes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_BRIEF="$REPO_ROOT/docs/proposals/what-is-cells.html"
SRC_GALLERY="$REPO_ROOT/docs/proposals/cells-gallery.html"
WORKER_DIR="$REPO_ROOT/cli/worker/brief"
PUBLIC="$WORKER_DIR/public"

[ -f "$SRC_BRIEF" ]   || { echo "missing source: $SRC_BRIEF"; exit 1; }
[ -f "$SRC_GALLERY" ] || { echo "missing source: $SRC_GALLERY"; exit 1; }

mkdir -p "$PUBLIC"
cp "$SRC_BRIEF"   "$PUBLIC/index.html"
cp "$SRC_GALLERY" "$PUBLIC/cells-gallery.html"
echo "staged $(wc -c < "$PUBLIC/index.html" | tr -d ' ') bytes -> $PUBLIC/index.html"
echo "staged $(wc -c < "$PUBLIC/cells-gallery.html" | tr -d ' ') bytes -> $PUBLIC/cells-gallery.html"

cd "$WORKER_DIR"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-5a6fef07a998d84ec047ef43d0543342}" \
  wrangler deploy

echo
echo "deployed -> https://brief.cells.md"
