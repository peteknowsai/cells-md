#!/bin/bash
# Pete Loop — Stop hook
#
# Re-injects the worker prompt back into the conversation if the loop is
# active. State lives in .claude/.pete-loop.active (gitignored), which holds
# the current turn count. The presence of the file = active.
#
# /start-pete-loop creates the flag (resets counter to 0).
# /stop-pete-loop removes it.

set -e

PROJECT_ROOT="/Users/pete/Projects/cells"
FLAG_FILE="$PROJECT_ROOT/.claude/.pete-loop.active"
MAX_ITER=200

# Loop not active — let the stop proceed normally.
if [ ! -f "$FLAG_FILE" ]; then
  exit 0
fi

# Read and increment turn count.
COUNT=$(head -1 "$FLAG_FILE" 2>/dev/null)
COUNT=${COUNT:-0}
COUNT=$((COUNT + 1))

# Hit max turns — clear the flag and let stop proceed with a notice.
if [ "$COUNT" -gt "$MAX_ITER" ]; then
  rm -f "$FLAG_FILE"
  jq -n --arg msg "Pete Loop hit max iterations ($MAX_ITER). Stopped. Run /start-pete-loop to resume." \
    '{systemMessage: $msg}'
  exit 0
fi

# Save updated count and re-inject the worker prompt.
echo "$COUNT" > "$FLAG_FILE"

REASON="Pete Loop iteration $COUNT/$MAX_ITER. Execute the worker loop: read $PROJECT_ROOT/.claude/loops/worker.md and follow it precisely. Do NOT use AskUserQuestion under any circumstances. Output ≤1 sentence to chat about what you did this fire."

jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
