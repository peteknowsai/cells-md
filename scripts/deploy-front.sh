#!/usr/bin/env bash
# Publish the cells.md front door (landing + deck + gallery).
#
# Stages canonical HTML files into the front Worker's asset dir and deploys
# as `cells-front-brief` (custom domains cells.md + brief.cells.md).
# Re-run any time docs/proposals/cells-landing.html, what-is-cells.html, or
# cells-gallery.html changes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_LANDING="$REPO_ROOT/docs/proposals/cells-landing.html"
SRC_BRIEF="$REPO_ROOT/docs/proposals/what-is-cells.html"
SRC_GALLERY="$REPO_ROOT/docs/proposals/cells-gallery.html"
WORKER_DIR="$REPO_ROOT/cli/worker/front"
PUBLIC="$WORKER_DIR/public"

[ -f "$SRC_LANDING" ] || { echo "missing source: $SRC_LANDING"; exit 1; }
[ -f "$SRC_BRIEF" ]   || { echo "missing source: $SRC_BRIEF"; exit 1; }
[ -f "$SRC_GALLERY" ] || { echo "missing source: $SRC_GALLERY"; exit 1; }

# Reset and rebuild the public/ tree so removed routes don't linger.
rm -rf "$PUBLIC"
mkdir -p "$PUBLIC/brief" "$PUBLIC/gallery"

cp "$SRC_LANDING" "$PUBLIC/index.html"
cp "$SRC_BRIEF"   "$PUBLIC/brief/index.html"
cp "$SRC_GALLERY" "$PUBLIC/gallery/index.html"

echo "staged $(wc -c < "$PUBLIC/index.html"         | tr -d ' ') bytes -> /"
echo "staged $(wc -c < "$PUBLIC/brief/index.html"   | tr -d ' ') bytes -> /brief"
echo "staged $(wc -c < "$PUBLIC/gallery/index.html" | tr -d ' ') bytes -> /gallery"

cd "$WORKER_DIR"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-5a6fef07a998d84ec047ef43d0543342}" \
  wrangler deploy

echo
echo "deployed -> https://www.cells.md (cells.md + brief.cells.md 301 here)"
