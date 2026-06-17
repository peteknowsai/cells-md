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
#   - running cell behind current DNA      → `cells refresh <cell>` (≤3/sweep, clean-tree-gated)
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
    *"jobs watchdog may be dead"*)
      ALERTS+=("$name: $reasons")
      ;;&
    *"oom-kill"*)
      ALERTS+=("$name: recent OOM kill — RAM sizing is an operator call")
      ;;
  esac
done < <(echo "$J1" | jq -r '.cells[] | select(.status != "ok") | [.name, .well, .status, (.reasons | join("; "))] | @tsv')

# ── pool depth ──────────────────────────────────────────────────────
# (Removed 2026-06-17 — no egg pool. Births cold-fork the `cell-base` image on
#  demand, so there's no pre-baked stock to keep topped up.)

# ── DNA-rev auto-heal — refresh running cells behind current DNA ─────
# Running cells behind the current rev get refreshed. Gates on a CLEAN working
# tree: a dirty tree's rev reflects uncommitted edits, so acting would chase or
# push unfinished code (the doctor still SHOWS the drift — visibility is never
# gated). On a dirty tree WITH drift, emit ONE paused alert.
# (The old pool stale-rev cull is gone with the pool — cold births always
#  fork the current `cell-base` image, so there's no pre-baked stock to drift.)
TREE_CLEAN=$(echo "$J1" | jq -r '.dna.tree_clean')
mapfile -t STALE_CELLS < <(echo "$J1" | jq -r '.dna.stale_cells[]?' 2>/dev/null)

if [ "$TREE_CLEAN" != "true" ]; then
  if [ "${#STALE_CELLS[@]}" -gt 0 ]; then
    ALERTS+=("DNA auto-heal PAUSED — ${#STALE_CELLS[@]} stale cell(s), but the cells working tree is dirty. Commit DNA changes to let the steward refresh.")
  fi
else
  # Refresh running cells behind the current rev. Cap 3/sweep so a fleet-wide
  # jump rotates over a few sweeps rather than restarting every supervisor at
  # once. `cells refresh` re-stamps /root/.dna-rev only on the healthy branch
  # (a rollback leaves it correctly still-stale). stale_cells is running-only —
  # this never wakes a sleeper.
  n=0
  for cell in "${STALE_CELLS[@]}"; do
    [ -z "$cell" ] && continue
    if [ "$n" -ge 3 ]; then
      ALERTS+=("DNA: $(( ${#STALE_CELLS[@]} - 3 )) more stale cell(s) remain (cap 3/sweep) — next sweep continues")
      break
    fi
    if bun cli/cells.ts refresh "$cell" >/dev/null 2>&1; then
      FIXED+=("$cell: refreshed to current DNA rev")
    else
      ALERTS+=("$cell: DNA refresh failed — run \`cells refresh $cell\` by hand")
    fi
    n=$((n+1))
  done
fi

# ── harness binary currency (uniform-cell) ──────────────────────────
# A uniform cell can run ANY harness per-session, so ALL three binaries
# (pi/claude/codex) must stay current — not just the baked primary. Fresh
# births already install all three (update-cell-harness.sh); this keeps
# LONG-LIVED cells from drifting. Conservative: only running+ok cells, at most
# once/day/cell (a marker file), capped 2/sweep so we never npm-storm the fleet.
# STRICT=0 → all best-effort (a binary swap is non-disruptive: it only affects
# the NEXT spawn, never an in-flight process). Detached so the slow npm runs
# don't stall the sweep.
CUR_DIR="$HOME/.cells/harness-currency"
mkdir -p "$CUR_DIR" "$HOME/.cells/logs"
hn=0
while IFS=$'\t' read -r name well; do
  [ -z "$name" ] && continue
  [ "$hn" -ge 2 ] && break
  marker="$CUR_DIR/$name"
  # once/day/cell: skip if the marker was touched in the last 24h
  if [ -f "$marker" ] && [ "$(find "$marker" -mtime -1 2>/dev/null)" ]; then continue; fi
  touch "$marker"
  # STRICT=0 makes the "primary" non-strict, so all three are swept best-effort
  # regardless of which harness we name — pass a fixed blob (the real primary is
  # irrelevant here; only birth cares which one is strict).
  nohup env HARNESS_UPDATE_STRICT=0 bash scripts/update-cell-harness.sh "$well" '{"harness":"pi"}' \
    >> "$HOME/.cells/logs/harness-currency.log" 2>&1 &
  FIXED+=("$name: harness-currency sweep started (pi/claude/codex → current, best-effort)")
  hn=$((hn+1))
done < <(echo "$J1" | jq -r '.cells[] | select(.status == "ok") | [.name, .well] | @tsv')

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
