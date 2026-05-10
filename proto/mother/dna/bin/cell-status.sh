#!/usr/bin/env bash
# Render the right-hand side of the cell's tmux status bar.
# Reads /cell/.pi/status.json (written at birth, updated on channel
# link/unlink from the laptop side via well_exec). Output is single-
# line, picked up by tmux's status-right via #(...).
#
#   🤖 pi    💬 #cells-pete
#
# Stays silent (empty output) if status.json is missing or unparseable so
# tmux just shows nothing rather than an error string.
set -euo pipefail

STATUS="/cell/.pi/status.json"
[ -f "$STATUS" ] || exit 0

jq -r '
  def channels_seg: if ((.channels // []) | length > 0)
    then "    💬 " + (.channels | join(", "))
    else "" end;
  "🤖 " + (.harness // "?") + channels_seg
' "$STATUS" 2>/dev/null || true
