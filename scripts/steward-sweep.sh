#!/usr/bin/env bash
# steward-sweep — one self-healing pass over the fleet.
#
# Run by mother's steward heartbeat (via the mac_exec bridge) or by hand.
# Deterministic by design: read `cells doctor --json`, apply the known
# fixes, re-check, emit a one-line JSON summary. Judgment (flapping
# detection, unknown failures, whether to wake Pete) belongs to the agent
# reading the summary, not this script.
#
# Known fix classes (everything else is reported, never guessed at):
#   - well-site unit missing in guest      → POST /v1/wells/<w>/services/apply
#   - well-site inactive / :8080 dead      → systemctl restart well-site
#   - no `site` service definition         → scripts/register-site-service.sh
#   - guest clock skew                     → chrony makestep fix + step + sync
#   - pool below target depth              → detached `cells pool refill`
#   - proxy / host-bridge unreachable      → launchctl kickstart
#   - welld unhealthy                      → ALERT ONLY (never bounce the substrate)
#   - wa-bridge down / OOM warns           → ALERT ONLY (QR re-pair / resize are operator calls)

set -uo pipefail
cd "$(dirname "$0")/.."

LOG="$HOME/Projects/cells/state/memory/steward.log"
TOKEN=$(cat "$HOME/.wells/token" 2>/dev/null || true)
BASE="${WELL_API_URL:-http://127.0.0.1:7878}"

snapshot() { bun cli/cells.ts doctor --json 2>/dev/null; }

J1=$(snapshot)
if [ -z "$J1" ]; then
  echo '{"ok":false,"error":"doctor --json produced nothing"}'
  exit 1
fi

FIXED=()
ALERTS=()

# ── substrate / services ────────────────────────────────────────────
if [ "$(echo "$J1" | jq -r '.welld.ok')" != "true" ]; then
  ALERTS+=("welld unhealthy — substrate problem, not bouncing it")
fi
if [ "$(echo "$J1" | jq -r '.proxy.ok')" != "true" ]; then
  launchctl kickstart -k "gui/$(id -u)/com.pete.cells-proxy" 2>/dev/null \
    && FIXED+=("proxy kickstarted") || ALERTS+=("proxy down and kickstart failed")
fi
if [ "$(echo "$J1" | jq -r '.hostBridge.ok')" != "true" ]; then
  launchctl kickstart -k "gui/$(id -u)/com.pete.cells-host-bridge" 2>/dev/null \
    && FIXED+=("host-bridge kickstarted") || ALERTS+=("host-bridge down and kickstart failed")
fi
if [ "$(echo "$J1" | jq -r '.waBridge.wa')" != "connected" ]; then
  ALERTS+=("wa-bridge socket $(echo "$J1" | jq -r '.waBridge.wa') — WhatsApp surface degraded (QR re-pair?)")
fi
# "connected" can lie: after a WA socket bounce the bridge accepted inbound
# but silently failed every outbound send (2026-06-12 — buyer replies logged
# "completed", never delivered). Fresh inbound + stale outbound = that
# signature. Fix is a bridge kickstart, which IS safe to do automatically.
WA_IN=$(echo "$J1" | jq -r '.waBridge.inboundAgeS // empty')
WA_OUT=$(echo "$J1" | jq -r '.waBridge.outboundAgeS // empty')
if [ -n "$WA_IN" ] && [ -n "$WA_OUT" ] && [ "$WA_IN" -lt 900 ] && [ "$WA_OUT" -gt 3600 ] 2>/dev/null; then
  if launchctl kickstart -k "gui/$(id -u)/md.homezero.wa-bridge" 2>/dev/null; then
    FIXED+=("wa-bridge kickstarted — inbound fresh (${WA_IN}s) but outbound stale (${WA_OUT}s): silent send failure signature")
  else
    ALERTS+=("wa-bridge outbound looks silently dead (in=${WA_IN}s out=${WA_OUT}s) and kickstart failed")
  fi
fi

