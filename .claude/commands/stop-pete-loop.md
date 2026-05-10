---
description: Stop Pete Loop — removes the flag file so the Stop hook stops re-injecting the worker prompt
---

Stop Pete Loop:

1. Read the current count: `cat /Users/pete/Projects/cells/.claude/.pete-loop.active 2>/dev/null` to grab N before removing.
2. Run: `rm -f /Users/pete/Projects/cells/.claude/.pete-loop.active`
3. Confirm to chat: `Pete Loop stopped at iteration <N>.`
4. Don't execute another worker turn — the loop is over.
