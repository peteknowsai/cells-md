#!/usr/bin/env bash
# Append one timestamped line per birth-skill step to a per-cell log.
# Called from the birth skill at the top of each numbered step. The
# harden loop reads these to spot which steps are eating time.
#
# Usage: log-birth-step.sh <cell-name> <step-id> <label...>
# Output: appends "<iso-ts-ns> <step-id> <label>" to
#         ~/.cells/logs/birth-timings/<cell-name>.log

set -eu

NAME="${1:?cell name required}"
STEP="${2:?step id required}"
shift 2
LABEL="$*"

DIR="${HOME}/.cells/logs/birth-timings"
mkdir -p "$DIR"

# Nanosecond precision — gnu date isn't on macOS by default. Bash's
# EPOCHREALTIME (bash >= 5) gives sub-second; coreutils gdate works too.
# Fallback: plain seconds (still useful at minute scale).
if [[ -n "${EPOCHREALTIME:-}" ]]; then
  TS="$EPOCHREALTIME"
elif command -v gdate >/dev/null 2>&1; then
  TS="$(gdate +%s.%N)"
else
  TS="$(date +%s)"
fi

printf '%s\t%s\t%s\n' "$TS" "$STEP" "$LABEL" >> "$DIR/$NAME.log"
