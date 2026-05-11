#!/usr/bin/env bash
# V1.STEP6 perf-measurement script. Runs N births in cold mode (pool empty)
# and warm mode (pool refilled), aggregates from ~/.cells/logs/perf/birth.jsonl.
#
# Usage: scripts/perf-birth.sh [N_COLD] [N_WARM]
set -euo pipefail

N_COLD="${1:-5}"
N_WARM="${2:-5}"

PERF_LOG="$HOME/.cells/logs/perf/birth.jsonl"
TOKEN=$(cat ~/.wells/token)
API="http://127.0.0.1:7878"

# Kill the most-recent cell from cells.json (the one just birthed).
# Does NOT touch egg wells in the pool — important so warm-runs can reuse
# the post-birth-refill's warm egg.
kill_last_cell() {
  local n
  n=$(python3 -c "
import json
with open('$HOME/.cells/cells.json') as f: d = json.load(f)
cells = [c for c in d.get('cells', []) if c['name'].startswith('cell-')]
if cells:
  print(cells[-1]['name'])
")
  if [ -n "$n" ]; then
    bun run cells kill "$n" --yes >/dev/null 2>&1 || true
  fi
}

drain_pool() {
  bun run cells egg drain -y >/dev/null 2>&1 || true
}

ensure_warm() {
  bun run cells egg refill-v1 >/dev/null 2>&1
}

reset_perf() {
  rm -f "$PERF_LOG"
}

echo "=== V1.STEP6 perf — $N_COLD cold + $N_WARM warm ==="
echo

reset_perf

echo "--- cold runs ---"
for i in $(seq 1 "$N_COLD"); do
  drain_pool                                           # ensure empty pool
  T0=$(date +%s)
  bun run cells birth --seed=off >/dev/null 2>&1      # cold-fork
  T1=$(date +%s)
  echo "cold #$i: wall=$((T1-T0))s"
  kill_last_cell                                       # tidy
done

echo
echo "--- warm runs ---"
ensure_warm                                            # prime once
for i in $(seq 1 "$N_WARM"); do
  ensure_warm                                          # idempotent — refill if pool drained
  T0=$(date +%s)
  bun run cells birth --seed=off >/dev/null 2>&1      # warm path
  T1=$(date +%s)
  echo "warm #$i: wall=$((T1-T0))s"
  kill_last_cell
done

echo
echo "=== aggregating from $PERF_LOG ==="
python3 -c "
import json
from statistics import median
cold = []; warm = []
with open('$PERF_LOG') as f:
  for line in f:
    row = json.loads(line)
    if row['path'] == 'cold': cold.append(row['alive_ms'])
    elif row['path'] == 'pool': warm.append(row['alive_ms'])

def stats(label, samples):
  if not samples:
    print(f'{label}: no samples')
    return
  s = sorted(samples)
  p50 = median(s)
  p95 = s[int(len(s) * 0.95)] if len(s) > 1 else s[-1]
  mn = min(s); mx = max(s)
  print(f'{label}: n={len(samples)}  p50={p50/1000:.2f}s  p95={p95/1000:.2f}s  min={mn/1000:.2f}s  max={mx/1000:.2f}s')

stats('cold', cold)
stats('warm', warm)
"

# Final cleanup
drain_pool
kill_last_cell
echo
echo "=== cleanup done ==="
