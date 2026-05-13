#!/usr/bin/env bash
# V1.10 acceptance — burst N births, capture warm-path latency
#
# Births N=10 cells back-to-back. Each `cells birth --seed=off` is wrapped
# in `timeout` because the bun process hangs on fire-and-forget background
# promises (refill, prewarmHostBridge) — actual birth completes much sooner
# (~100ms warm-path per ~/.cells/logs/perf/birth.jsonl).
#
# Pass criteria (per BOARD.md V1.10):
#   - 9/10 warm-path hits (10th may drain pool to cold-fork)
#   - first-token p50 < 3s for warm-path
#   - no sibling-clip during burst (W.74)
set -euo pipefail

N="${1:-10}"
CELLS_BIN="bun cli/cells.ts"
PERF_LOG="$HOME/.cells/logs/perf/birth.jsonl"

# Snapshot current count of pool entries in birth.jsonl so we can count
# new entries after the burst.
PRE_COUNT=$(wc -l < "$PERF_LOG" 2>/dev/null || echo 0)

echo "=== V1.10 acceptance (burst $N) ==="
echo "pre-test pool state:"
$CELLS_BIN pool list 2>&1 | head -15
echo

T_START=$(date +%s%N)
for i in $(seq 1 "$N"); do
  NAME="v110-burst-$$-$i"
  T0=$(date +%s%N)
  timeout 15 $CELLS_BIN birth "$NAME" --seed=off >/dev/null 2>&1 || true
  T1=$(date +%s%N)
  echo "  burst-$i: $NAME  wall=$(( (T1-T0)/1000000 ))ms"
done
T_END=$(date +%s%N)
echo
echo "burst wall total: $(( (T_END-T_START)/1000000 ))ms"
echo

# Aggregate alive_ms from new birth.jsonl entries
echo "--- alive_ms aggregate (new rows from this burst):"
python3 -c "
from statistics import median
import json

new_rows = []
with open('$PERF_LOG') as f:
    lines = f.readlines()
new_rows = [json.loads(l) for l in lines[$PRE_COUNT:]]

pool_rows = [r for r in new_rows if r.get('path') == 'pool']
cold_rows = [r for r in new_rows if r.get('path') in ('cold', 'cold-fork')]

print(f'  pool-path births: {len(pool_rows)}')
print(f'  cold-fork births: {len(cold_rows)}')

if pool_rows:
    samples = sorted([r['alive_ms'] for r in pool_rows])
    p50 = median(samples)
    p95 = samples[int(len(samples) * 0.95)] if len(samples) > 1 else samples[-1]
    mn, mx = min(samples), max(samples)
    print(f'  pool: n={len(samples)}  p50={p50}ms  p95={p95}ms  min={mn}ms  max={mx}ms')
    if p50 < 3000:
        print('  ✓ pool p50 < 3000ms target')
    else:
        print('  ✗ pool p50 ≥ 3000ms')

if cold_rows:
    samples = sorted([r['alive_ms'] for r in cold_rows])
    print(f'  cold: n={len(samples)}  p50={median(samples)}ms')
"

echo
echo "--- post-burst pool state:"
$CELLS_BIN pool list 2>&1 | head -15
echo
echo "=== V1.10 done ==="
