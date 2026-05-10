---
description: Execute one worker turn (autonomous task pickup + bounded work + commit)
---

Execute the worker loop for cells.

1. Read `.claude/loops/worker.md` and follow it precisely.
2. Do NOT use AskUserQuestion under any circumstances during this turn.
3. Output ≤1 sentence to chat about what you did this turn.

Hard cap: 50 minutes of execution. If a task is bigger, do a slice and leave it In Progress with a resume note.
