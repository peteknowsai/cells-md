---
name: dream
description: Consolidate recent session signal into your durable storage — memory atoms, mentality, wiki. Run on a cadence (typically daily, woken by pulse) or when you've just learned something worth keeping. The four-phase distillation Karpathy / claudefa.st AutoDream: orient → gather → consolidate → prune. Cheaper than re-reading transcripts — only matched lines + surrounding context get attention.
allowed-tools: [bash, read, write, edit]
---

# dream — distill recent sessions into durable storage

You wake into this skill when something tells you to "dream", "run dream",
"consolidate", or "do your morning reflection". The pulse-fired daily
wake-ups for most cells route here. The point: every so often, pull the
durable signal out of recent sessions into the storage that survives
context resets — `state/memory/`, `state/mentality.md`, `state/wiki/`.

The work is four phases. Be surgical. Touch what matters; skip the rest.

## 1. Orient — what storage do you have?

Check which storage exists. Only act on what's present.

```bash
ls state/memory/MEMORY.md state/mentality.md state/wiki/index.md 2>&1 | grep -v 'No such'
```

Then read the index of each that exists:

- `state/memory/MEMORY.md` — the index of memory atoms. Read it.
- `state/mentality.md` — current mentality. Read it.
- `state/wiki/index.md` — wiki page index. Read it.

If none exist, this cell has no durable storage yet. Stop here and note
that to the requester.

## 2. Gather — what signal happened since the last dream?

Read the cursor (last successful dream timestamp). If no cursor, default
to "24 hours ago".

```bash
cat state/.dream/cursor 2>/dev/null || date -u -d '24 hours ago' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v-24H '+%Y-%m-%dT%H:%M:%SZ'
```

Find your session files. The path depends on your harness — pick the
one that exists:

| Harness     | Session JSONL path                                    |
|-------------|-------------------------------------------------------|
| claude-code | `~/.claude/projects/-root/*.jsonl`                    |
| pi          | `~/.pi/agent/sessions/*.jsonl`                        |
| codex       | `~/.codex/sessions/*/*/*/rollout-*-*.jsonl`           |
| hermes      | `~/.hermes/sessions/*.jsonl` (if exists)              |

List files modified since the cursor. **Drop the freshest** — it's
probably the active session and you don't want to digest yourself
mid-thought.

```bash
find ~/.claude/projects/-root -name '*.jsonl' -newermt "$CURSOR" | sort | head -n -1
```

For each file, **grep** for the patterns below — don't read whole
transcripts, that blows your context.

```bash
grep -niE '\b(actually|wait,|let me correct|i was wrong|remember (this|that)|save this|note that|important:|FYI|TIL|we decided|let'\''s go with|going to|the plan is|i (prefer|like|hate|don'\''t like)|always|never|used to think|changed my mind|turns out)\b' <session.jsonl>
```

Pull each matched line plus ~2 lines of context. These are
**candidates**, not signal. The next phase filters them.

If `grep` returns nothing across all files, the cell had no durable
signal since the cursor. Skip phase 3, write the cursor, log a no-op
entry to `wiki/log.md`, and report back "no signal".

## 3. Consolidate — write findings into storage

Filter the candidates for what's actually **durable**:

- User corrections ("actually X, not Y") → **memory atom** or **mentality "mind changes"**
- Explicit saves ("remember that…", "important:") → **memory atom**
- Key decisions ("we decided…", "going to…") → **memory atom** or **mentality update**
- Recurring patterns (same topic across multiple sessions) → **wiki page**
- Things you used to think but no longer → **mentality "mind changes"**

Skip:
- Tool-call mechanics ("I'll run bash to…")
- Conversational acknowledgments ("got it", "ok")
- Anything already saved (cross-check against orientation snapshot)

### Writing memory atoms (`state/memory/`)

Naming convention (the memory package validates these):

- `user_<topic>.md` — facts about the user
- `feedback_<topic>.md` — user corrections / preferences
- `project_<topic>.md` — ongoing work
- `reference_<topic>.md` — pointers to external systems

Each atom is small (one fact, a few lines). Frontmatter:

```markdown
---
name: <kebab-case-slug>
description: One-line hook
metadata:
  type: <user|feedback|project|reference>
---

The fact. For feedback/project: lead with the rule/fact, then **Why:**
and **How to apply:** lines.
```

If an atom on the same topic exists, **edit** it (merge, refresh) — don't
create a duplicate. Then refresh its line in `state/memory/MEMORY.md`
(keep that index ≤200 lines).

### Updating mentality (`state/mentality.md`)

Augment, don't rewrite. Usually a "Mind changes" or "Lessons learned"
entry. Keep total file ≤80 lines / 6KB.

### Writing wiki pages (`state/wiki/`)

Genuinely new topic from a recurring pattern → create
`state/wiki/<slug>.md` (lowercase, alphanumeric, underscores). Add a
line to `state/wiki/index.md`. For existing topics: edit the page in
place.

Don't write tiny wiki pages. Small atomic facts belong in memory atoms.

## 4. Prune & index

- Memory: drop atoms contradicted by new signal. Refresh stale ones.
- Wiki: don't deep-prune here (wiki_lint handles structural cleanup).
- Don't touch `state/wiki/log.md` — you'll append one entry below.

### Update the cursor + log

```bash
mkdir -p state/.dream
date -u '+%Y-%m-%dT%H:%M:%SZ' > state/.dream/cursor
```

Append one line to `state/wiki/log.md` if wiki exists:

```
## [<iso-timestamp>] dream | <N> sessions | <M> signals
<one-paragraph summary of what changed>
```

## Output

Return **one paragraph** to whoever asked you to dream:

- N memory atoms written/updated, M removed
- mentality updated (or unchanged)
- K wiki pages created/touched
- Notable mind-changes or contradictions surfaced

Be concrete. Cite filenames. If nothing was worth changing, say so
plainly — a no-op dream is a real result, not a failure.

## Don't

- Don't read full session JSONLs into context. Grep first, read only the
  matched line + a few lines of context.
- Don't speculate. If you're unsure something is durable, skip it.
- Don't touch source code, tests, configs, or anything outside `state/`.
- Don't talk back to whoever wakes you with progress chatter — just do
  the work, return the summary.

## Related

- The pi harness has a `distill` tool that runs this same recipe via a
  fork-subagent. If that tool is available, you can call it directly
  instead of executing the phases by hand.
- `state/.dream/cursor` — your dream cursor. Independent of any storage
  package.
- `state/wiki/log.md` — provenance log for dreams (and other ingest events).
