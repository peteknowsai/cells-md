#!/usr/bin/env bash
# Birth post-work: the async tail of birth. Runs the steps that don't
# need to gate "cell is alive" — site service registration, well URL
# flip, Cloudflare Worker deploy, channel binding, harness update, and
# the final well checkpoint. Mother calls this from a nohup so the user
# sees the birth declared in-flight and these settle behind it.
#
# Writes per-step status to ~/.cells/postwork/<name>.json so the
# dashboard (and any other observer) can tell the difference between
# "post-birth still running", "all postwork ok", and "one step failed
# silently". Without that file every failure is invisible — the cell
# stays usable for talk, but worker traffic 404s or channels never bind
# and no one notices.
#
# Usage: birth-postwork.sh <NAME> <WELL> <BLOB_JSON>
#
# Designed to be wrapped in nohup by the birth skill — never blocks the
# birth declaration, never fails the parent. The full stdout/stderr
# stream still lands in the birth-postwork log so per-script output is
# inspectable; the JSON is just the structured summary.

set -uo pipefail

NAME="${1:?usage: $0 <NAME> <WELL> <BLOB_JSON>}"
CELL_WELL="${2:?usage: $0 <NAME> <WELL> <BLOB_JSON>}"
BLOB_JSON="${3:?usage: $0 <NAME> <WELL> <BLOB_JSON>}"

REPO="${CELLS_REPO:-$HOME/Projects/cells}"
STATUS_DIR="$HOME/.cells/postwork"
STATUS_FILE="$STATUS_DIR/$NAME.json"

mkdir -p "$STATUS_DIR"

now() { date -Iseconds; }

# Initialize the status file. Single jq call up front so the dashboard
# never sees a half-written JSON object — every per-step update is also
# atomic (tmp + rename).
jq -n \
  --arg cell "$NAME" \
  --arg well "$CELL_WELL" \
  --arg started "$(now)" \
  '{cell: $cell, well: $well, started_at: $started, completed_at: null, steps: {}}' \
  > "$STATUS_FILE"

# Update one step's slot in the JSON. Atomic via tmp + rename.
mark_step() {
  local step="$1" status="$2" detail="${3:-}"
  local tmp="$STATUS_FILE.tmp.$$"
  jq \
    --arg step "$step" \
    --arg status "$status" \
    --arg at "$(now)" \
    --arg detail "$detail" \
    '.steps[$step] = {status: $status, at: $at, detail: $detail}' \
    "$STATUS_FILE" > "$tmp" && mv "$tmp" "$STATUS_FILE"
}

# Run a step. Captures output, marks ok / failed in the status file,
# echoes a timestamped log line, and DOES NOT abort the script on
# failure — postwork is best-effort across all steps so one slow worker
# deploy doesn't suppress channel binding etc.
run_step() {
  local step="$1"
  shift
  echo "[$(now)] $step start"
  local rc capture
  capture=$(mktemp "${TMPDIR:-/tmp}/postwork-$step.XXXXXX")
  # Pipe through tee, NOT command substitution: tee streams the step's
  # output to this script's stdout (the nohup per-cell log) LIVE while it
  # runs, so `cells doctor`'s "tail the per-cell log" guidance actually
  # works for a slow/stuck worker deploy or checkpoint — a hung step shows
  # its progress, not just the "start" line. The captured copy in $capture
  # feeds the failure-detail tail below. (Command substitution buffered
  # everything until exit, so a hang logged nothing — the bug this fixes.)
  "$@" 2>&1 | tee "$capture"
  rc=${PIPESTATUS[0]}   # exit of "$@", not tee
  if [ "$rc" -eq 0 ]; then
    mark_step "$step" ok ""
    echo "[$(now)] $step ok"
  else
    # Stash the tail of stderr so a quick `cat <status>.json` shows
    # *what* broke without having to hunt down the postwork log.
    local detail
    detail=$(tail -c 240 "$capture")
    mark_step "$step" failed "$detail"
    echo "[$(now)] $step FAILED (rc=$rc): $detail"
    FAILURES=$((FAILURES + 1))
  fi
  rm -f "$capture"
}

# Count of failed steps. The final log marker depends on it: see the
# completion stamp below for why "post-birth done" must stay success-only.
FAILURES=0

cd "$REPO"

run_step site_service bash scripts/register-site-service.sh "$NAME" "$CELL_WELL"
run_step well_url_public well url update --auth public -s "$CELL_WELL"
run_step worker_deploy bash scripts/deploy-cell-worker.sh "$NAME" "$CELL_WELL"
run_step channels_bind bash scripts/bind-cell-channels.sh "$NAME" "$BLOB_JSON"
run_step harness_update bash scripts/update-cell-harness.sh "$CELL_WELL" "$BLOB_JSON"
run_step checkpoint well checkpoint create -s "$CELL_WELL" --comment "born-$NAME"

# Final stamp — completed_at lets the dashboard tell "postwork still in
# flight" from "postwork done, some steps failed".
tmp="$STATUS_FILE.tmp.$$"
jq --arg at "$(now)" '.completed_at = $at' "$STATUS_FILE" > "$tmp" && mv "$tmp" "$STATUS_FILE"

# The "post-birth done" log marker is a SUCCESS signal, not just "finished".
# Log-only consumers that predate the JSON status file key on it:
# cli/menubar/swift/main.swift (still log-only) and postBirthStatus's legacy
# fallback in cli/cells.ts both read `contains("post-birth done") -> ok`.
# The old inline SKILL.md postwork ran under `set -e`, so a failed step
# aborted before this marker — the marker only ever appeared on full success.
# This script is best-effort (run_step swallows failures so one bad step
# doesn't suppress the rest), so we must gate the marker on FAILURES==0 by
# hand to preserve that contract; otherwise a failed worker_deploy would show
# as "deploy done" in the menubar. On failure, emit a distinct line (no
# "post-birth done" substring) — log consumers then read "running", matching
# the old abort behavior, while the JSON carries the real per-step detail.
if [ "$FAILURES" -eq 0 ]; then
  echo "[$(now)] post-birth done"
else
  echo "[$(now)] post-birth finished with $FAILURES failed step(s) — see $STATUS_FILE"
fi
