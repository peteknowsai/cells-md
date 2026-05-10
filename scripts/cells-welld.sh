#!/usr/bin/env bash
# cells-welld — wrapper around `bun run daemon/welld.ts` that injects
# the env vars cells needs welld to know about. The "control panel" for
# how cells configures the wells substrate.
#
# We tell welld:
#   WELL_PUBLIC_BASE  ← the host suffix welld dispatches on. This must
#                       match what we hand the per-cell Worker as
#                       WELL_HOST and what tryConnectLocalWelld uses
#                       in the Host header. Read from
#                       ~/.cells/config.json {well_public_base}, with
#                       process env > config file > "cells.md".
#   WELL_STATE_DIR    ← where welld stores its registry, vmDirs, token.
#                       Defaults to ~/.wells (stable instance).
#   WELL_PORT         ← welld's HTTP listener (default 7878).
#   WELL_LUME_PORT    ← lume daemon port welld spawns (default 7777).
#   WELL_LOG_FILE     ← log file path; welld appends.
#
# Usage:
#   scripts/cells-welld.sh start      # start in background, log to WELL_LOG_FILE
#   scripts/cells-welld.sh restart    # SIGTERM existing welld at WELL_PORT, then start
#   scripts/cells-welld.sh stop       # SIGTERM existing welld at WELL_PORT
#   scripts/cells-welld.sh status     # print PID + key env vars
#
# Override paths/ports via env, e.g.:
#   WELL_PORT=7879 WELL_STATE_DIR=~/.wells-dev scripts/cells-welld.sh start
#
# Welld source must live at $WELLD_REPO (default ~/Projects/splites-stable).

set -euo pipefail

WELLD_REPO="${WELLD_REPO:-$HOME/Projects/splites-stable}"
[ -d "$WELLD_REPO" ] || { echo "welld repo not found: $WELLD_REPO (set WELLD_REPO=...)"; exit 1; }
[ -f "$WELLD_REPO/daemon/welld.ts" ] || { echo "welld.ts not at $WELLD_REPO/daemon/welld.ts"; exit 1; }

CONFIG="$HOME/.cells/config.json"
DEFAULT_BASE="cells.md"
if [ -n "${WELL_PUBLIC_BASE:-}" ]; then
  BASE="$WELL_PUBLIC_BASE"
elif [ -f "$CONFIG" ] && command -v jq >/dev/null 2>&1; then
  BASE=$(jq -r '.well_public_base // empty' "$CONFIG" 2>/dev/null)
  [ -n "$BASE" ] || BASE="$DEFAULT_BASE"
else
  BASE="$DEFAULT_BASE"
fi

export WELL_PUBLIC_BASE="$BASE"
export WELL_STATE_DIR="${WELL_STATE_DIR:-$HOME/.wells}"
export WELL_PORT="${WELL_PORT:-7878}"
export WELL_LUME_PORT="${WELL_LUME_PORT:-7777}"
export WELL_LOG_FILE="${WELL_LOG_FILE:-$WELL_STATE_DIR/welld.log}"

cmd="${1:-status}"

find_welld_pid() {
  lsof -tiTCP:"$WELL_PORT" -sTCP:LISTEN 2>/dev/null | head -1
}

case "$cmd" in
  start)
    pid=$(find_welld_pid)
    if [ -n "$pid" ]; then
      echo "welld already listening on :$WELL_PORT (pid $pid). use 'restart' to reload env."
      exit 1
    fi
    cd "$WELLD_REPO"
    nohup bun run daemon/welld.ts > /dev/null 2>&1 &
    sleep 1
    pid=$(find_welld_pid)
    if [ -z "$pid" ]; then
      echo "welld failed to bind :$WELL_PORT — check $WELL_LOG_FILE"
      exit 1
    fi
    echo "welld started (pid $pid) on :$WELL_PORT  WELL_PUBLIC_BASE=$WELL_PUBLIC_BASE  WELL_STATE_DIR=$WELL_STATE_DIR"
    ;;
  stop)
    pid=$(find_welld_pid)
    if [ -z "$pid" ]; then
      echo "no welld listening on :$WELL_PORT"
      exit 0
    fi
    kill -TERM "$pid"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.5
      [ -z "$(find_welld_pid)" ] && break
    done
    if [ -n "$(find_welld_pid)" ]; then
      echo "welld pid $pid didn't exit on SIGTERM; SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    echo "welld stopped (was pid $pid)"
    ;;
  restart)
    "$0" stop || true
    "$0" start
    ;;
  status)
    pid=$(find_welld_pid)
    if [ -z "$pid" ]; then
      echo "welld not running on :$WELL_PORT"
      exit 1
    fi
    echo "welld pid:        $pid"
    echo "WELL_PORT:        $WELL_PORT"
    echo "WELL_PUBLIC_BASE: $WELL_PUBLIC_BASE   (would dispatch <well>.${WELL_PUBLIC_BASE} → well IP)"
    echo "WELL_STATE_DIR:   $WELL_STATE_DIR"
    echo "WELL_LUME_PORT:   $WELL_LUME_PORT"
    echo "WELL_LOG_FILE:    $WELL_LOG_FILE"
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
