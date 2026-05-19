#!/usr/bin/env bash
# V1.5 acceptance — sleep + auto-wake + sibling-survive
#
# Runbook for post-Piece-2 verification. Tests VM-level hibernate/wake
# through `cells sleep` + welld /wake (auto-wake-on-traffic is via welld,
# not the talk model path). Skips the talk-greeting model interaction
# because the cold-fork model warmup can take a while to first-token;
# V1.5's load-bearing question is "does sleep+wake work without
# clipping siblings", which is a welld-level invariant.
#
# Assumes:
#   - welld is running, /healthz OK
#   - 2 cells exist (alice, bob) — pass names as $1 $2 or default to first 2 alive cells
#
# Pass criteria (per BOARD.md V1.5):
#   - sleep duration <2s (target 0.6s)
#   - sibling welld /v1/wells/<bob> status stays "running" during sleep+wake of alice
#   - wake duration <3s (target 1.9s, welld /wake)
set -euo pipefail

CELLS_BIN="bun cli/cells.ts"
TOKEN=$(cat ~/.wells/token)
API="http://127.0.0.1:7878"

ms_since() {
  local t0=$1
  local t1=$(date +%s%N)
  echo $(( (t1 - t0) / 1000000 ))
}

# Take first 2 alive cells if no args
if [ $# -ge 2 ]; then
  ALICE=$1; BOB=$2
else
  PAIR=$(python3 -c "
import json
with open('$HOME/.cells/cells.json') as f: d=json.load(f)
alive = [c['name'] for c in d.get('cells', []) if c.get('status')=='alive']
if len(alive) >= 2: print(alive[0], alive[1])
")
  ALICE=$(echo $PAIR | awk '{print $1}')
  BOB=$(echo $PAIR | awk '{print $2}')
fi

[ -z "$ALICE" ] || [ -z "$BOB" ] && { echo "ERROR: need 2 alive cells (got '$ALICE', '$BOB')"; exit 1; }

ALICE_WELL=$(python3 -c "
import json
with open('$HOME/.cells/cells.json') as f: d=json.load(f)
for c in d.get('cells', []):
    if c['name'] == '$ALICE':
        # hatched_from is the hex; well_name = 'egg-' + hatched_from
        print('egg-' + c['hatched_from']) if c.get('hatched_from') else print('$ALICE')
        break
")
BOB_WELL=$(python3 -c "
import json
with open('$HOME/.cells/cells.json') as f: d=json.load(f)
for c in d.get('cells', []):
    if c['name'] == '$BOB':
        print('egg-' + c['hatched_from']) if c.get('hatched_from') else print('$BOB')
        break
")

echo "=== V1.5 acceptance (sleep + auto-wake + sibling-survive) ==="
echo "alice=$ALICE (well=$ALICE_WELL)"
echo "bob=$BOB (well=$BOB_WELL)"
echo

# ─── 1. Both wells start running ─────────────────────────────────────
echo "--- Pre-test: confirm both wells running"
A_STATUS=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/wells/$ALICE_WELL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))")
B_STATUS=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/wells/$BOB_WELL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))")
echo "  alice well: $A_STATUS  bob well: $B_STATUS"
[ "$A_STATUS" = "running" ] && [ "$B_STATUS" = "running" ] || { echo "✗ pre-test: both must start running"; exit 1; }
echo "  ✓ pre-test: both running"
echo

# ─── 2. Sleep alice ───────────────────────────────────────────────────
echo "--- Sleep alice"
t0=$(date +%s%N)
$CELLS_BIN sleep $ALICE >/dev/null 2>&1
SLEEP_MS=$(ms_since $t0)
echo "  cells sleep: ${SLEEP_MS}ms"
[ "$SLEEP_MS" -lt 2000 ] && echo "  ✓ sleep < 2s" || echo "  ✗ sleep ≥ 2s (target 0.6s)"

# Verify welld says alice is stopped (hibernating)
A_AFTER=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/wells/$ALICE_WELL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))")
[ "$A_AFTER" = "stopped" ] && echo "  ✓ alice welld-status=stopped (hibernated)" || echo "  ✗ alice welld-status=$A_AFTER (expected stopped)"

# Sibling-survive: bob's well untouched
B_DURING=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/wells/$BOB_WELL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))")
[ "$B_DURING" = "running" ] && echo "  ✓ bob still running (sibling-survive — W.74)" || echo "  ✗ bob welld-status=$B_DURING (sibling clipped)"
echo

# ─── 3. Wake alice (raw welld /wake) ─────────────────────────────────
echo "--- Wake alice (welld /wake)"
t0=$(date +%s%N)
WAKE_RES=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/v1/wells/$ALICE_WELL/wake")
WAKE_MS=$(ms_since $t0)
echo "  welld /wake: ${WAKE_MS}ms"
echo "  response: $(echo "$WAKE_RES" | python3 -c "import json,sys; r=json.load(sys.stdin); print(f\"ok={r.get('ok')}, wake_ms={r.get('wake_ms')}, state={r.get('state')}\")" 2>/dev/null || echo "$WAKE_RES" | head -c 200)"
[ "$WAKE_MS" -lt 3000 ] && echo "  ✓ wake < 3s" || echo "  ✗ wake ≥ 3s (target 1.9s)"

# Verify alice is running again
A_FINAL=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/wells/$ALICE_WELL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))")
[ "$A_FINAL" = "running" ] && echo "  ✓ alice welld-status=running (post-wake)" || echo "  ✗ alice welld-status=$A_FINAL (expected running)"

# Sibling still alive
B_FINAL=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/wells/$BOB_WELL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))")
[ "$B_FINAL" = "running" ] && echo "  ✓ bob still running (sibling-survive — final check)" || echo "  ✗ bob welld-status=$B_FINAL"
echo

echo "=== V1.5 done ==="
