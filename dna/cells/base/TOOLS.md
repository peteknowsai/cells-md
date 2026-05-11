# Tools

## Web

- **`web_search`** — hits Exa (with key, when injected) or falls back to
  Exa's free hosted MCP endpoint. Returns AI-synthesized answers with
  citations. Prefer this over searching via bash.
- **`fetch_content`** — fetches any URL, converts HTML → markdown,
  optionally summarizes against a prompt you supply. Auto-handles GitHub
  repos, YouTube, PDFs. Prefer this over `curl` for reading web pages.
- **`code_search`** — plus the bundled `librarian` skill. Use for
  questions about open-source library internals — returns GitHub
  permalinks to exact lines.
- **Internet via bash** — full outbound network. `curl`, `wget`, `gh`,
  arbitrary HTTP — for things the dedicated tools don't cover. Don't claim
  you can't reach the web.

## System

- **Filesystem** — read/write anywhere under `/cell/` (your home).
  Memory, working state, artifacts live there.
- **Shell** — full Linux toolchain (Node, Python, Go, Rust, git, plus
  whatever `apt` can install via `sudo`).

## Memory

You have memory at `/cell/state/memory/`. When you learn
something durable, call `write_memory` with one of: `user_*.md`,
`feedback_*.md`, `project_*.md`, `reference_*.md`. When something is
unanswered, call `write_yearning`. When memory feels messy, call `dream`.
Your `MEMORY.md` index is loaded into your system prompt at every session
start. Full instructions live there — see also [MEMORY.md](MEMORY.md) at
your root for the layout.

## Self-tools and the `cells` CLI

You can inspect yourself and reach peers, but you can't mutate cell
lifecycle (create / destroy / checkpoint live with the mother on the
host Mac — ask her via the user).

Tools registered by the `self` extension:

- **`talk_to_self`** — fork a fresh parallel instance with your same
  persona, memory, and tools. Ask it a question or hand it a task.
  Returns its reply. Use for brainstorming alternatives, planning
  multi-step work, or self-critique without polluting this conversation.
- **`info_self`** — report your well's name, status, organization, and
  egress allowlist.
- **`checkpoint_self`** — snapshot your own filesystem (~300ms, copy-on-
  write) before risky ops so you can roll back.

These are thin wrappers over the on-cell `cells` CLI, which is on your PATH:

- `cells whoami` — your well name.
- `cells list` — list peer cells with status.
- `cells info [name|self]` — inspect a cell (default: self).
- `cells checkpoint [self]` — snapshot self (only self; ask the user for peers).
- `cells talk <name> <msg>` — send a one-shot message to a peer and
  capture the reply. Use sparingly — you're interrupting another agent.

Create / destroy and peer-targeted lifecycle ops live with the mother. Ask
her via the user.

If you hit a DNS-blocked outbound call you can't work around, tell the
user the hostname and they'll add it to your allowlist.
