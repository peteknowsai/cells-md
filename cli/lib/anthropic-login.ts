// Anthropic OAuth (Claude Pro/Max) login — authorization-code + PKCE.
//
// This is the same flow pi's `/login` runs (same client_id, scopes, endpoints,
// and the `{type:"oauth", access, refresh, expires}` shape the proxy reads from
// ~/.pi/agent/auth.json) — reimplemented natively so `cells login` owns its
// recovery path and doesn't route the operator through the pi TUI.
//
// The pure helpers are unit-tested in anthropic-login.test.ts; runAnthropicLogin
// is the IO shell (callback server + browser + token exchange).

import { createHash, randomBytes } from "node:crypto";

// The Claude OAuth client. Matches cli/proxy.ts's ANTHROPIC_OAUTH_CLIENT_ID and
// pi-ai's anthropic provider — all three must agree or tokens won't refresh.
export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
export const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PORT = 53692;
export const CALLBACK_PATH = "/callback";
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

export type AnthropicCreds = { type: "oauth"; access: string; refresh: string; expires: number };

function base64url(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// SHA-256 → base64url, per RFC 7636 (S256). Pure so it can be vector-tested.
export function pkceChallengeFromVerifier(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: pkceChallengeFromVerifier(verifier) };
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const p = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

export function tokenExchangeBody(code: string, state: string, verifier: string, redirectUri: string) {
  return {
    grant_type: "authorization_code",
    client_id: ANTHROPIC_CLIENT_ID,
    code,
    state,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  };
}

// Shape the OAuth token endpoint's JSON into the auth.json anthropic block.
// `now` is injected so the 5-minute skew (matched to pi-ai/proxy) is testable.
export function parseTokenResponse(raw: string, now: number): AnthropicCreds {
  const d = JSON.parse(raw) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!d.access_token || !d.refresh_token || typeof d.expires_in !== "number") {
    throw new Error(`token response missing fields: ${raw.slice(0, 200)}`);
  }
  return {
    type: "oauth",
    access: d.access_token,
    refresh: d.refresh_token,
    expires: now + d.expires_in * 1000 - 5 * 60 * 1000,
  };
}

// Accept whatever the user pastes from the browser: a full redirect URL, a
// "code#state" pair, a query string, or a bare code. Mirrors pi's parser.
export function parseAuthInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
  } catch {
    /* not a URL */
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: value };
}

// Merge fresh anthropic creds into the existing auth.json, preserving every
// other provider (openai-codex, etc.). Pure — caller handles the disk write.
export function mergeAnthropicAuth(existing: Record<string, unknown> | null, creds: AnthropicCreds): Record<string, unknown> {
  return { ...(existing ?? {}), anthropic: creds };
}

export type LoginIO = {
  openBrowser: (url: string) => void | Promise<void>;
  promptManual: () => Promise<string>; // read one line of user input
  log: (msg: string) => void;
  timeoutMs?: number;
};

// Drive the full browser OAuth: spin up the localhost callback server, open the
// authorize URL, capture the redirect (or accept a pasted URL/code if no
// callback arrives), then exchange the code for tokens.
export async function runAnthropicLogin(io: LoginIO): Promise<AnthropicCreds> {
  const { verifier, challenge } = generatePkce();
  const state = verifier;
  const authUrl = buildAuthorizeUrl(challenge, state);

  const { createServer } = await import("node:http");
  let resolveCode!: (v: { code: string; state: string } | null) => void;
  const codePromise = new Promise<{ code: string; state: string } | null>((r) => (resolveCode = r));

  const server = createServer((req, res) => {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const code = url.searchParams.get("code");
    const st = url.searchParams.get("state");
    const err = url.searchParams.get("error");
    if (err || !code || !st || st !== state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h2>cells login failed</h2><p>You can close this window and retry <code>cells login</code>.</p>");
      if (err) resolveCode(null);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>cells login complete ✓</h2><p>You can close this window.</p>");
    resolveCode({ code, state: st });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve());
  });

  try {
    io.log("Opening your browser to authorize Anthropic…");
    await io.openBrowser(authUrl);
    io.log(`If it didn't open, visit this URL:\n  ${authUrl}\n`);

    const timeoutMs = io.timeoutMs ?? 300_000;
    const timed = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs).unref?.());
    const captured = await Promise.race([codePromise, timed]);

    let code = captured?.code;
    let st = captured?.state;
    if (!code) {
      io.log("No automatic callback yet — paste the redirect URL (or code) from the browser, then press enter:");
      const parsed = parseAuthInput(await io.promptManual());
      if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
      code = parsed.code;
      st = parsed.state ?? state;
    }
    if (!code) throw new Error("no authorization code received");

    io.log("Exchanging authorization code for tokens…");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(tokenExchangeBody(code, st ?? state, verifier, REDIRECT_URI)),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${body.slice(0, 200)}`);
    return parseTokenResponse(body, Date.now());
  } finally {
    server.close();
  }
}
