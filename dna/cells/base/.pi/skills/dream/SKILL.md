---
name: dream
description: Consolidate recent session signal into your durable storage — memory atoms, mentality, wiki. Run on a cadence (typically daily, woken by pulse) or when you've just learned something worth keeping. On pi cells the `distill` tool runs the whole four-phase pipeline as a fork-subagent — that's the fast path. If `distill` isn't available, follow the manual recipe below.
allowed-tools: [bash, read, write, edit]
---

# dream — distill recent sessions into durable storage

You wake into this skill when something tells you to "dream", "run
dream", "consolidate", or "do your morning reflection". The pulse-fired
daily wake-ups for most cells route here. The point: every so often,
pull the durable signal out of recent sessions into the storage that
survives context resets — `state/memory/`, `state/mentality.md`,
`state/wiki/`.

## The fast path — call `distill`

Pi cells ship with the **dream extension** (`.pi/extensions/dream/`),
which registers a tool called `distill`. It runs the full four-phase
pipeline as a fork-subagent — surgical grep over Pi session JSONLs
since the cursor, then a fresh pi subagent that writes findings into
your storage.

```
call: distill
```

That's the skill. Wait for the summary paragraph, then return it as
your response. Don't re-do its work by hand.

If `distill` isn't in your toolset (a stripped-down cell, or the
extension didn't load), fall back to the manual recipe below.

## The manual recipe — when `distill` isn't available

The four phases. Be surgical. Touch what matters; skip the rest.

### 1. Orient — what storage do you have?

Check which storage exists. Only act on what's present.

```bash
ls state/memory/MEMORY.md state/mentality.md state/wiki/index.md 2>&1 | grep -v 'No such'
```

Then read the index of each that exists:

- `state/memory/MEMORY.md` — index of memory atoms.
- `state/mentality.md` — current mentality.
- `state/wiki/index.md` — wiki page index.

If none exist, this cell has no durable storage yet. Stop and report.

### 2. Gather — signal since the last dream

Read the cursor (last successful dream timestamp), default 24h ago:

```bash
cat state/.dream/cursor 2>/dev/null || date -u -d '24 hours ago' '+%Y-%m-%dT%H:%M:%SZ'
```

List your pi session files modified since the cursor. **Drop the
freshest** — that's likely the active session.

```bash
find ~/.pi/agent/sessions -name '*.jsonl' -newermt "$CURSOR" | sort | head -n -1
```

Grep for signal patterns — don't read whole transcripts:

```bash
grep -niE '\b(actually|wait,|let me correct|i was wrong|remember (this|that)|save this|note that|important:|FYI|TIL|we decided|let'\''s go with|going to|the plan is|i (prefer|like|hate|don'\''t like)|always|never|used to think|changed my mind|turns out)\b' <session.jsonl>
```

Each matched line + ~2 lines of context. These are **candidates**, not
signal. Next phase filters.

If grep returns nothing: write the cursor, log no-op to
`state/wiki/log.md` if present, return "no signal".

### 3. Consolidate — write findings into storage

Filter candidates for what's **durable**:

- User corrections ("actually X, not Y") → memory atom or mentality "mind changes"
- Explicit saves ("remember…", "important:") → memory atom
- Key decisions ("we decided…", "going to…") → memory atom or mentality
- Recurring patterns across sessions → wiki page
- Things you used to think but no longer → mentality "mind changes"

Skip: tool-call mechanics, conversational ack, anything already saved.

**Memory atoms** (`state/memory/<topic>.md`) — strict naming:

- `user_<topic>.md` — facts about the user
- `feedback_<topic>.md` — user corrections / preferences
- `project_<topic>.md` — ongoing work
- `reference_<topic>.md` — pointers to external systems

Frontmatter: `name`, `description`, `metadata.type`. Edit existing
atoms on the same topic rather than duplicating. Refresh
`state/memory/MEMORY.md` (≤200 lines).

If the `write_memory` tool is available, prefer it over raw file writes.

**Mentality** (`state/mentality.md`) — augment, don't rewrite. Usually a
"Mind changes" or "Lessons learned" entry. ≤80 lines / 6KB.

If `update_mentality` is available, use it.

**Wiki** (`state/wiki/`) — new recurring-pattern topic → create
`state/wiki/<slug>.md`, add to `index.md`. Existing topics → edit in
place. No tiny wiki pages — those belong as memory atoms.

### 4. Prune & index

- Memory: drop contradicted atoms, refresh stale ones.
- Wiki: don't deep-prune (wiki_lint owns structural cleanup).
- Don't touch `state/wiki/log.md` — you'll append one entry below.

Update cursor + log:

```bash
mkdir -p state/.dream
date -u '+%Y-%m-%dT%H:%M:%SZ' > state/.dream/cursor
```

If wiki exists, append one line to `state/wiki/log.md`:

```
## [<iso-timestamp>] dream | <N> sessions | <M> signals
<one-paragraph summary>
```

## Output

Return **one paragraph**:

- N memory atoms written/updated, M removed
- mentality updated (or unchanged)
- K wiki pages created/touched
- Notable mind-changes or contradictions

Be concrete. Cite filenames. A no-op dream is a real result — say so
plainly, don't pad.

## Don't

- Don't read full session JSONLs. Grep first, read only matches +
  context.
- Don't speculate. Unsure = skip.
- Don't touch source code, tests, configs, anything outside `state/`.
- Don't chatter while working — return the summary and stop.

## Related

- `.pi/extensions/dream/` — the extension that registers `distill`.
- `state/.dream/cursor` — dream cursor. Independent of storage packages.
- `state/wiki/log.md` — provenance log for dreams.
