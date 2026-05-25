#!/usr/bin/env bash
# install-doctor — set up ~/.cells/doctor/ from dna/specials/doctor/.
#
# Idempotent.  Copies/symlinks the special into place, marks the trigger
# scripts executable, and ensures state + findings dirs exist.
#
# Doesn't START the doctor — that's a manual step (Claude Code session in
# ~/.cells/doctor/, invoke `/doctor`).  See README for the start command.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/dna/specials/doctor"
DST="${HOME}/.cells/doctor"

if [ ! -d "$SRC" ]; then
  echo "! no doctor special at $SRC" >&2
  exit 1
fi

mkdir -p "$DST"

# Copy the special (files + .claude/skills) — overwrite each time so the
# install picks up source changes.  State and findings live outside the
# rsync target.
rsync -a \
  --exclude 'state/' \
  --exclude 'findings/' \
  "$SRC/" "$DST/"

chmod +x "$DST"/triggers/*.sh

mkdir -p "$DST/state" "$DST/findings"

echo "doctor installed at $DST"
echo
echo "to start:"
echo "  cd $DST && claude"
echo "  > /doctor"
echo
echo "to stop: end the Claude session (the Monitors die with it)."
