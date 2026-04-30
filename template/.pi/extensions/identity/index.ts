/**
 * Identity extension — the canonical "first-party billing trigger" pattern.
 * See ~/Projects/cells/PI-FIRST-PARTY-BILLING-RECIPE.md for the full rationale.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export default function (pi: any) {
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    const personaPath = path.join(ctx.cwd, ".pi", "agents", "self.md");
    if (!fs.existsSync(personaPath)) return {};

    const raw = fs.readFileSync(personaPath, "utf-8");
    const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = bodyMatch?.[1]?.trim() ?? raw.trim();

    return { systemPrompt: body };
  });
}
