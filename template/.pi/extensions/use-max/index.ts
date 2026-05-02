/**
 * use-max — first-party billing trigger.
 *
 * Routes the cell's API calls to Pete's Claude Max subscription instead of
 * extra-usage metered billing. Composes the cell's anatomy files at the
 * agent root into one structured systemPrompt and returns it via the
 * before_agent_start hook. Setting systemPrompt via the SDK is what trips
 * Anthropic's first-party-billing gate; auto-load of AGENTS.md from cwd
 * doesn't.
 *
 * Each file keeps its own H1 heading; composition is just file bodies
 * concatenated in order. SOUL.md is required; the rest are optional.
 *
 * If SOUL.md is missing the hook returns nothing — pi falls back to its
 * auto-load behavior, which doesn't trip Max. With extra-usage disabled,
 * misconfiguration 401s instead of silently routing to metered billing.
 *
 * See PI-FIRST-PARTY-BILLING-RECIPE.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const FILES = [
  "SOUL.md",
  "CELLS.md",
  "TOOLS.md",
  "CONTACTS.md",
  "MEMORY.md",
];

function readBody(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
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
