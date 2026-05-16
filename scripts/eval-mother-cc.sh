#!/usr/bin/env bash
# Birth/kill loop for claude-code mother optimization.
# Births N sacrificial cells, captures wall-clock + outcome + JSONL path,
# kills each after. Writes a summary at the end.
#
# Usage:
#   scripts/eval-mother-cc.sh [N=10] [prefix=mceval]

set -euo pipefail
N="${1:-10}"
PREFIX="${2:-mceval}"
RESULTS="/tmp/eval-mother-cc-$(date +%Y%m%dT%H%M%S).csv"
echo "run,name,wall_s,success,mother_harness,jsonl_path,jsonl_size,bash_calls,nonbash_calls" > "$RESULTS"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

for i in $(seq 1 "$N"); do
  NAME="${PREFIX}-$(date +%s)-$i"
  echo "=== run $i/$N: $NAME ==="
  PRE_JSONL_MAX=$(ls -t ~/.claude/projects/-Users-pete-Projects-cells-dna-specials-mother/*.jsonl 2>/dev/null | head -1 | xargs -I{} stat -f %m "{}" 2>/dev/null || echo 0)

  T0=$(date +%s)
  if bun cli/cells.ts birth "$NAME" --harness=pi --model=gpt-5.5 --thinking=low --seed=off > "/tmp/eval-$NAME.log" 2>&1; then
    SUCCESS=true
  else
    SUCCESS=false
  fi
  T1=$(date +%s)
  WALL=$((T1 - T0))

  # Find the newest JSONL written since PRE_JSONL_MAX
  JSONL=$(find ~/.claude/projects/-Users-pete-Projects-cells-dna-specials-mother -name "*.jsonl" -newermt "@$T0" | head -1 || true)
  JSONL_SIZE=0
  BASH_CALLS=0
  NONBASH_CALLS=0
  if [ -n "$JSONL" ] && [ -f "$JSONL" ]; then
    JSONL_SIZE=$(stat -f %z "$JSONL")
    BASH_CALLS=$(jq -r 'select(.type=="assistant") | .message.content // [] | if type=="array" then .[] | select(.type=="tool_use" and .name=="Bash") | "x" else empty end' "$JSONL" 2>/dev/null | wc -l | tr -d ' ')
    NONBASH_CALLS=$(jq -r 'select(.type=="assistant") | .message.content // [] | if type=="array" then .[] | select(.type=="tool_use" and .name != "Bash") | "x" else empty end' "$JSONL" 2>/dev/null | wc -l | tr -d ' ')
  fi

  MOTHER_HARNESS=$(jq -r 'select(.name=="'"$NAME"'") | .mother_harness // ""' ~/.cells/birth-log/*.json 2>/dev/null | tail -1)

  echo "  wall=${WALL}s success=$SUCCESS mother=$MOTHER_HARNESS bash_calls=$BASH_CALLS nonbash=$NONBASH_CALLS"
  echo "$i,$NAME,$WALL,$SUCCESS,$MOTHER_HARNESS,$JSONL,$JSONL_SIZE,$BASH_CALLS,$NONBASH_CALLS" >> "$RESULTS"

  # Kill the cell
  bun cli/cells.ts kill "$NAME" -y > /dev/null 2>&1 || echo "  ! kill failed"
done

echo
echo "=== summary ($RESULTS) ==="
cat "$RESULTS"
echo
echo "wall times: $(tail -n +2 "$RESULTS" | cut -d, -f3 | sort -n | tr '\n' ' ')"
echo "success rate: $(awk -F, 'NR>1 && $4=="true"{ok++} END{print ok"/"NR-1}' "$RESULTS")"
echo "p50 wall: $(tail -n +2 "$RESULTS" | cut -d, -f3 | sort -n | awk 'NR==int((NR+'$N')/2){print}')"
