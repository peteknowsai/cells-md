# Memory implementation plan — Phase 1

> Concrete plan for building Cell's L1 memory system. Reference docs:
> - `docs/auto-dream-memory.md` — pattern guidelines (Swain-derived)
> - `ROADMAP.md` Phase 1 — original scope

## Goal

Every agent born from the Cell template starts life with persistent narrative
memory that survives across conversations: a `memory/` directory it reads at
session start, writes to mid-conversation, and consolidates periodically via
a forked dream subagent.

## Phasing

Two sub-phases. Ship 1.0 standalone — useful even without dream.

| Phase | Adds | Done when |
|---|---|---|
| **1.0** | Memory dir, MEMORY.md injection, write/remove tools, truncation, yearnings | Agent remembers things across `cells talk` sessions |
| **1.1** | `dream` tool + forked subagent + ritual prose | Calling `dream` produces measurably-cleaner `MEMORY.md` |

## Memory directory layout

Lives at `/cell/memory/` on each Well. Created by the extension
on first `session_start` if missing.

```
/cell/memory/
├── MEMORY.md                  ← index. ≤ 200 lines / 25 KB. Loaded every session.
├── user_<topic>.md            ← who the user is (role, expertise, preferences)
├── feedback_<topic>.md        ← rules / corrections the user gave
├── project_<topic>.md         ← active work, deadlines, ongoing initiatives
├── reference_<topic>.md       ← pointers to external systems
└── yearnings/
    └── <subject>.md           ← unanswered questions (operator-writable)
```

Naming conventions are enforced by `write_memory`. Paths outside `memory/` are
rejected. Yearnings live in their own subdir so the dream can iterate them
explicitly.

## What gets injected into the agent's context every session

Composed by `memory` extension's `before_agent_start` hook, appended to
whatever the `identity` extension produced:

```
# Memory

You have a persistent memory directory at /cell/memory/. Your
index is below — full content lives in topical files you can read on demand.

## MEMORY.md

<inline contents of MEMORY.md>

## Open yearnings (questions you're tracking)

<one-line summary per file in yearnings/>

## When to save

Call `write_memory` when you learn something durable about the user, your
work together, or external systems. File naming:
- user_<topic>.md       facts about the user
- feedback_<topic>.md   corrections / preferences
- project_<topic>.md    ongoing work
- reference_<topic>.md  pointers to external systems

When you encounter an unanswered question worth pursuing, call `write_yearning`.
When a yearning gets answered, call `resolve_yearning` and move the fact to a
topical file.

Don't save things derivable from the codebase or git history. Don't save
ephemeral conversation state. If MEMORY.md feels messy or outdated, call
`dream`.
```

This text lives in `proto/mother/dna/.pi/extensions/memory/auto-memory-prompt.md`,
loaded by the extension and templated with current MEMORY.md content.

## Phase 1.0 — the basic write/read loop

### Files to create

```
proto/mother/dna/.pi/extensions/memory/
├── index.ts                    ← the extension
└── auto-memory-prompt.md       ← static template injected into system prompt
```

### Files to modify

| File | Change |
|---|---|
| `proto/mother/dna/.pi/settings.json` | Add `".pi/extensions/memory/index.ts"` after identity |
| `proto/mother/dna/AGENTS.md` | Brief one-paragraph pointer to memory section |
| `proto/mother/dna/.gitignore` | Add `memory/` |
| `ROADMAP.md` | Mark Phase 1.0 in progress, link this doc |

Birth ritual already pushes the whole `proto/mother/dna/` to `/cell/`,
so the extension comes along for free. No birth.md changes required.

### Extension shape (`proto/mother/dna/.pi/extensions/memory/index.ts`)

