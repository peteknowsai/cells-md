#!/usr/bin/env bash
# lume-orphans — list ~/.lume/<name>/ entries not tracked by welld.
#
# Background: ~/.lume holds the disk.img for every well lume has ever
# created.  When `well destroy --force` succeeds, the matching
# ~/.lume/<name>/ dir should be rm -rf'd by wells.  In practice we've
# seen 100+ orphan dirs accumulate (~598GB on stable as of 2026-05-25),
# from a mix of old code paths (bake-*, churn-*) and possible cleanup
# misses on the wells side.
#
# This script is read-only: it prints the orphan set with disk sizes
# and suggests cleanup commands.  Decide with the wells team — disk
# lifecycle is theirs to own.

set -euo pipefail

MODE="${1:-human}"
if [ "$MODE" != "human" ] && [ "$MODE" != "--print-names" ]; then
  echo "usage: $0 [--print-names]" >&2
  exit 2
fi

LUME_DIR="${HOME}/.lume"

if [ ! -d "$LUME_DIR" ]; then
  echo "no ~/.lume dir; nothing to do" >&2
  exit 0
fi

# Live wells = welld's authoritative view.  If welld is down, fall back
# to ~/.wells/registry.json (best-effort) so we don't false-positive
# every well on the host as an orphan.
wells_known() {
  local from_api
  from_api=$(well list 2>/dev/null | awk 'NR>1 && $1 != "" {print $1}' | sort -u)
  if [ -n "$from_api" ]; then
    printf '%s\n' "$from_api"
    return 0
  fi
  echo "warn: 'well list' returned empty — falling back to ~/.wells/registry.json" >&2
  local reg="${HOME}/.wells/registry.json"
  if [ -f "$reg" ]; then
    # registry shape: { wells: [ { name: "...", ... }, ... ] }
    if command -v jq >/dev/null 2>&1; then
      jq -r '.wells[]?.name // empty' "$reg" 2>/dev/null | sort -u
    else
      # last-ditch grep — fragile but better than nothing
      grep -oE '"name"\s*:\s*"[^"]+"' "$reg" | sed -E 's/.*"name"\s*:\s*"([^"]+)".*/\1/' | sort -u
    fi
  fi
}

KNOWN=$(wells_known || true)
ENTRIES=$(ls "$LUME_DIR" 2>/dev/null | grep -Ev '^\.|^cache$' | sort -u)
ORPHANS=$(comm -23 <(echo "$ENTRIES") <(echo "$KNOWN"))

if [ -z "$ORPHANS" ]; then
  [ "$MODE" = "human" ] && echo "no orphans. every ~/.lume entry is tracked by welld."
  exit 0
fi

# --print-names mode: emit just the names and exit, for piping into a
# cleanup command.  Kept separate from the human-readable run so an
# accidental `... | xargs rm -rf` can't be conjured from default output.
if [ "$MODE" = "--print-names" ]; then
  printf '%s\n' "$ORPHANS"
  exit 0
fi

ORPHAN_COUNT=$(echo "$ORPHANS" | wc -l | tr -d ' ')
echo "Found $ORPHAN_COUNT orphan(s) in $LUME_DIR (not in welld's view):"
echo

TMP=$(mktemp)
TOTAL_KB=0
while IFS= read -r o; do
  [ -z "$o" ] && continue
  KB=$(du -sk "$LUME_DIR/$o" 2>/dev/null | awk '{print $1}')
  [ -z "$KB" ] && KB=0
  printf '%s\t%s\n' "$KB" "$o" >> "$TMP"
  TOTAL_KB=$((TOTAL_KB + KB))
done <<< "$ORPHANS"

sort -rn "$TMP" | awk '{
  size = $1; name = $2;
  if (size > 1024*1024) printf "  %6.1f GB  %s\n", size/1024/1024, name;
  else if (size > 1024)  printf "  %6.1f MB  %s\n", size/1024, name;
  else                   printf "  %6d KB  %s\n", size, name;
}'
rm -f "$TMP"

echo
if [ "$TOTAL_KB" -gt 1024 ]; then
  TOTAL_GB=$(awk -v kb="$TOTAL_KB" 'BEGIN { printf "%.1f", kb/1024/1024 }')
  echo "Total reclaimable: ~${TOTAL_GB} GB"
else
  echo "Total reclaimable: ${TOTAL_KB} KB"
fi

cat <<MSG

Cleanup options — decide with the wells team (disk lifecycle is theirs):

  # A. Try the wells API first.  Cleanest if 'well destroy --force'
  #    actually removes ~/.lume/<name>/ (which is the expected
  #    behavior — if it doesn't, that's the bug to file).
  $0 --print-names | xargs -n1 well destroy --force

  # B. Direct rm if the wells API can't see them at all (last resort —
  #    bypasses welld's view).  Verify each one is truly orphaned first.
  $0 --print-names | xargs -I{} rm -rf "$LUME_DIR/{}"

This script is read-only.  Run with --print-names to emit just the
orphan names (one per line) for piping.
MSG
