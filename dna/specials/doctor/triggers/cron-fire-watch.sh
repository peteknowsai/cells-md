#!/usr/bin/env bash
# cron-fire-watch — tail pulse cell's cron-fires.log for failed wakes.
#
# Every minute, cron on the pulse cell fires `cells talk <cell> <msg>` lines
# from /etc/cron.d/pulse-schedules.  Each result is appended to
# /root/.cells/logs/cron-fires.log as JSON.  We emit a line whenever one
# returns `"ok":false` or an HTTP-error shape.
#
# Designed to be `tail -f`-shaped — one line per event on stdout, runs forever.
# If the long-lived `cells exec` tail dies (pulse hibernates, network blip),
# wait a bit and re-attach.

set -u

CELLS_REPO="${CELLS_REPO:-${HOME}/Projects/cells}"
# CELLS_BIN may be set in the env as a space-separated string (e.g. "bun
# /alt/path/cli/cells.ts" or just "cells"); default invokes the repo
# directly so the doctor doesn't depend on a PATH shim.
CELLS_BIN="${CELLS_BIN:-bun ${CELLS_REPO}/cli/cells.ts}"

LOG_PATH="${CRON_FIRES_LOG:-/root/.cells/logs/cron-fires.log}"
RECONNECT_S=${CRON_WATCH_RECONNECT_S:-30}

emit() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

while true; do
  # tail -F follows by name (survives logrotate); -n 0 means start at EOF.
  $CELLS_BIN exec pulse -- tail -n 0 -F "$LOG_PATH" 2>/dev/null \
    | grep -E --line-buffered '"ok"\s*:\s*false|HTTP[/ ][45][0-9][0-9]|talk_failed' \
    | while IFS= read -r line; do
        # Trim, defensive against very long lines
        trimmed=$(printf '%s' "$line" | cut -c1-800)
        emit "cron-talk-failed $trimmed"
      done

  emit "cron-fire-watch reconnecting (tail pipe closed)"
  sleep "$RECONNECT_S"
done
