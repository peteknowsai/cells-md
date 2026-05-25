#!/usr/bin/env bash
# lume-orphans — list (and optionally reclaim) ~/.lume/<name>/ entries
# not tracked by welld.
#
# Background: ~/.lume holds the disk.img for every well lume has ever
# created.  When `well destroy --force` succeeds, the matching
# ~/.lume/<name>/ dir is rm -rf'd via wells's destroyWell pipeline
# (lume.delete → bundle rm).  Orphans accumulate when historical code
# paths bypass that pipeline (pre-Pi3 bake/churn artifacts) or when
# wells's lume.delete swallows a transient error.
#
# Wells confirmed 2026-05-25: `well destroy --force <orphan>` is the
# correct one-shot cleanup — it no-ops on names welld can't see and
# rm's the bundle dir cleanly.  The first run of this script on stable
# surfaced 106 orphans / ~598 GB; wells swept them in 13s with zero
# failures.  --clean mode here is the same loop, runnable on this side
# without waiting on a human in the wells channel.
#
# Modes:
#   (default)        human-readable orphan listing + size totals
#   --print-names    names only, one per line, for piping
#   --clean          interactive: list + prompt + destroy each orphan
#   --clean --yes    non-interactive: destroy each orphan without prompt

set -euo pipefail

MODE="human"
YES=0
for arg in "$@"; do
  case "$arg" in
    --print-names) MODE="--print-names" ;;
    --clean)       MODE="--clean" ;;
    --yes|-y)      YES=1 ;;
    -h|--help)
      cat <<'USAGE'
lume-orphans — list (and optionally reclaim) ~/.lume entries not tracked by welld.

Usage:
  lume-orphans.sh                  human-readable listing + size totals (default)
  lume-orphans.sh --print-names    names only, one per line, for piping
  lume-orphans.sh --clean          list, prompt, then `well destroy --force` each
  lume-orphans.sh --clean --yes    same, skip the prompt (scripted use)

Cleanup uses wells's destroyWell pipeline; falls back to direct rm if the
bundle dir survives the API call (rare — flagged for wells's followup 2026-05-25).
USAGE
      exit 0
      ;;
    *)
      echo "usage: $0 [--print-names | --clean [--yes]]" >&2
      exit 2
      ;;
  esac
done

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
  case "$MODE" in
    human|--clean) echo "no orphans. every ~/.lume entry is tracked by welld." ;;
  esac
  exit 0
fi

# --print-names mode: emit just the names and exit, for piping into a
# cleanup command.  Kept separate from the human-readable run so an
# accidental `... | xargs rm -rf` can't be conjured from default output.
if [ "$MODE" = "--print-names" ]; then
  printf '%s\n' "$ORPHANS"
  exit 0
fi

# Human-readable orphan table (used by both `human` and `--clean` modes).
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

human_total() {
  if [ "$TOTAL_KB" -gt 1048576 ]; then
    awk -v kb="$TOTAL_KB" 'BEGIN { printf "%.1f GB", kb/1024/1024 }'
  elif [ "$TOTAL_KB" -gt 1024 ]; then
    awk -v kb="$TOTAL_KB" 'BEGIN { printf "%.1f MB", kb/1024 }'
  else
    printf '%d KB' "$TOTAL_KB"
  fi
}

echo
echo "Total reclaimable: ~$(human_total)"

if [ "$MODE" = "human" ]; then
  cat <<MSG

To reclaim: re-run with --clean (interactive confirmation) or --clean --yes
(non-interactive).  Uses 'well destroy --force <orphan>' per orphan; wells's
destroyWell handles the bundle rm via lume.delete.
MSG
  exit 0
fi

# --clean mode.
if ! command -v well >/dev/null 2>&1; then
  echo
  echo "! 'well' CLI not on PATH — can't run --clean" >&2
  exit 3
fi

echo
if [ "$YES" -ne 1 ]; then
  printf 'Destroy %d orphan(s), freeing ~%s? [y/N] ' "$ORPHAN_COUNT" "$(human_total)"
  read -r reply </dev/tty || reply=""
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "aborted."; exit 0 ;;
  esac
fi

OK=0
FAIL=0
FREED_KB=0
FAILED_NAMES=""
while IFS= read -r o; do
  [ -z "$o" ] && continue
  KB=$(du -sk "$LUME_DIR/$o" 2>/dev/null | awk '{print $1}')
  [ -z "$KB" ] && KB=0
  printf '  destroying %s … ' "$o"
  if well destroy "$o" --force >/dev/null 2>&1; then
    if [ -d "$LUME_DIR/$o" ]; then
      # Wells's destroyWell ran but the bundle dir survived — fall back
      # to direct rm (last-resort path), since at this point welld no
      # longer claims the well.  This is the silent-catch case wells
      # flagged for their own followup.
      rm -rf "$LUME_DIR/$o" 2>/dev/null && \
        printf 'ok (rm fallback, %s)\n' "$(awk -v k="$KB" 'BEGIN { if (k>1024) printf "%.1f MB", k/1024; else printf "%d KB", k }')" || \
        printf 'fail (well destroy ok but bundle still present)\n'
    else
      printf 'ok (%s)\n' "$(awk -v k="$KB" 'BEGIN { if (k>1024) printf "%.1f MB", k/1024; else printf "%d KB", k }')"
    fi
    OK=$((OK + 1))
    FREED_KB=$((FREED_KB + KB))
  else
    printf 'FAIL\n'
    FAIL=$((FAIL + 1))
    FAILED_NAMES="$FAILED_NAMES $o"
  fi
done <<< "$ORPHANS"

echo
freed_human=$(awk -v kb="$FREED_KB" 'BEGIN {
  if (kb>1048576) printf "%.1f GB", kb/1024/1024;
  else if (kb>1024) printf "%.1f MB", kb/1024;
  else printf "%d KB", kb;
}')
echo "Done. Destroyed $OK orphan(s) (~$freed_human freed); $FAIL failure(s)."
if [ "$FAIL" -gt 0 ]; then
  echo "Failed:$FAILED_NAMES"
  echo "Re-run --clean to retry; persistent failures likely need wells team attention."
  exit 1
fi
