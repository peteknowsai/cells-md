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

// ── Max-policy gate ────────────────────────────────────────────────────
//
// The Claude Max subscription is claude-code-harness-only (Pete, 2026-06-11):
// Anthropic permits Max use through Claude Code; every other harness rides
// the ChatGPT subscription via the /codex route. Birth refuses pi+anthropic
// combos up front, but the proxy is where the guarantee becomes structural —
// a misconfigured or legacy cell gets a loud 403 here instead of silently
// burning the Max sub.
//
// Identity comes from the x-cell-name header (self-reported — cells aren't
// adversarial; the threat model is misconfiguration) resolved against the
// Mac-side registry by the caller. The verdict is pure so it's testable:
// the caller hands us whatever the registry lookup produced.
//
// A cell may pass either by harness ("claude-code") or by carrying an
// explicit claude-code:anthropic/* chain entry — the dual-harness specials
// (mother: registry harness "pi", chain primary claude-code+opus) are
// sanctioned by their chain, not their spawn harness. UA can't be the key:
// pi-ai's OAuth path sends the same claude-cli/<version> UA as Claude Code.
export function anthropicRouteVerdict(
  cell: { harness?: string; modelChain?: string[] } | undefined,
): { allowed: boolean; reason: string } {
  if (!cell) {
    return {
      allowed: false,
      reason: "cell not in registry — the Anthropic route requires a registered claude-code cell (x-cell-name header)",
    };
  }
  const harness = cell.harness ?? "pi"; // absent on older entries → pi (registry.ts contract)
  if (harness === "claude-code") return { allowed: true, reason: "claude-code harness" };
  if ((cell.modelChain ?? []).some((e) => e.startsWith("claude-code:anthropic/"))) {
    return { allowed: true, reason: "claude-code:anthropic chain entry" };
  }
  return {
    allowed: false,
    reason: `harness '${harness}' doesn't ride the Max sub — Anthropic models are claude-code-only; use gpt-5.5 via /codex`,
  };
}

// ── Gate-cache reload policy ────────────────────────────────────────────
//
// The proxy caches the registry for the gate (a 30s TTL keeps the hot path
// off the disk). But a claude-code cell mid-birth registers as "warming"
// only moments before its end-test fires its first Anthropic call — and if
// that call hits a stale cache the cell isn't in yet, the gate 403s and birth
// fails. So on a *miss* we reload once (bounded by a short floor so an unknown
// caller can't force a disk read per request), making a just-registered cell
// visible without waiting a full TTL.
export function gateCacheNeedsReload(
  cacheAt: number | null,
  now: number,
  nameFound: boolean,
  ttlMs: number,
  missFloorMs: number,
): boolean {
  if (cacheAt === null) return true; // no cache yet
  const age = now - cacheAt;
  if (age > ttlMs) return true; // stale by TTL
  if (!nameFound && age > missFloorMs) return true; // maybe just-registered
  return false;
}

// A dead OAuth refresh token comes back as an `invalid_grant` error — but the
// HTTP status is provider-specific: Anthropic returns 400, others 401. Match
// the error code in the response body so a revoked token is recognized
// regardless of status and never mistaken for a transient error. (Anthropic's
// 400 invalid_grant slipping through a 401-only check is what let a revoked
// token fail silently for 2.5 days.)
export function isInvalidGrant(body: string): boolean {
  return /invalid_grant/i.test(body);
}
