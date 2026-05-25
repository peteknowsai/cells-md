#!/usr/bin/env bash
# Deterministic per-cell color picker for the tmux status-left chip.
#
# Usage:  scripts/cell-color.sh <cell-name>
# Output: <bg> <fg>     (two whitespace-separated hex codes)
#
# Picks from a curated palette of ~20 readable bg+fg pairs. Stable for a
# given name — same name always gets the same color, no state stored
# anywhere. Birth substitutes the result into the cell's ~/.tmux.conf;
# retrofits do the same.
#
# Palette is hand-tuned — saturated enough to be distinguishable, with
# fg chosen for legible contrast (no "compute luminance" math).
set -euo pipefail

NAME="${1:?usage: $0 <cell-name>}"

# bg fg pairs. Add more as the fleet grows; the modulo keeps things stable.
PALETTE=(
  "#957FB8 #1F1F28"   # lilac on charcoal
  "#7E9CD8 #1F1F28"   # cornflower
  "#7FB4CA #1F1F28"   # sky
  "#8BCAA0 #1F1F28"   # sage
  "#C0A36E #1F1F28"   # ochre
  "#E6A57E #1F1F28"   # peach
  "#E46876 #FFFFFF"   # coral
  "#D27E99 #1F1F28"   # rose
  "#B8B95F #1F1F28"   # olive
  "#A6A0E0 #1F1F28"   # periwinkle
  "#6A9FB5 #FFFFFF"   # teal
  "#76946A #FFFFFF"   # forest
  "#C77C58 #FFFFFF"   # rust
  "#B392F0 #1F1F28"   # violet
  "#5A8C7B #FFFFFF"   # pine
  "#D9966B #1F1F28"   # apricot
  "#9B8AA8 #1F1F28"   # mauve
  "#5F87AF #FFFFFF"   # steel
  "#A78F5C #FFFFFF"   # bronze
  "#7AB87A #1F1F28"   # mint
)

# md5sum first 4 hex chars → integer → modulo into palette index.
HASH=$(printf %s "$NAME" | md5sum 2>/dev/null | cut -c1-4)
# md5sum isn't on macOS by default; fall back to md5 -q.
if [ -z "$HASH" ]; then
  HASH=$(printf %s "$NAME" | md5 -q | cut -c1-4)
fi

INDEX=$(( 0x$HASH % ${#PALETTE[@]} ))
echo "${PALETTE[$INDEX]}"
