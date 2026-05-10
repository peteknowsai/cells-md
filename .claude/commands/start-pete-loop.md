---
description: Start Pete Loop — runs the worker continuously after each turn until /stop-pete-loop or 200 turns
---

Start Pete Loop. This activates the Stop hook at `.claude/hooks/pete-loop-stop.sh` which will re-inject the worker prompt after every turn until the loop is stopped.

1. Run: `echo "0" > /Users/pete/Projects/cells/.claude/.pete-loop.active`
2. Confirm to chat: `Pete Loop started. Worker will fire after each turn. Run /stop-pete-loop to halt or wait for max iterations (200).`
3. Then immediately execute the worker loop body: read `/Users/pete/Projects/cells/.claude/loops/worker.md` and follow it precisely. Do NOT use AskUserQuestion. Output ≤1 sentence to chat about what you did this fire.

The Stop hook fires when this turn ends and re-injects the worker prompt — that's how iteration N+1 begins.
