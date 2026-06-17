#!/usr/bin/env bash
# Fire birth-postwork.sh detached and return immediately — so the birth
# declaration never waits on the post-birth tail (Worker deploy, channels,
# checkpoint, …). Status lands in ~/.cells/postwork/<name>.json + the log.
#
# Usage: birth-postwork-bg.sh <name> <well> <blob>   (blob: raw JSON or @path)
#
# A one-line wrapper so the birth recipe (any harness) can fire postwork with
# `cells-bridge mac-exec "bash scripts/birth-postwork-bg.sh '<n>' '<w>' '<b>'"`
# instead of hand-quoting a nohup pipeline in a tool call.
set -uo pipefail

NAME="${1:?usage: birth-postwork-bg.sh <name> <well> <blob>}"
WELL="${2:?usage: birth-postwork-bg.sh <name> <well> <blob>}"
BLOB="${3:?usage: birth-postwork-bg.sh <name> <well> <blob>}"

REPO="${CELLS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG="$HOME/.cells/logs/birth-postwork/$NAME.log"
mkdir -p "$(dirname "$LOG")"

cd "$REPO"
nohup bash scripts/birth-postwork.sh "$NAME" "$WELL" "$BLOB" > "$LOG" 2>&1 &
disown
echo "postwork fired for $NAME (log: $LOG)"
