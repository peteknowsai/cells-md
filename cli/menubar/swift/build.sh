#!/usr/bin/env bash
# Build the native Cells menubar .app.
#   ./build.sh <output-dir>
# Produces <output-dir>/CellsMenubar.app.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?usage: build.sh <output-dir>}"
mkdir -p "$out"

app="$out/CellsMenubar.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"

swiftc \
  -O \
  -target arm64-apple-macos13.0 \
  -framework AppKit \
  -o "$app/Contents/MacOS/CellsMenubar" \
  "$here/main.swift"

cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Cells Menubar</string>
  <key>CFBundleDisplayName</key><string>Cells Menubar</string>
  <key>CFBundleIdentifier</key><string>md.cells.menubar</string>
  <key>CFBundleExecutable</key><string>CellsMenubar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "built $app"
