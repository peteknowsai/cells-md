#!/usr/bin/env bash
# Publish the cells.md front door.
#   /              landing          (cells-landing.html)
#   /capabilities  capability tour   (cells-capabilities.html)
#   /brief         the deck          (what-is-cells.html)
#   /gallery       image gallery     (cells-gallery.html)
#   /colony        jurypool colony   (cells-colony.html + portrait.png)
#
# Stages canonical files into the front Worker's asset dir and deploys
# as `cells-front-brief` (custom domains cells.md + www.cells.md + brief.cells.md).
# Re-run any time a source file under docs/proposals/ changes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCS="$REPO_ROOT/docs/proposals"
WORKER_DIR="$REPO_ROOT/cli/worker/front"
PUBLIC="$WORKER_DIR/public"

SRC_LANDING="$DOCS/cells-landing.html"
SRC_CAPS="$DOCS/cells-capabilities.html"
SRC_BRIEF="$DOCS/what-is-cells.html"
SRC_GALLERY="$DOCS/cells-gallery.html"
SRC_COLONY="$DOCS/cells-colony.html"
SRC_PORTRAIT="$REPO_ROOT/colonies/jurypool/portraits/colony-portrait.png"

for f in "$SRC_LANDING" "$SRC_CAPS" "$SRC_BRIEF" "$SRC_GALLERY" "$SRC_COLONY" "$SRC_PORTRAIT"; do
  [ -f "$f" ] || { echo "missing source: $f"; exit 1; }
done

# Reset and rebuild the public/ tree so removed routes don't linger.
rm -rf "$PUBLIC"
mkdir -p "$PUBLIC/capabilities" "$PUBLIC/brief" "$PUBLIC/gallery" "$PUBLIC/colony"

cp "$SRC_LANDING"  "$PUBLIC/index.html"
cp "$SRC_CAPS"     "$PUBLIC/capabilities/index.html"
cp "$SRC_BRIEF"    "$PUBLIC/brief/index.html"
cp "$SRC_GALLERY"  "$PUBLIC/gallery/index.html"
cp "$SRC_COLONY"   "$PUBLIC/colony/index.html"
cp "$SRC_PORTRAIT" "$PUBLIC/colony/portrait.png"

echo "staged:"
echo "  /              $(wc -c < "$PUBLIC/index.html" | tr -d ' ') bytes"
echo "  /capabilities  $(wc -c < "$PUBLIC/capabilities/index.html" | tr -d ' ') bytes"
echo "  /brief         $(wc -c < "$PUBLIC/brief/index.html" | tr -d ' ') bytes"
echo "  /gallery       $(wc -c < "$PUBLIC/gallery/index.html" | tr -d ' ') bytes"
echo "  /colony        $(wc -c < "$PUBLIC/colony/index.html" | tr -d ' ') bytes + portrait.png"

cd "$WORKER_DIR"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-5a6fef07a998d84ec047ef43d0543342}" \
  wrangler deploy

echo
echo "deployed -> https://www.cells.md (cells.md + brief.cells.md 301 here)"
