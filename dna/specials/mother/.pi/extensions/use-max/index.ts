/**
 * use-max — first-party billing trigger.
 *
 * Routes API calls to Pete's Claude Max subscription instead of extra-usage
 * metered billing. Anthropic gates first-party billing on the system prompt
 * being set via a before_agent_start hook (not auto-discovered from
 * AGENTS.md/CLAUDE.md). This extension composes the agent's anatomy files
 * at the workspace root into one structured systemPrompt — which trips
 * the gate.
 *
 * Each file keeps its own H1 heading; composition is just file bodies
 * concatenated in order with blank lines between. SOUL.md is required;
 * the rest are optional. CELLS.md only exists on cells, not on mother.
 *
 * If SOUL.md is missing the hook returns nothing — pi falls back to its
 * auto-load behavior. Pete has extra-usage disabled, so a misconfiguration
 * here 401s loudly instead of silently routing to metered billing.
 *
 * See PI-FIRST-PARTY-BILLING-RECIPE.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Order matters — SOUL leads, the rest fall in beneath. Each file owns its
// own H1; the composer just joins. Add new files here as the anatomy grows.
const FILES = [
  "SOUL.md",
  "CELLS.md",     // cell-only; mother doesn't have this file
  "TOOLS.md",
  "CONTACTS.md",
  "MEMORY.md",
];

function readBody(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  // Strip optional YAML frontmatter; agents.md-style files often carry it.
  const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (m?.[1] ?? raw).trim();
}

export default function (pi: any) {
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    const soul = readBody(path.join(ctx.cwd, "SOUL.md"));
    if (!soul) return {};

    const parts: string[] = [];
    for (const f of FILES) {
      const body = readBody(path.join(ctx.cwd, f));
      if (body) parts.push(body);
    }

    return { systemPrompt: parts.join("\n\n") };
  });
}
