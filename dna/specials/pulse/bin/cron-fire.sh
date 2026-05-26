#!/usr/bin/env bash
# cron-fire — invoke `cells talk` and log enriched JSON the dashboard reads.
#
# Replaces a raw `cells talk` line in /etc/cron.d/pulse-schedules. The
# raw form logs only the talk command's own JSON output, which is
# truthful but doesn't tell us how long the cell took to ack or whether
# the talk timed out partway. This wrapper times the call end-to-end and
# emits a single JSON line per fire, format:
#
#   {"v":1,"cell":"<cell>","id":"<schedule-id>","start_ms":<ms>,
#    "end_ms":<ms>,"latency_ms":<ms>,"exit":<int>,"talk":<talk-json|null>}
#
# `talk` carries the original `cells talk` JSON when one was emitted —
# the dashboard still needs `corr_id` for cross-referencing. If the
# command exited non-zero without printing JSON (e.g. wake failed
# before the proxy was even reached), `talk` is null and `exit` tells
# the story.
#
# Argv: cron-fire.sh <cell> <schedule-id> <message>...

set -u
CELL="${1:-?}"; shift
ID="${1:-?}"; shift
MSG="$*"
LOG="/root/.cells/logs/cron-fires.log"
mkdir -p "$(dirname "$LOG")"

START=$(date -u +%s%3N)
OUT=$(/root/bin/cells talk "$CELL" "$MSG" 2>&1)
EXIT=$?
END=$(date -u +%s%3N)
LATENCY=$((END - START))

# Try to parse the talk's JSON one-liner; if it's not valid JSON, store null.
TALK_JSON="null"
if [ -n "$OUT" ]; then
  # Strip control chars and grab first line that looks like JSON.
  FIRST=$(printf '%s' "$OUT" | tr -d '\000-\010\013\014\016-\037' | sed -n '/^{.*}$/{p;q;}')
  if [ -n "$FIRST" ] && printf '%s' "$FIRST" | node -e 'try{JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(0)}catch(e){process.exit(1)}' 2>/dev/null; then
    TALK_JSON="$FIRST"
  fi
fi

# Build the final record. Escape cell/id/exit with node so weird names
# (which shouldn't exist but might) can't break the JSON.
node -e '
const [cell, id, msg, startMs, endMs, latencyMs, exit, talkRaw] = process.argv.slice(1);
let talk = null;
try { talk = talkRaw === "null" ? null : JSON.parse(talkRaw); } catch { talk = { raw: talkRaw }; }
process.stdout.write(JSON.stringify({
  v: 1,
  cell, id, msg,
  start_ms: Number(startMs),
  end_ms: Number(endMs),
  latency_ms: Number(latencyMs),
  exit: Number(exit),
  talk,
}) + "\n");
' "$CELL" "$ID" "$MSG" "$START" "$END" "$LATENCY" "$EXIT" "$TALK_JSON" >> "$LOG"

exit "$EXIT"
