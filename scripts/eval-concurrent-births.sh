#!/usr/bin/env bash
# Fire N births in parallel. Captures per-birth wall-clock + overall wall-clock.
# Mother lock currently serializes them; this measures whether that's the only
# serializer (per-birth time unchanged) or if there's hidden contention (slower).
#
# Usage: scripts/eval-concurrent-births.sh [N=3] [prefix=mcpar]

set -euo pipefail
N="${1:-3}"
PREFIX="${2:-mcpar}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

RESULTS="/tmp/eval-concurrent-$(date +%Y%m%dT%H%M%S).csv"
echo "run,name,t_start,t_end,wall_s,success" > "$RESULTS"

T_OVERALL_START=$(date +%s)
echo "firing $N parallel births..."

PIDS=()
for i in $(seq 1 "$N"); do
  NAME="${PREFIX}-$(date +%s)-$i"
  (
    T0=$(date +%s)
    if bun cli/cells.ts birth "$NAME" --harness=pi --model=gpt-5.5 --thinking=low --seed=off > "/tmp/par-$NAME.log" 2>&1; then
      SUCCESS=true
    else
      SUCCESS=false
    fi
    T1=$(date +%s)
    echo "$i,$NAME,$T0,$T1,$((T1-T0)),$SUCCESS" >> "$RESULTS"
    echo "  [done] $NAME wall=$((T1-T0))s success=$SUCCESS"
  ) &
  PIDS+=($!)
done

# Wait for all
for pid in "${PIDS[@]}"; do wait "$pid"; done
T_OVERALL_END=$(date +%s)
OVERALL=$((T_OVERALL_END - T_OVERALL_START))

echo
echo "=== summary ==="
column -t -s, "$RESULTS"
echo
echo "overall wall (parent): ${OVERALL}s"
echo "per-birth walls:       $(awk -F, 'NR>1 {print $5}' "$RESULTS" | tr '\n' ' ')"
echo "success:               $(awk -F, 'NR>1 && $6=="true"{ok++} END{print ok"/"NR-1}' "$RESULTS")"

# Cleanup
echo
echo "killing test cells..."
for i in $(seq 1 "$N"); do
  name=$(awk -F, -v i=$i 'NR==i+1 {print $2}' "$RESULTS")
  bun cli/cells.ts kill "$name" -y > /dev/null 2>&1 || echo "  ! kill $name failed"
done
echo "done."
