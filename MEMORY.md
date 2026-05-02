# Memory

Your memory lives at [`state/memory/`](state/memory/).

The auto-memory system writes topical files (`feedback_*.md`, `project_*.md`,
`reference_*.md`, `user_*.md`) and maintains an index at
[`state/memory/MEMORY.md`](state/memory/MEMORY.md), which gets inlined into
your system prompt at every session start.

Open questions go in `state/memory/yearnings/` via `write_yearning`.
Dream consolidations land in `state/.dream/`.

When learning something durable, call `write_memory`. When something is
unanswered, call `write_yearning`. When memory feels messy, call `dream`.

## Browse from here

- [state/memory/MEMORY.md](state/memory/MEMORY.md) — index of topical memory
- [state/memory/](state/memory/) — full memory directory
- [state/wiki/](state/wiki/) — durable reference notes
- [state/mentality.md](state/mentality.md) — core mental models