```typescript
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, basename, normalize, sep } from "node:path";

const MEMORY_DIR = "/cell/memory";
const YEARNINGS_DIR = join(MEMORY_DIR, "yearnings");
const INDEX_FILE = join(MEMORY_DIR, "MEMORY.md");
const PROMPT_TEMPLATE = join(__dirname, "auto-memory-prompt.md");
const MAX_LINES = 200;
const MAX_BYTES = 25 * 1024;
const HEADER_LINES_PRESERVED = 10;
const ALLOWED_PREFIXES = ["user_", "feedback_", "project_", "reference_"];

function ensureDirs() {
  mkdirSync(MEMORY_DIR, { recursive: true });
  mkdirSync(YEARNINGS_DIR, { recursive: true });
  if (!existsSync(INDEX_FILE)) {
    writeFileSync(INDEX_FILE, "# MEMORY.md\n\nIndex of topical memory files. One line per topic.\n\n");
  }
}

function safePath(name: string, dir: string): string | null {
  // Reject absolute paths, traversal, and anything outside dir
  const cleaned = basename(name);
  if (cleaned !== name) return null;
  const full = normalize(join(dir, cleaned));
  if (!full.startsWith(dir + sep)) return null;
  return full;
}

function nameValid(name: string): boolean {
  return ALLOWED_PREFIXES.some(p => name.startsWith(p)) && name.endsWith(".md");
}

function truncateIndex() {
  if (!existsSync(INDEX_FILE)) return;
  const content = readFileSync(INDEX_FILE, "utf-8");
  const lines = content.split("\n");
  const bytes = Buffer.byteLength(content);
  if (lines.length <= MAX_LINES && bytes <= MAX_BYTES) return;
  const header = lines.slice(0, HEADER_LINES_PRESERVED);
  const body = lines.slice(HEADER_LINES_PRESERVED);
  // Trim from tail until under both caps
  while (body.length > 0 && (header.length + body.length > MAX_LINES || Buffer.byteLength(header.concat(body).join("\n")) > MAX_BYTES)) {
    body.pop();
  }
  writeFileSync(INDEX_FILE, header.concat(body).join("\n"));
}

function listYearnings(): string[] {
  if (!existsSync(YEARNINGS_DIR)) return [];
  return readdirSync(YEARNINGS_DIR).filter(f => f.endsWith(".md"));
}

function buildMemorySection(): string {
  const promptTemplate = readFileSync(PROMPT_TEMPLATE, "utf-8");
  const indexContent = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, "utf-8") : "(empty)";
  const yearnings = listYearnings();
  const yearningsList = yearnings.length === 0
    ? "(none)"
    : yearnings.map(f => {
        const first = readFileSync(join(YEARNINGS_DIR, f), "utf-8").split("\n")[0];
        return `- ${f}: ${first}`;
      }).join("\n");
  return promptTemplate
    .replace("<inline contents of MEMORY.md>", indexContent)
    .replace("<one-line summary per file in yearnings/>", yearningsList);
}

export default function (pi: any) {
  pi.on("session_start", () => ensureDirs());

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    ensureDirs();
    const prior = ctx.getSystemPrompt();
    const memorySection = buildMemorySection();
    return { systemPrompt: `${prior}\n\n${memorySection}` };
  });

  pi.on("turn_end", () => truncateIndex());

  pi.registerTool({
    name: "write_memory",
    description: "Write or replace a topical memory file. File name must start with user_/feedback_/project_/reference_ and end with .md.",
    parameters: Type.Object({
      name: Type.String({ description: "Filename, e.g. 'user_role.md'" }),
      content: Type.String({ description: "Full content of the file (replaces any existing)." }),
    }),
    async execute(_id: string, params: { name: string; content: string }) {
      ensureDirs();
      if (!nameValid(params.name)) {
        return { content: [{ type: "text", text: `rejected: name '${params.name}' must start with user_/feedback_/project_/reference_ and end with .md` }] };
      }
      const path = safePath(params.name, MEMORY_DIR);
      if (!path) return { content: [{ type: "text", text: `rejected: invalid path` }] };
      writeFileSync(path, params.content);
      return { content: [{ type: "text", text: `wrote ${params.name}` }] };
    },
  });

  pi.registerTool({
    name: "remove_memory",
    description: "Delete a topical memory file.",
    parameters: Type.Object({
      name: Type.String({ description: "Filename to delete." }),
    }),
    async execute(_id: string, params: { name: string }) {
      const path = safePath(params.name, MEMORY_DIR);
      if (!path || !existsSync(path)) return { content: [{ type: "text", text: `not found: ${params.name}` }] };
      unlinkSync(path);
      return { content: [{ type: "text", text: `removed ${params.name}` }] };
    },
  });

  pi.registerTool({
    name: "write_yearning",
    description: "Record an unanswered question. Body should describe what you want to know and how you might learn it.",
    parameters: Type.Object({
      subject: Type.String({ description: "Short slug, e.g. 'hull_maintenance'" }),
      content: Type.String({ description: "Full content of the yearning." }),
    }),
    async execute(_id: string, params: { subject: string; content: string }) {
      ensureDirs();
      const filename = `${params.subject}.md`;
      const path = safePath(filename, YEARNINGS_DIR);
      if (!path) return { content: [{ type: "text", text: `rejected: invalid subject` }] };
      writeFileSync(path, params.content);
      return { content: [{ type: "text", text: `recorded yearning: ${params.subject}` }] };
    },
  });

  pi.registerTool({
    name: "resolve_yearning",
    description: "Mark a yearning as answered and remove it. Move the fact to a topical file separately via write_memory.",
    parameters: Type.Object({
      subject: Type.String({ description: "The yearning's subject slug." }),
    }),
    async execute(_id: string, params: { subject: string }) {
      const filename = `${params.subject}.md`;
      const path = safePath(filename, YEARNINGS_DIR);
      if (!path || !existsSync(path)) return { content: [{ type: "text", text: `not found: ${params.subject}` }] };
      unlinkSync(path);
      return { content: [{ type: "text", text: `resolved yearning: ${params.subject}` }] };
    },
  });
}
```

