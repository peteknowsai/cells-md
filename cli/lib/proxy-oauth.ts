// Pure (side-effect-free) helpers for the subscriptions proxy's Anthropic
// OAuth route. Extracted from cli/proxy.ts so they can be unit-tested without
// importing the proxy module (which starts Bun.serve + the refresh loops at
// module top level). Nothing here touches the filesystem, the network, or any
// module-level mutable state.

// Anthropic's OAuth gate requires the first system block to equal EXACTLY this
// string for Max/OAuth-token traffic (opus enforces it; haiku/sonnet don't).
export const CLAUDE_CODE_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";

// hermes cells reach the Anthropic proxy at /anthropic.com/v1/* instead of /v1/*.
// The `/anthropic.com` segment is load-bearing on the cell side, NOT here: the
// hermes-agent Anthropic adapter only takes its Claude-Code OAuth path (Bearer
// auth + claude-cli user-agent that clears Cloudflare + the preamble + oauth
// betas) when the SDK base_url contains the substring "anthropic.com". Its
// default "third-party proxy" path would instead send x-api-key + the
// `Anthropic/Python` SDK user-agent, which Cloudflare blocks at the edge with a
// 403 before the request ever reaches us. So the hermes provider's base_url is
// `https://proxy.cells.md/anthropic.com`; the SDK appends `/v1/messages`; we
// strip the prefix here and route to the normal Anthropic upstream. pi and
// claude-code keep hitting plain `/v1/*` and are unaffected.
export const ANTHROPIC_OAUTH_PREFIX = "/anthropic.com";

// Ensure system block[0] is exactly the Claude Code preamble, idempotently.
// hermes prepends it itself on its OAuth path; this is a belt-and-suspenders
// guarantee for the opus gate that is a no-op when it's already there. Accepts
// the Anthropic `system` field in any of its legal shapes (string, block array,
// or absent) and returns it as a block array with the preamble first.
export function ensurePreamble(body: Record<string, unknown>): Record<string, unknown> {
  const sys = body.system;
  let blocks: unknown[];
  if (sys == null) blocks = [];
  else if (typeof sys === "string") blocks = sys.length ? [{ type: "text", text: sys }] : [];
  else if (Array.isArray(sys)) blocks = sys;
  else return body; // unknown shape — don't touch it
  const first = blocks[0] as { type?: string; text?: string } | undefined;
  if (first && first.type === "text" && first.text === CLAUDE_CODE_PREAMBLE) {
    body.system = blocks; // already present (string→array normalization is fine)
    return body;
  }
  body.system = [{ type: "text", text: CLAUDE_CODE_PREAMBLE }, ...blocks];
  return body;
}

// hermes's OAuth route arrives as /anthropic.com/v1/* — strip the prefix so the
// upstream path is the normal /v1/* (see ANTHROPIC_OAUTH_PREFIX above). Returns
// whether the request is on the hermes OAuth route and the resulting upstream
// path. On any other route the path passes through unchanged.
export function classifyOAuthRoute(pathname: string): { isHermesOAuthRoute: boolean; upstreamPath: string } {
  const isHermesOAuthRoute =
    pathname === ANTHROPIC_OAUTH_PREFIX || pathname.startsWith(ANTHROPIC_OAUTH_PREFIX + "/");
  const upstreamPath = isHermesOAuthRoute
    ? pathname.slice(ANTHROPIC_OAUTH_PREFIX.length) || "/"
    : pathname;
  return { isHermesOAuthRoute, upstreamPath };
}
