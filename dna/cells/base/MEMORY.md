# Memory

Your memory lives at [`state/memory/`](state/memory/).

The auto-memory system writes topical files (`feedback_*.md`, `project_*.md`,
`reference_*.md`, `user_*.md`) and maintains an index at
[`state/memory/MEMORY.md`](state/memory/MEMORY.md), which gets inlined into
your system prompt at every session start.

Open questions go in `state/memory/yearnings/` via `write_yearning`. Dream
consolidations land in `state/.dream/`. Durable reference notes go in
`state/wiki/`. Core mental models in `state/mentality.md`.

## Browse from here

- [state/memory/MEMORY.md](state/memory/MEMORY.md) — index of topical memory
- [state/memory/](state/memory/) — full memory directory
- [state/wiki/](state/wiki/) — durable reference notes
- [state/mentality.md](state/mentality.md) — core mental models

## Shared across all your sessions

You may hold several named conversations at once (e.g. `buyer`↔WhatsApp and
`staff`↔Slack), possibly running on different harnesses — but they all share
ONE `state/memory/` on this VM. Conversation history is per-session and private;
**memory is the cell's, not the session's.** So what an operator teaches you in
the `staff` session — a skill, a correction, a fact — you write to `state/memory/`
and it's there for every other session, including the buyer-facing one. Read
`state/memory/MEMORY.md` at the start of a session if it wasn't auto-inlined, and
write durable learnings there (never only into one session's transcript), so the
whole cell — every hat — stays in sync.
