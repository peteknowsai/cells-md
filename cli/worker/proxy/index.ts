/**
 * cells-front-proxy — OAuth-bearing forward proxy at proxy.cells.md.
 *
 * Routes:
 *   POST /v1/*          → Anthropic API (cells use, CELLS_PROXY_SECRET)
 *   POST /codex/*       → OpenAI Codex   (cells use, CELLS_PROXY_SECRET)
 *   PUT  /tokens        → mother seeds/refreshes tokens (MOTHER_REFRESH_SECRET)
 *   GET  /tokens/state  → mother polls before refresh (MOTHER_REFRESH_SECRET)
 *   GET  /_health       → public liveness
 *
 * Tokens live in a singleton TokenStore Durable Object. Mother (the Mac
 * refresh-agent in cli/proxy.ts) is responsible for keeping access
 * tokens fresh — this Worker just reads + forwards.
 */

import { TokenStore, type AnthropicState, type CodexState } from "./proxy-do";

export { TokenStore };

export interface Env {
  TOKENS: DurableObjectNamespace;
  CELLS_PROXY_SECRET: string;
  MOTHER_REFRESH_SECRET: string;
}

const ANTHROPIC_UPSTREAM = "https://api.anthropic.com";
const CODEX_UPSTREAM = "https://chatgpt.com/backend-api";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/_health") {
      return Response.json({ ok: true });
    }
    if (path === "/tokens" || path === "/tokens/state") {
      return handleTokens(req, env, url);
    }
    if (path.startsWith("/v1/")) {
      return handleAnthropic(req, env, url);
    }
    if (path.startsWith("/codex/")) {
      return handleCodex(req, env, url);
    }
    return new Response("not found", { status: 404 });
  },
};

function tokensStub(env: Env): DurableObjectStub {
  return env.TOKENS.get(env.TOKENS.idFromName("tokens"));
}

// ───────────────────── mother routes ─────────────────────

async function handleTokens(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.MOTHER_REFRESH_SECRET) {
    return new Response("MOTHER_REFRESH_SECRET unset on Worker", { status: 503 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.MOTHER_REFRESH_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const stub = tokensStub(env);

  if (req.method === "GET" && url.pathname === "/tokens/state") {
    return stub.fetch(new Request("https://do/state"));
  }

  if (req.method === "PUT" && url.pathname === "/tokens") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const provider = body?.provider;
    if (provider === "anthropic") {
      const s: AnthropicState = {
        accessToken: body.accessToken,
        expiresAt: body.expiresAt,
        refreshToken: body.refreshToken,
      };
      if (!s.accessToken || !s.expiresAt) {
        return new Response("missing accessToken/expiresAt", { status: 400 });
      }
      return stub.fetch(
        new Request("https://do/set-anthropic", {
          method: "POST",
          body: JSON.stringify(s),
        }),
      );
    }
    if (provider === "codex") {
      const s: CodexState = {
        accessToken: body.accessToken,
        expiresAt: body.expiresAt,
        refreshToken: body.refreshToken,
        accountId: body.accountId,
      };
      if (!s.accessToken || !s.expiresAt || !s.accountId) {
        return new Response("missing accessToken/expiresAt/accountId", { status: 400 });
      }
      return stub.fetch(
        new Request("https://do/set-codex", {
          method: "POST",
          body: JSON.stringify(s),
        }),
      );
    }
    return new Response(`unknown provider: ${provider}`, { status: 400 });
  }

  return new Response("method not allowed", { status: 405 });
}

// ───────────────────── cell routes ─────────────────────

function checkCellAuth(req: Request, env: Env): boolean {
  const auth = req.headers.get("authorization") ?? "";
  return !!env.CELLS_PROXY_SECRET && auth === `Bearer ${env.CELLS_PROXY_SECRET}`;
}

async function handleAnthropic(req: Request, env: Env, url: URL): Promise<Response> {
  if (!checkCellAuth(req, env)) return new Response("unauthorized", { status: 401 });

  const stub = tokensStub(env);
  const stateRes = await stub.fetch(new Request("https://do/get-anthropic"));
  const tok = (await stateRes.json()) as AnthropicState | null;
  if (!tok) return new Response("no anthropic token seeded", { status: 503 });

  const upstreamUrl = ANTHROPIC_UPSTREAM + url.pathname + url.search;
  const headers = stripHopHeaders(new Headers(req.headers));
  headers.delete("authorization");
  headers.delete("x-cell-name");
  if (!headers.get("anthropic-beta")?.includes("oauth-2025-04-20")) {
    const existing = headers.get("anthropic-beta");
    headers.set("anthropic-beta", existing ? `${existing}, oauth-2025-04-20` : "oauth-2025-04-20");
  }
  headers.set("authorization", `Bearer ${tok.accessToken}`);

  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
  });

  if (upstream.status === 401) {
    // Don't retry — token is stale; mother will refresh on next poll.
    return new Response("upstream 401 — access token stale, refresh pending", {
      status: 502,
      headers: { "x-cells-proxy-hint": "access-token-stale" },
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

async function handleCodex(req: Request, env: Env, url: URL): Promise<Response> {
  if (!checkCellAuth(req, env)) return new Response("unauthorized", { status: 401 });

  const stub = tokensStub(env);
  const stateRes = await stub.fetch(new Request("https://do/get-codex"));
  const tok = (await stateRes.json()) as CodexState | null;
  if (!tok) return new Response("no codex token seeded", { status: 503 });

  // /codex/responses → https://chatgpt.com/backend-api/codex/responses.
  const upstreamUrl = CODEX_UPSTREAM + url.pathname + url.search;
  const headers = stripHopHeaders(new Headers(req.headers));
  headers.delete("authorization");
  headers.delete("x-cell-name");
  headers.set("authorization", `Bearer ${tok.accessToken}`);
  headers.set("chatgpt-account-id", tok.accountId);
  headers.set("originator", "pi");

  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
  });

  if (upstream.status === 401) {
    return new Response("upstream 401 — codex access token stale", {
      status: 502,
      headers: { "x-cells-proxy-hint": "access-token-stale" },
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

// chatgpt.com is also fronted by Cloudflare; forwarding the inbound CF
// headers triggers anti-loop 403s. Strip them on the way out for both
// upstreams (symmetric hygiene; Anthropic doesn't need it but it's harmless).
function stripHopHeaders(h: Headers): Headers {
  h.delete("host");
  h.delete("cdn-loop");
  h.delete("x-real-ip");
  for (const k of [...h.keys()]) {
    if (k.startsWith("cf-") || k.startsWith("x-forwarded-")) h.delete(k);
  }
  return h;
}
