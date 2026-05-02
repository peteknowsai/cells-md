/**
 * use-max — first-party billing trigger.
 *
 * Routes the cell's API calls to Pete's Claude Max subscription instead of
 * extra-usage metered billing. Reads the persona at AGENTS.md and returns its
 * body via a before_agent_start hook — which is what trips the Anthropic
 * first-party-billing gate. Pi would auto-load AGENTS.md on its own otherwise,
 * but auto-discovery doesn't trigger Max billing — only the SDK hook does.
 * See PI-FIRST-PARTY-BILLING-RECIPE.md.
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
