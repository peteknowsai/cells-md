# Schema

This file is the LLM-tunable rule book for this wiki. Read it before
authoring or revising pages. Edit it as the wiki evolves.

## What goes here

Wiki pages are **narrative** — multi-paragraph, topic-scoped, evolving
over time. Pages distill durable knowledge: how something works, why
it's that way, what we tried, what we learned.

Wiki is *not*:
- For atomic facts (those go in `pi-cell-memory` as `feedback_*.md`,
  `project_*.md`, etc.)
- For the agent's current synthesis (that's `mentality.md` from
  `pi-cell-mentality`)
- For raw conversation logs (those live in Pi's `~/.pi/agent/sessions/`)

## Page naming

- Lowercase, alphanumeric, underscores or hyphens: `cell_lifecycle`,
  `auth-story`, `tmux_decisions`.
- Slug should match the topic (one page per topic).
- Reserved: `index`, `log`, `SCHEMA`.

## Page structure

A wiki page typically has:

1. **One-line summary** at the top — what is this topic, in 15 words
2. **Context** — why this topic matters, when it became one
3. **Body** — the actual narrative. Sections as needed.
4. **Open questions** — what's unresolved
5. **Related pages** — wiki-links to neighboring topics

No frontmatter required.

## Cross-linking

Use markdown links: `[cell_lifecycle](cell_lifecycle.md)`. The lint
tool checks for orphans (pages not in `index.md`) and dead links.

## When to update vs. create

- **Create** a new page when a topic genuinely doesn't exist yet
- **Update** an existing page when a new conversation adds detail or
  changes understanding. Don't rewrite from scratch — augment, refine.
- **Cross-touch** related pages when a write affects them. (Karpathy's
  pattern: a typical ingest touches 10–15 pages, not just one.)

## When `pi-cell-dream` ingests

The dream tool reads past session JSONLs surgically (via grep) and:
1. Decides which topics warrant new wiki pages
2. Updates existing pages with new context
3. Cross-touches related pages
4. Appends an entry to `log.md` with what changed

Without dream installed, this all happens manually via `wiki_write`.
