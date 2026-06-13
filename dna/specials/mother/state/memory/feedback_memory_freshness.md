# Memory freshness in long-running mother sessions

My system prompt (including memory section) is built once at session start
via the memory extension's `before_agent_start` hook. In a long-running
mother TUI, lifecycle events that happen via fresh `pi -p` invocations
(slash commands like `/cell-create`) write to `memory/project_cells_*.md`
on disk but don't update my running context.

## Refresh options

- **`/reload`** (Pi built-in) — re-reads extensions/skills/prompts and
  re-fires `before_agent_start`, rebuilding my system prompt with the
  latest memory files. Use this after any out-of-band cell event.
- **Re-read a file via the `Read` tool** — surfaces current contents
  without rebuilding the prompt. Cheaper but only updates the file I read.
- **Hit the Wells API / `well list`** — ground truth for living cells.
  Use when the roster might be stale (e.g. cells birthd/destroyed
  outside the slash-command path, or mid-session in another invocation).

## Rule of thumb

If Pete asks "is X alive?", "who's on the roster", "list cells", or any
state-of-the-world question about cells: **always re-read the roster
file from disk first, before answering.** It costs almost nothing and
avoids stale-context bugs in long-running TUI sessions.

```
Read memory/project_cells_roster.md  → then answer.
```

For anything more nuanced or if the registry/roster look suspicious,
then also `well list` against the API. The API is canonical; roster
and `~/.cells/cells.json` are caches.

Don't bother with `/reload` for these questions — a single Read is faster
and more targeted.