### Settings.json change

```json
{
  "extensions": [
    ".pi/extensions/use-max/index.ts",
    ".pi/extensions/memory/index.ts"
  ]
}
```

Order matters — memory must run after identity so `ctx.getSystemPrompt()`
returns identity's persona output.

### AGENTS.md addition

Append a one-paragraph section to `proto/mother/dna/AGENTS.md`:

```markdown
## Memory

You have a memory directory at /cell/memory/. The index is
loaded into your system prompt at every session start. Use write_memory
when you learn something durable, write_yearning for open questions, and
dream when memory feels messy. Full instructions live in the system prompt
itself.
```

### Verification (Phase 1.0)

1. `bun build proto/mother/dna/.pi/extensions/memory/index.ts --target=node` — clean.
2. `cells kill <name> && cells birth <name>` — fresh agent.
3. `cells talk <name>` — agent should mention having a memory directory.
4. `well exec -s <name> -- ls /cell/memory/` — should show MEMORY.md and yearnings/.
5. Tell agent something durable (e.g. "I'm a solo dev, prefer terse responses").
6. Verify `feedback_*.md` exists and `MEMORY.md` indexes it.
7. Disconnect, reconnect, ask agent about preference. Should recall.
8. Run `pi -p "test"` from agent's repo. Confirm no `400: out of extra usage` (billing intact).

## Phase 1.1 — add the dream

### Files to create

```
proto/mother/dna/.pi/extensions/memory/
└── dream-ritual.md             ← system prompt for the dream subagent
```

### Files to modify

`proto/mother/dna/.pi/extensions/memory/index.ts` — add `dream` tool registration.

### Dream tool implementation

Inside the existing extension's default function:

```typescript
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@mariozechner/pi-coding-agent";

pi.registerTool({
  name: "dream",
  description: "Fork a subagent to consolidate memory: merge duplicates, resolve contradictions, prune the index, update yearnings. Call when MEMORY.md feels messy or after lots of new writes.",
  parameters: Type.Object({}),
  async execute(_id: string, _params: any) {
    const ritual = readFileSync(join(__dirname, "dream-ritual.md"), "utf-8");
    const { session } = await createAgentSession({
      sessionManager: SessionManager.create(MEMORY_DIR),
      resourceLoader: new DefaultResourceLoader({
        cwd: MEMORY_DIR,
        systemPromptOverride: () => ritual,
        allowedTools: ["read", "write", "bash"],
      }),
    });
    const result = await session.prompt("Run the dream ritual. Return a one-paragraph summary of what changed.");
    return { content: [{ type: "text", text: result.text ?? "(dream returned no text)" }] };
  },
});
```

