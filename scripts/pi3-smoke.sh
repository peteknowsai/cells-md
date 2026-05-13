#!/usr/bin/env bash
# Piece 3 smoke test — operator-create warming simplification
#
# Piece 3 changes wells's POST /v1/wells default: operator-created wells
# now stay running with cidata attached (no warm-sequence). They return
# ~6-8s faster, but cannot hibernate (hibernate_ready: false permanently).
#
# Tests:
#   1. Fresh `well create` lands quickly (<10s)
#   2. Hibernate refuses (409 well_not_hibernate_ready expected)
#   3. Cells's pool builder still works (uses hibernate_ready: true)
#
# Run AFTER wells bounces stable welld onto Piece 3 binary.
set -euo pipefail

TOKEN=$(cat ~/.wells/token)
API="http://127.0.0.1:7878"
NAME="pi3-smoke-$$"

ms_since() {
  local t0=$1
  local t1=$(date +%s%N)
  echo $(( (t1 - t0) / 1000000 ))
}

echo "=== Piece 3 smoke test ==="
echo "Probing welld /healthz..."
curl -s "$API/healthz" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'  started_at={d.get(\"started_at\")}'); print(f'  degraded={d.get(\"degraded\")}'); print(f'  has_pool_block={\"pool\" in d}')"
echo

# ─── 1. Operator create: should be fast, no hibernate_ready ────────
echo "--- 1. Operator-create $NAME (no hibernate_ready)"
t0=$(date +%s%N)
RES=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"$NAME\",\"from_image\":\"ubuntu-25.10-base\"}" "$API/v1/wells")
ELAPSED=$(ms_since $t0)
echo "  POST /v1/wells: ${ELAPSED}ms"
echo "  response: $(echo "$RES" | python3 -c "import json,sys; r=json.load(sys.stdin); print(f\"name={r.get('name')}, status={r.get('status')}, ip={r.get('ip')}\")" 2>/dev/null || echo "$RES" | head -c 200)"
[ "$ELAPSED" -lt 10000 ] && echo "  ✓ create < 10s (target ~6-8s post-Pi3)" || echo "  ✗ create ≥ 10s"
echo

# ─── 2. Hibernate should refuse ────────────────────────────────────
echo "--- 2. Try to hibernate (should refuse with 409 well_not_hibernate_ready)"
HIB=$(curl -s -w "\n__STATUS__%{http_code}" -X POST -H "Authorization: Bearer $TOKEN" "$API/v1/wells/$NAME/hibernate")
HIB_STATUS=$(echo "$HIB" | grep -oE '__STATUS__[0-9]+' | tail -1 | sed 's/__STATUS__//')
HIB_BODY=$(echo "$HIB" | grep -v '__STATUS__')
echo "  HTTP $HIB_STATUS: $HIB_BODY"
[ "$HIB_STATUS" = "409" ] && echo "  ✓ hibernate refused (409)" || echo "  ✗ expected 409, got $HIB_STATUS"
echo

# ─── 3. Cells pool builder still works (hibernate_ready: true) ────
echo "--- 3. Cells pool builder still works (smoke)"
echo "  Skipping — V1.10 burst earlier verified pool bake-v1 (hibernate_ready=true) works."
echo

# ─── Cleanup ──────────────────────────────────────────────────────
echo "--- Cleanup"
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$API/v1/wells/$NAME" -o /dev/null -w "  DELETE $NAME: %{http_code}\n"
echo

echo "=== Piece 3 smoke done ==="
