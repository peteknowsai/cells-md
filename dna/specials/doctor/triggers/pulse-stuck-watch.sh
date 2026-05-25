#!/usr/bin/env bash
# pulse-stuck-watch — detect a stuck pulse tick sentinel.
#
# pulse.json holds {lastPulse, currentPulse}.  When a tick is in flight
# `currentPulse.started` is set; on `end`, the sentinel clears.  If a tick
# crashes or its fork session orphans, the sentinel can stay set forever —
# which silently stops all schedule translation.
#
# We poll pulse.json once a minute and emit when currentPulse has been held
# for more than PULSE_STUCK_THRESHOLD_S seconds.  Debounced via state file.

set -u

CELLS_REPO="${CELLS_REPO:-${HOME}/Projects/cells}"
CELLS_BIN="${CELLS_BIN:-bun ${CELLS_REPO}/cli/cells.ts}"

STATE_DIR="${DOCTOR_STATE:-${HOME}/.cells/doctor/state}"
mkdir -p "$STATE_DIR"
LAST="$STATE_DIR/pulse-stuck-flag"

# pulse.json path candidates (first that exists wins).
PULSE_JSON_CANDIDATES=(
  "${PULSE_JSON_PATH:-}"
  "/root/.cells/pulse.json"
  "/root/pulse.json"
  "/root/.cells/pulse/pulse.json"
)

PULSE_STUCK_THRESHOLD_S=${PULSE_STUCK_THRESHOLD_S:-600}
TICK_INTERVAL_S=${PULSE_STUCK_INTERVAL_S:-60}

emit() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

resolve_pulse_json() {
  # Pulse is the only cell that knows where its pulse.json lives.  Try the
  # candidates in order; print the first that exists; empty if none.
  local script='
for p in "$@"; do
  [ -z "$p" ] && continue
  if [ -f "$p" ]; then echo "$p"; exit 0; fi
done
exit 1
'
  $CELLS_BIN exec pulse -- sh -c "$script" -- "${PULSE_JSON_CANDIDATES[@]}" 2>/dev/null
}

while true; do
  path=$(resolve_pulse_json)
  if [ -z "$path" ]; then
    sleep "$TICK_INTERVAL_S"
    continue
  fi

  # Pull `currentPulse.started` via node — robust to JSON formatting drift.
  read_script='
let raw="";
process.stdin.on("data",d=>raw+=d);
process.stdin.on("end",()=>{
  try {
    const s=JSON.parse(raw);
    const cp=s && s.currentPulse;
    if (cp && cp.started) {
      const age=Math.floor((Date.now()-new Date(cp.started).getTime())/1000);
      process.stdout.write(JSON.stringify({age,started:cp.started}));
    }
  } catch (_) {}
});
'
  payload=$(
    $CELLS_BIN exec pulse -- sh -c \
      "cat \"$path\" | node -e '$read_script'" 2>/dev/null \
      || true
  )

  if [ -z "$payload" ]; then
    > "$LAST"  # no current pulse, clear flag
    sleep "$TICK_INTERVAL_S"
    continue
  fi

  age=$(printf '%s' "$payload" | sed -E 's/.*"age":\s*([0-9]+).*/\1/')
  started=$(printf '%s' "$payload" | sed -E 's/.*"started":\s*"([^"]+)".*/\1/')

  if [ -n "$age" ] && [ "$age" -gt "$PULSE_STUCK_THRESHOLD_S" ]; then
    last=$(cat "$LAST" 2>/dev/null || true)
    if [ "$last" != "$started" ]; then
      emit "pulse-tick-stuck started=$started age=${age}s path=$path"
      printf '%s' "$started" > "$LAST"
    fi
  else
    > "$LAST"
  fi

  sleep "$TICK_INTERVAL_S"
done
