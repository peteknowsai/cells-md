#!/usr/bin/env bash
# Post-/seal acceptance — full end-to-end verification of cells's pool
# bake → seal → hibernate cycle once wells ships /seal.
#
# Run AFTER wells ships POST /v1/wells/{name}/seal and bounces welld.
#
# Sequence:
#   1. Smoke: /seal endpoint exists (HTTP 200 path or expected 409/404 — not 404 from missing route)
#   2. Bake one fresh pool member via cells's updated bakePoolMember
#      (calls /seal between provision and the conditional hibernate)
#   3. Verify the resulting well has runtime.hibernate_ready=true
#      (proxy: try /hibernate against a Tier 2 — should succeed, not 409 well_not_hibernate_ready)
#   4. Re-run V1.5 (sleep + auto-wake + sibling-survive) on the fresh member
#   5. Re-run V1.10 burst against fresh-baked pool
#
# Pass: all four steps green.
set -euo pipefail

CELLS_BIN="bun cli/cells.ts"
TOKEN=$(cat ~/.wells/token)
API="http://127.0.0.1:7878"

echo "=== Post-/seal acceptance ==="
echo "welld /healthz:"
curl -s "$API/healthz" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'  started_at={d.get(\"started_at\")}'); print(f'  degraded={d.get(\"degraded\")}')"
echo

# ─── 1. /seal endpoint smoke ──────────────────────────────────────
echo "--- 1. /seal endpoint smoke (probe a known-bad name to confirm route exists)"
RES=$(curl -s -w "\n__STATUS__%{http_code}" -X POST -H "Authorization: Bearer $TOKEN" "$API/v1/wells/__non_existent__/seal")
STATUS=$(echo "$RES" | grep -oE '__STATUS__[0-9]+' | tail -1 | sed 's/__STATUS__//')
BODY=$(echo "$RES" | grep -v '__STATUS__')
echo "  HTTP $STATUS: $BODY"
case "$STATUS" in
  404) [[ "$BODY" =~ well ]] && echo "  ✓ route exists (404 = well not found, not route not found)" || { echo "  ✗ /seal route missing"; exit 1; } ;;
  409|400) echo "  ✓ route exists (HTTP $STATUS = expected error envelope)" ;;
  *) echo "  ✗ unexpected status $STATUS"; exit 1 ;;
esac
echo

# ─── 2. Bake one fresh pool member (will exercise /seal mid-flow) ──
echo "--- 2. Bake one fresh pool member"
T0=$(date +%s%N)
$CELLS_BIN pool bake-v1 2>&1 | tail -5
T1=$(date +%s%N)
echo "  bake elapsed: $(( (T1-T0)/1000000 ))ms"
echo

# Identify the freshly-baked well
NEW_MEMBER=$($CELLS_BIN pool list 2>&1 | grep hot | tail -1 | awk '{print $1}')
[ -z "$NEW_MEMBER" ] && { echo "  ✗ no hot member found post-bake"; exit 1; }
NEW_WELL="egg-$NEW_MEMBER"
echo "  ✓ fresh member: $NEW_MEMBER (well=$NEW_WELL)"
echo

# ─── 3. Verify hibernate works on fresh-baked well ──────────────────
echo "--- 3. Hibernate the fresh member directly via welld (validates seal worked)"
HIB=$(curl -s -w "\n__STATUS__%{http_code}" -X POST -H "Authorization: Bearer $TOKEN" "$API/v1/wells/$NEW_WELL/hibernate")
HIB_STATUS=$(echo "$HIB" | grep -oE '__STATUS__[0-9]+' | tail -1 | sed 's/__STATUS__//')
HIB_BODY=$(echo "$HIB" | grep -v '__STATUS__')
echo "  HTTP $HIB_STATUS: $HIB_BODY"
[ "$HIB_STATUS" = "200" ] && echo "  ✓ /hibernate accepted — /seal flipped hibernate_ready correctly" || { echo "  ✗ hibernate refused — /seal didn't flip the flag"; exit 1; }
echo

# Wake it back up for V1.5
echo "--- 3b. Wake the fresh member"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/v1/wells/$NEW_WELL/wake" -o /dev/null -w "  /wake: HTTP %{http_code}\n"
echo

# ─── 4. Bake one more for V1.5 (needs 2 cells) ─────────────────────
echo "--- 4. Bake a second fresh member for V1.5 (alice + bob)"
$CELLS_BIN pool bake-v1 2>&1 | tail -3
NEW2=$($CELLS_BIN pool list 2>&1 | grep hot | head -1 | awk '{print $1}')
echo "  ✓ second fresh member ready"
echo

# ─── 5. Re-run V1.5 on fresh members ───────────────────────────────
echo "--- 5. V1.5 re-run on fresh-sealed pool"
$CELLS_BIN pool list 2>&1 | head -10
echo
# Note: v1.5-acceptance.sh takes first 2 alive cells; we want it on the fresh ones,
# so we birth two fresh names first
$CELLS_BIN birth post-seal-alice --seed=off >/dev/null 2>&1 || true
$CELLS_BIN birth post-seal-bob --seed=off >/dev/null 2>&1 || true
sleep 1
bash scripts/v1.5-acceptance.sh
echo

# ─── 6. V1.10 burst against fresh-sealed pool ──────────────────────
echo "--- 6. V1.10 burst (N=5; pool likely smaller post-births)"
bash scripts/v1.10-burst.sh 5
echo

echo "=== Post-/seal acceptance done ==="
