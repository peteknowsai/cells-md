# cell

This file is a stub. **The real agent identity lives at `.pi/agents/self.md`** —
that's what gets loaded as the system prompt by the `identity` extension at
runtime.

Pi auto-loads `AGENTS.md` from cwd by default, but the identity extension's
`before_agent_start` hook overrides Pi's default system prompt with the
contents of `.pi/agents/self.md`. We need that override path because it's what
triggers Anthropic to bill against the user's Claude Pro/Max subscription
rather than per-token extra-usage. See `~/Projects/cells/PI-FIRST-PARTY-BILLING-RECIPE.md`
for the full rationale.

If you (the agent) ever read this AGENTS.md instead of self.md, something is
misconfigured — check that the identity extension is loading correctly
(`node_modules/` populated? `.pi/extensions/identity/index.ts` exists?
`.pi/settings.json` lists it?).

## Project notes for humans

This repo is the **mother**: a local Pi agent + Bun CLI that provisions
and manages Cells (each cell = a Pi agent on its own Sprite). See `ROADMAP.md`
for what we're building. Operations run via the `cells` CLI (`cli/cells.ts`).
