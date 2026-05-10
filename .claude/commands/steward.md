---
description: Execute one steward turn (triage, compaction, optional Pete touch)
---

Execute the steward loop for cells.

1. Read `.claude/loops/steward.md` and follow it precisely.
2. Use AskUserQuestion ONLY at designated touch moments per the prompt.
3. Bundle multiple open questions into a single AskUserQuestion call (up to 4 questions).
4. Output ≤1 sentence to chat about what you did this turn and whether you touched Pete.
