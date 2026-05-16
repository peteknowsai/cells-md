/**
 * codex-proxy — route codex requests through the subscriptions proxy
 * at proxy.cells.md.
 *
 * Both Anthropic and Codex egress through Pete's laptop via cloudflared
 * (home-IP egress). See docs/architectural-decisions/0001 for why we
 * don't run this in a Cloudflare Worker.
 *
 * Pi-ai has no env-var fallback for the openai-codex provider, so we use
 * the registerProvider API: override both the baseUrl and the apiKey so
 * getApiKeyAndHeaders returns our shared secret and outgoing requests
 * hit the proxy.
 *
 * Cells have no ~/.pi/agent/auth.json entry for openai-codex, so the
 * authStorage path returns nothing and the registerProvider apiKey wins.
 *
 * The cell-side openai-codex-responses.js is sed-patched at birth to
 * neutralize JWT-based extractAccountId (our bearer is the proxy secret,
 * not a JWT). The proxy adds the real chatgpt-account-id server-side.
 */

import { readFileSync } from "node:fs";

// This cell's name — imprinted into package.json at birth (the ritual
// seds __NAME__). NOT os.hostname(): a pool-born cell keeps its generic
// egg-XXXXXX well name as the hostname, so the hostname is the well, not
// the cell.
function cellName(): string {
  try {
    return JSON.parse(readFileSync("/root/package.json", "utf8")).name || "unknown";
  } catch {
    return "unknown";
  }
}

export default function (pi: any) {
  const secret = process.env.OPENAI_CODEX_API_KEY;
  if (!secret) return;
  pi.registerProvider("openai-codex", {
    baseUrl: "https://proxy.cells.md/codex",
    apiKey: secret,
    authHeader: true,
    // Identify this cell to the proxy. It logs x-cell-name for per-cell
    // attribution and strips the header before forwarding upstream, so it
    // never leaks to the model backend.
    headers: { "x-cell-name": cellName() },
  });
}
