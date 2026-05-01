/**
 * mother-codex — route codex requests through mother.cells.md.
 *
 * Mirrors how anthropic gets routed through mother (env var + sed-patched
 * model URL). For codex, pi-ai has no env-var fallback for the openai-codex
 * provider, so we use the registerProvider API instead: override both the
 * baseUrl and the apiKey so getApiKeyAndHeaders returns our shared secret
 * and outgoing requests hit mother.
 *
 * Cells have no ~/.pi/agent/auth.json entry for openai-codex, so the
 * authStorage path returns nothing and the registerProvider apiKey wins.
 *
 * The cell-side openai-codex-responses.js is sed-patched at birth to
 * neutralize JWT-based extractAccountId (our bearer is the proxy secret,
 * not a JWT). Mother adds the real chatgpt-account-id server-side.
 */

export default function (pi: any) {
  const secret = process.env.OPENAI_CODEX_API_KEY;
  if (!secret) return;
  pi.registerProvider("openai-codex", {
    baseUrl: "https://mother.cells.md/codex",
    apiKey: secret,
    authHeader: true,
  });
}