### Dream ritual (`dream-ritual.md`)

System prompt for the subagent. Lifted/adapted from Swain's
`well/skills/dream/SKILL.md` (per the guidelines doc). Five phases:

```markdown
You are running the dream ritual on a Cell agent's memory directory.

You have read/write/bash access scoped to this directory only. No external
network. No identity — you are not the agent itself, you are its consolidator.

## Procedure

1. **Orient.** Read MEMORY.md and every topical file. Read the yearnings/
   directory.

2. **Gather.** Note: duplicates, contradictions, stale dates, resolved
   yearnings (questions whose answers now live in a topical file), new
   yearnings the recent content suggests.

3. **Consolidate.** Merge into existing topic files; don't create duplicates.
   Convert relative dates ("yesterday", "last week") to absolute (YYYY-MM-DD).
   Replace stale content rather than appending.

4. **Prune.** Update MEMORY.md to accurately index current files. Drop
   pointers to files you've removed. Resolve contradictions at the source.
   Keep MEMORY.md under 200 lines.

5. **Yearnings.** Delete resolved ones. Sharpen vague ones. Aim for 5–10
   active. If there are 30, you're hoarding — prune aggressively.

## Constraints

- Edit in place. No "draft → review → commit" steps.
- If nothing changed, say so. Empty dreams are fine.
- Return a one-paragraph summary of what you did.
```

### Verification (Phase 1.1)

1. Manually pollute `MEMORY.md` (add duplicates, contradictions, relative dates).
2. Drop a yearning into `yearnings/` from outside the agent (operator hook).
3. Tell the agent to dream.
4. Verify MEMORY.md is reorganized, duplicates merged, dates absolute, the
   operator-written yearning is acknowledged.
5. Confirm dream returned a summary text in the tool result.

## Critical correctness

- **First-party billing must survive.** Two extensions both return systemPrompt
  from `before_agent_start` — last wins, so memory's return is what Anthropic
  sees. Verify with `pi -p` after deploy that we still bill against Pro/Max.
- **Hook order = load order.** Settings.json array order is the firing order.
  Memory after identity, never before.
- **Path containment.** `safePath` rejects `..`, absolute paths, and anything
  outside the target dir. Both `write_memory` and `write_yearning` use it.
- **Truncation preserves header.** First 10 lines of MEMORY.md (the index
  pointer block) survive truncation. Pure tail-truncation drops the index.
- **Dream subagent has no persona.** It runs in `cwd = memory/` but its system
  prompt is the dream ritual — not the agent's identity. Otherwise the dream
  sees itself as the agent and writes self-referential garbage.
- **Manual dream only for v1.** No cron, no idle-trigger, no
  session_shutdown firing. Wells hibernate when idle and we don't want to
  pin them awake.

## Order of work

1. Write `proto/mother/dna/.pi/extensions/memory/auto-memory-prompt.md`.
2. Write `proto/mother/dna/.pi/extensions/memory/index.ts` (Phase 1.0 only — skip dream tool).
3. Update `proto/mother/dna/.pi/settings.json` to load the extension.
4. Update `proto/mother/dna/AGENTS.md` with memory paragraph.
5. Update `proto/mother/dna/.gitignore` to exclude `memory/`.
6. `bun build` to verify compile.
7. `cells kill <name> && cells birth <name>` against a clean Well.
8. Run Phase 1.0 verification steps.
9. Once 1.0 passes: write `dream-ritual.md`.
10. Add `dream` tool to `index.ts`.
11. Rebuild, redeploy (or push the file directly via `well_push` and reload).
12. Run Phase 1.1 verification.
13. Update `ROADMAP.md` to mark Phase 1 complete.