# ── per-cell transport fixes ────────────────────────────────────────
while IFS=$'\t' read -r name well status reasons; do
  [ "$status" = "ok" ] && continue
  case "$reasons" in
    *"unit missing in guest"*)
      curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/wells/$well/services/apply" > /dev/null \
        && FIXED+=("$name: services re-applied") || ALERTS+=("$name: services/apply failed")
      ;;&
    *"no \`site\` service definition"*)
      bash scripts/register-site-service.sh "$name" "$well" > /dev/null 2>&1 \
        && FIXED+=("$name: site service registered") || ALERTS+=("$name: register-site-service failed")
      ;;&
    *"well-site unit is "*|*":8080/health not answering"*)
      well exec -s "$well" -- bash -c 'sudo systemctl restart well-site' > /dev/null 2>&1 \
        && FIXED+=("$name: well-site restarted") || ALERTS+=("$name: well-site restart failed")
      ;;&
    *"clock skewed"*)
      well exec -s "$well" -- bash -c '
        if grep -q "^makestep" /etc/chrony/chrony.conf; then
          sudo sed -i "s/^makestep.*/makestep 1.0 -1/" /etc/chrony/chrony.conf
        else
          echo "makestep 1.0 -1" | sudo tee -a /etc/chrony/chrony.conf > /dev/null
        fi
        sudo systemctl restart chrony && sleep 4 && sudo chronyc makestep > /dev/null 2>&1; sync' > /dev/null 2>&1 \
        && FIXED+=("$name: clock stepped + makestep fixed") || ALERTS+=("$name: clock fix failed")
      ;;&
    *"oom-kill"*)
      ALERTS+=("$name: recent OOM kill — RAM sizing is an operator call")
      ;;
  esac
done < <(echo "$J1" | jq -r '.cells[] | select(.status != "ok") | [.name, .well, .status, (.reasons | join("; "))] | @tsv')

# ── pool depth ──────────────────────────────────────────────────────
OPEN=$(echo "$J1" | jq -r '.pool.open')
TARGET=$(echo "$J1" | jq -r '.pool.target')
if [ "$OPEN" -lt "$TARGET" ] 2>/dev/null; then
  if pgrep -f "cells.ts pool refill" > /dev/null; then
    FIXED+=("pool refill already in flight ($OPEN/$TARGET)")
  else
    mkdir -p "$HOME/.cells/logs"
    nohup bun cli/cells.ts pool refill >> "$HOME/.cells/logs/pool-refill.log" 2>&1 &
    FIXED+=("pool refill started ($OPEN/$TARGET open)")
  fi
fi

# ── re-check what we touched ────────────────────────────────────────
sleep 5
J2=$(snapshot)
REMAINING=$(echo "$J2" | jq '[.cells[] | select(.status == "fail")] | length' 2>/dev/null || echo "?")

SUMMARY=$(jq -nc \
  --argjson fixed "$(printf '%s\n' "${FIXED[@]:-}" | jq -Rn '[inputs | select(length>0)]')" \
  --argjson alerts "$(printf '%s\n' "${ALERTS[@]:-}" | jq -Rn '[inputs | select(length>0)]')" \
  --arg remaining "$REMAINING" \
  '{ok: true, fixed: $fixed, alerts: $alerts, remaining_fails: ($remaining | tonumber? // -1)}')

mkdir -p "$(dirname "$LOG")"
echo "$(date -u +"%Y-%m-%d %H:%M")  steward  fixed=$(echo "$SUMMARY" | jq '.fixed | length') alerts=$(echo "$SUMMARY" | jq '.alerts | length') remaining_fails=$(echo "$SUMMARY" | jq '.remaining_fails')  $(echo "$SUMMARY" | jq -c '.fixed + .alerts')" >> "$LOG"

# Anything unresolved → local notification so Pete sees it without asking.
if [ "$(echo "$SUMMARY" | jq '.remaining_fails')" != "0" ] || [ "$(echo "$SUMMARY" | jq '.alerts | length')" != "0" ]; then
  osascript -e "display notification \"$(echo "$SUMMARY" | jq -r '(.alerts + (if .remaining_fails > 0 then ["\(.remaining_fails) transport failure(s) remain"] else [] end)) | join("; ")' | head -c 180)\" with title \"cells steward\"" 2>/dev/null || true
fi

echo "$SUMMARY"
