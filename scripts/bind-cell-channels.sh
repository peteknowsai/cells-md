#!/usr/bin/env bash
# Bind all channels listed in a cell's blob.channels array. Idempotent —
# bind-channel.ts itself short-circuits if the binding already exists.
#
# Usage: bind-cell-channels.sh <name> <blob-json>
#
# Called from the birthing ritual's post-birth section. Pulled out of the
# skill so the LLM doesn't have to construct a per-channel loop in bash —
# one Mac-side call handles slack + email + anything we add later.

set -euo pipefail
NAME="${1:?cell name required}"
BLOB="${2:?blob JSON required}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CHANNELS=$(echo "$BLOB" | jq -r '.channels[]? // empty')
if [ -z "$CHANNELS" ]; then
  echo "no channels requested"
  exit 0
fi

for ch in $CHANNELS; do
  echo "binding $ch → $NAME"
  if bun scripts/bind-channel.ts "$NAME" "$ch"; then
    echo "  ok"
  else
    echo "  ! bind $ch failed (continuing — other channels may still bind)"
  fi
done
