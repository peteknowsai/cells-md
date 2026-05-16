#!/usr/bin/env bash
# Usage: analyze-birth-jsonl.sh <claude-session-jsonl>
# Summarizes a claude-code mother birth session:
#   - turn count + tool counts
#   - per-tool breakdown
#   - wall-clock from first to last message
#   - lists each Bash command (truncated) with its index
# Useful for finding unproductive turns (Read/Grep tours, retries).

set -e
f="${1:-}"
if [ -z "$f" ] || [ ! -f "$f" ]; then
  echo "usage: $0 <claude-session-jsonl>" >&2
  exit 1
fi

echo "=== $(basename "$f") ==="
echo

first=$(jq -s 'map(select(.timestamp != null) | .timestamp) | first' "$f")
last=$(jq -s 'map(select(.timestamp != null) | .timestamp) | last' "$f")
echo "first event: $first"
echo "last  event: $last"

if [ -n "$first" ] && [ -n "$last" ] && [ "$first" != "null" ] && [ "$last" != "null" ]; then
  delta=$(node -e "const a=new Date($first); const b=new Date($last); console.log(Math.round((b-a)/1000))")
  echo "elapsed:     ${delta}s"
fi

echo
echo "--- tool calls in order ---"
jq -r '
  select(.type == "assistant") |
  .message.content // [] |
  if type == "array" then
    .[] | select(.type == "tool_use") |
    .name + " | " + ((.input.command // .input.pattern // .input.file_path // (.input | tostring))[:140])
  else
    empty
  end
' "$f" 2>/dev/null | nl -ba

echo
echo "--- tool name counts ---"
jq -r '
  select(.type == "assistant") |
  .message.content // [] |
  if type == "array" then .[] | select(.type == "tool_use") | .name else empty end
' "$f" 2>/dev/null | sort | uniq -c | sort -rn
