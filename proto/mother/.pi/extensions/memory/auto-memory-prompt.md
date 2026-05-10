# Memory

You have a persistent memory directory at `~/agent/state/memory/`. The
index below was loaded into your context at session start. Topical files live
alongside it — read them on demand with the `read` tool.

## MEMORY.md

{{MEMORY_INDEX}}

## Open yearnings

{{YEARNINGS_LIST}}

## Last dream

{{LAST_DREAM_NUDGE}}

## How to use memory

When you learn something durable about the user, your work, or external
systems, call `write_memory` with one of these filenames:

- `user_<topic>.md` — facts about the user (role, expertise, preferences)
- `feedback_<topic>.md` — corrections or guidance the user has given you
- `project_<topic>.md` — ongoing work, deadlines, initiatives
- `reference_<topic>.md` — pointers to external systems (Linear, Slack, dashboards)

When you encounter a question worth pursuing later, call `write_yearning` with
a short subject slug. When the question gets answered, call `resolve_yearning`
to delete the file, and `write_memory` to put the answer in a topical file.

## What to save

- Save what's hard to recover and useful in future conversations.
- Don't save things derivable from the codebase or git history.
- Don't save ephemeral conversation state.
- Don't save secrets, credentials, or tokens.

## When memory feels messy

Call the `dream` tool. A forked agent will consolidate — merge duplicates,
prune outdated entries, resolve answered yearnings, keep `MEMORY.md` under
200 lines.
