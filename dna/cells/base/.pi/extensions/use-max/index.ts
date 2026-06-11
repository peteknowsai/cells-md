/**
 * use-max — persona composer (the name is historical).
 *
 * Composes the cell's anatomy files at the agent root into one structured
 * systemPrompt and returns it via the before_agent_start hook — without it
 * the cell speaks as stock Pi. Each file keeps its own H1 heading;
 * composition is just file bodies concatenated in order. SOUL.md is
 * required; the rest are optional. If SOUL.md is missing the hook returns
 * nothing — pi falls back to its auto-load behavior.
 *
 * Why the name: setting systemPrompt via the SDK is also what trips
 * Anthropic's first-party-billing gate, which is how pi cells rode the
 * Claude Max sub until 2026-06-11. That lane is closed by policy — Max is
 * claude-code-harness-only; pi rides the ChatGPT sub via the /codex proxy
 * route, and the proxy 403s pi calls to the Anthropic route
 * (anthropicRouteVerdict in cli/lib/proxy-oauth.ts). The composer stays
 * because the persona is harness furniture, not billing plumbing.
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
