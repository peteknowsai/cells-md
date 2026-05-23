#!/bin/bash
# bake-stress.sh — empirical bake-reliability harness.
#
# Bakes N eggs in sequence through the normal `cells pool bake-v1` path —
# same pipeline production uses, including the wake-validate round-trip
# added 2026-05-22. Each bake either lands in the pool as state=open (the
# wake-validate passed) or gets logged to ~/.cells/logs/bake-failures/ +
# either destroyed or kept alive for forensics.
#
# Use this to gather a failure-rate sample and a failure-mode histogram
# before deciding whether a bug needs a bake-step fix vs. a wells-team
# discussion. Don't run this concurrently with another bake or birth —
# they serialize on the welld bundle work and pool lock.
#
# Usage:
#   scripts/bake-stress.sh --count 20
#   scripts/bake-stress.sh --count 10 --keep-failures
#
# Flags:
#   --count N           how many bakes to attempt (default 10)
#   --keep-failures     set CELLS_BAKE_KEEP_FAILURES=1 so failed wells
#                       stay alive for inspection (well exec, well console,
#                       welld API). Successes still get destroyed below to
#                       keep the pool depth from drifting.
#   --no-cleanup        also keep successes (default: destroy successes so
#                       this script is pool-neutral)
set -uo pipefail
cd "$(dirname "$0")/.."

count=10
keep_failures=0
no_cleanup=0
while [ $# -gt 0 ]; do
  case "$1" in
    --count)         count="$2"; shift 2;;
    --keep-failures) keep_failures=1; shift;;
    --no-cleanup)    no_cleanup=1; shift;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

CELLS="bun cli/cells.ts"
LOG_DIR="$HOME/.cells/logs/bake-stress"
mkdir -p "$LOG_DIR"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_LOG="$LOG_DIR/run-$RUN_ID.log"
: > "$RUN_LOG"

echo "bake-stress run $RUN_ID — count=$count keep_failures=$keep_failures no_cleanup=$no_cleanup" | tee -a "$RUN_LOG"
echo "log: $RUN_LOG" | tee -a "$RUN_LOG"
echo

ok=0
fail=0
fail_wells=()
ok_wells=()

# Snapshot pool ids before so we can identify the bake's new entry post-success.
before=$(python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.cells/pool.json')));print(' '.join(m['well_name'] for m in d['members']))")

for i in $(seq 1 "$count"); do
  echo "--- bake $i/$count ---" | tee -a "$RUN_LOG"
  start=$(date +%s)
  if [ "$keep_failures" -eq 1 ]; then
    out=$(CELLS_BAKE_KEEP_FAILURES=1 $CELLS pool bake-v1 2>&1)
  else
    out=$($CELLS pool bake-v1 2>&1)
  fi
  rc=$?
  dur=$(( $(date +%s) - start ))
  echo "$out" | tee -a "$RUN_LOG"
  if [ $rc -eq 0 ]; then
    ok=$((ok+1))
    # Identify the new well by diffing pool against pre-snapshot.
    new=$(python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.cells/pool.json')));before=set('$before'.split());[print(m['well_name']) for m in d['members'] if m['well_name'] not in before]" | tail -1)
    ok_wells+=("$new")
    echo "  OK   ${dur}s  $new" | tee -a "$RUN_LOG"
  else
    fail=$((fail+1))
    # Extract the well name from the bake output (validation error mentions it).
    new=$(echo "$out" | grep -oE 'egg-[a-f0-9]+' | head -1)
    [ -n "$new" ] && fail_wells+=("$new")
    echo "  FAIL ${dur}s  ${new:-unknown}" | tee -a "$RUN_LOG"
  fi
  echo | tee -a "$RUN_LOG"
done

# Pool-neutral cleanup: destroy the successes so the pool isn't N deeper
# than we found it. (Skip if --no-cleanup.)
if [ "$no_cleanup" -eq 0 ] && [ ${#ok_wells[@]} -gt 0 ]; then
  echo "--- cleanup: destroying ${#ok_wells[@]} successful bake(s) to keep pool depth neutral ---" | tee -a "$RUN_LOG"
  for w in "${ok_wells[@]}"; do
    [ -z "$w" ] && continue
    well destroy "$w" --force 2>&1 | tail -1 | tee -a "$RUN_LOG"
    # Sweep pool.json so cells doesn't think the now-gone egg is still open.
    python3 - "$w" <<'PY' | tee -a "$RUN_LOG"
import json, os, sys
w = sys.argv[1]
p = os.path.expanduser('~/.cells/pool.json')
d = json.load(open(p))
n_before = len(d['members'])
d['members'] = [m for m in d['members'] if m['well_name'] != w]
n_after = len(d['members'])
json.dump(d, open(p,'w'), indent=2)
print(f"  pool: pruned {n_before-n_after} entry for {w}")
PY
  done
fi

echo
echo "=== SUMMARY ==="                                          | tee -a "$RUN_LOG"
echo "OK:   $ok / $count"                                       | tee -a "$RUN_LOG"
echo "FAIL: $fail / $count"                                     | tee -a "$RUN_LOG"
if [ "$fail" -gt 0 ]; then
  echo                                                          | tee -a "$RUN_LOG"
  echo "failure logs:"                                          | tee -a "$RUN_LOG"
  ls -1t "$HOME/.cells/logs/bake-failures/" 2>/dev/null | head -"$fail" | sed 's|^|  ~/.cells/logs/bake-failures/|' | tee -a "$RUN_LOG"
  if [ "$keep_failures" -eq 1 ] && [ ${#fail_wells[@]} -gt 0 ]; then
    echo                                                        | tee -a "$RUN_LOG"
    echo "failed wells kept alive (well info / well exec to inspect):" | tee -a "$RUN_LOG"
    for w in "${fail_wells[@]}"; do
      [ -n "$w" ] && echo "  $w"                                | tee -a "$RUN_LOG"
    done
  fi
fi
echo                                                            | tee -a "$RUN_LOG"
echo "full log: $RUN_LOG"
