/**
 * mother-codex — route codex requests through mother.cells.md.
 *
 * Codex stays on mother (Pete's home IP via cloudflared) even after the
 * pass-4 Anthropic cutover to proxy.cells.md. Reason: chatgpt.com is also
 * fronted by Cloudflare and aggressively blocks CF-Worker → CF-zone hops
 * with an anti-loop Ray-ID challenge. Anthropic doesn't share that
 * constraint, so /v1/* moved to the Worker but /codex/* is kept on mother
 * indefinitely. See docs/scratchpad.md for revisit notes.
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
