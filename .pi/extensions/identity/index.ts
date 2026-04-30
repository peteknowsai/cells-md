/**
 * Identity extension — the canonical "first-party billing trigger" pattern.
 *
 * When Pi is authenticated via Claude Pro/Max OAuth, Anthropic only routes
 * the request to first-party (subscription) billing if the system prompt is
 * set via a `before_agent_start` hook return rather than auto-discovered
 * from AGENTS.md/CLAUDE.md. Without this, third-party-harness usage draws
 * from extra-usage and is metered per-token.
 *
 * Reads `.pi/agents/self.md` (frontmatter optional) and returns its body as
 * the system prompt. If the file is missing the hook is inert — Pi falls
 * back to its default behavior and you'll silently land on extra-usage
 * billing.
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
