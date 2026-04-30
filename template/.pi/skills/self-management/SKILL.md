---
name: self-management
description: Extend, modify, and evolve yourself — install new Pi packages, write custom extensions, update your persona, write new skills. Invoke when the user asks you to add a capability, change how you behave, or remember a new way of doing things.
allowed-tools: [bash, read, write, write_memory]
---

# Self-management

You are a Pi agent on a Sprite. Your filesystem is yours — you can extend
your own capabilities at runtime. This skill describes how.

## 1. Install Pi packages

Pi has its own package manager. Use it to add tools, skills, and extensions
written by others.

```bash
pi install -l npm:<package-name>      # install project-local
pi list                                # what's installed
pi remove npm:<package-name>           # uninstall
pi update                              # update everything
```

`-l` makes it project-local (lives in `/home/sprite/agent/.pi/npm/`). Drop
the flag for global install.

After installing, **restart yourself** so Pi loads the new extension:
- Tell the user to detach and reattach (Ctrl-b d, then `cells talk <NAME>`)
- Or they can run `/reload` inside the TUI

Examples of useful packages: `pi-web-access` (web search + URL fetch — you
already have it). Search npm for `pi-` prefixed packages for more.

## 2. Write a custom extension

When no package does what you need, write your own. Drop a TypeScript file
at `.pi/extensions/<name>/index.ts`:

```typescript
import { Type } from "@sinclair/typebox";

export default function (pi: any) {
  pi.registerTool({
    name: "my_tool",
    description: "What this tool does.",
    parameters: Type.Object({
      arg: Type.String({ description: "..." }),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: "result" }] };
    },
  });
}
```

Then add the path to `.pi/settings.json`:

```json
{ "extensions": [".pi/extensions/identity/index.ts", ".pi/extensions/<name>/index.ts"] }
```

Restart to load. Reference existing extensions in `.pi/extensions/` for
patterns. Hooks available: `session_start`, `before_agent_start`, `turn_end`,
`tool_call`, etc. Full surface in the Pi extension docs.

## 3. Morph your persona

Your identity lives at `.pi/agents/self.md`. The body (after frontmatter) is
your system prompt. When the user asks for a durable behavioral change —
"be more terse," "always confirm before X," "you specialize in Y" — edit
`self.md` in place.

Rules:
- Keep it short. Every token loads on every conversation.
- Don't restate things already in skills or extensions.
- Frontmatter (`name`, `description`, `model`) stays as-is unless asked.
- After editing, the change is live next session start. To pick it up
  immediately, tell the user to detach and reattach.

## 4. Write a new skill

Skills are markdown files that teach you how to do something. Add one when
you've figured out a procedure worth remembering.

Drop at `.pi/skills/<name>/SKILL.md`:

```markdown
---
name: <name>
description: One-line trigger — when should this skill be invoked?
allowed-tools: [bash, read, write]
---

# Skill body

Step-by-step instructions, examples, gotchas.
```

Pi auto-discovers it. The model invokes it when the description matches
intent, or the user types `/skill:<name>`.

## When to use this skill

- User asks you to "remember how to X" → write a skill or update self.md
- User asks for a capability you don't have → install a package or write
  an extension
- User asks for a behavioral change ("from now on...") → update self.md
- You learn a procedure worth keeping → write a skill

Don't pre-extend yourself speculatively. Wait for a concrete need.

## Always

After any self-modification, save a `feedback_*.md` memory noting what you
changed and why, so future-you understands the trail.
