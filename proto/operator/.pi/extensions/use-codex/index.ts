/**
 * use-codex — operator's billing + anatomy composer.
 *
 * Two responsibilities (mirrors pulse's use-codex):
 *
 *   1. Route openai-codex requests through mother.cells.md/codex so
 *      operator's gpt-5.5 calls land on Pete's ChatGPT sub via the mother
 *      proxy, not on metered OpenAI API.
 *
 *   2. Compose operator's anatomy files into systemPrompt via
 *      before_agent_start. Operator's anatomy is leaner than mother's and
 *      pulse's — no MEMORY.md (v1 has no persistent operator memory),
 *      no CELLS.md (operator queries the registry via cells_list at
 *      runtime, not via static prompt baking — the cell roster changes
 *      faster than a session).
 */

import * as fs from "node:fs";
import * as path from "node:path";

const FILES = [
  "SOUL.md",
  "TOOLS.md",
  "HEARTBEAT.md",
];

function readBody(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (m?.[1] ?? raw).trim();
}

export default function (pi: any) {
  // 1. Provider routing.
  const secret = process.env.OPENAI_CODEX_API_KEY;
  if (secret) {
    pi.registerProvider("openai-codex", {
      baseUrl: "https://mother.cells.md/codex",
      apiKey: secret,
      authHeader: true,
    });
  }

  // 2. Anatomy → systemPrompt.
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
