/**
 * use-max — first-party billing trigger.
 *
 * Routes API calls to Pete's Claude Max subscription instead of extra-usage
 * metered billing. Anthropic gates first-party billing on the system prompt
 * being set via a before_agent_start hook (not auto-discovered from
 * AGENTS.md/CLAUDE.md). This extension reads the persona at AGENTS.md and
 * returns its body as the system prompt — which trips the gate.
 *
 * If AGENTS.md is missing the hook is inert and the cell silently lands on
 * extra-usage billing. See PI-FIRST-PARTY-BILLING-RECIPE.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export default function (pi: any) {
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    const personaPath = path.join(ctx.cwd, "AGENTS.md");
    if (!fs.existsSync(personaPath)) return {};

    const raw = fs.readFileSync(personaPath, "utf-8");
    const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = bodyMatch?.[1]?.trim() ?? raw.trim();

    return { systemPrompt: body };
  });
}
