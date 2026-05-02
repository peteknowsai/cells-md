/**
 * use-codex — pulse's billing + anatomy composer.
 *
 * Two responsibilities:
 *
 *   1. Route openai-codex requests through mother.cells.md/codex (so pulse's
 *      gpt-5.5 calls land on Pete's ChatGPT sub via the mother proxy, not on
 *      metered OpenAI API). Same mechanism as cells use — register the
 *      openai-codex provider with the proxy URL + shared bearer secret.
 *
 *   2. Compose pulse's anatomy files into systemPrompt via before_agent_start
 *      hook. Mirrors use-max's pattern. Each file keeps its own H1; the
 *      composer joins them in order. Pulse's anatomy is a different set than
 *      mother's (no CELLS, no CONTACTS).
 *
 * Bearer for #1 is OPENAI_CODEX_API_KEY in the env, which we set to the
 * shared CELLS_PROXY_SECRET at session start. The proxy validates the
 * bearer and adds the real chatgpt-account-id server-side.
 *
 * The existing apply-pi-patches.sh patches @mariozechner/pi-ai's
 * openai-codex-responses.js globally to neutralize JWT-based extractAccountId
 * — pulse picks that patch up automatically since it runs `pi` from the same
 * global install mother and cells use.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Pulse's anatomy. SOUL leads. No CELLS/CONTACTS — pulse keeps no roster
// and has no relationships.
const FILES = [
  "SOUL.md",
  "TOOLS.md",
  "MEMORY.md",
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
