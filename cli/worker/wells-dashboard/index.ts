/**
 * wells-dashboard — live-ingress Worker for Pete's wells dashboard cell.
 *
 * Public Custom Domains (user-facing):
 *   wells.cells.md           — Next.js dashboard
 *   wells-convex.cells.md    — Convex backend (HTTP + WebSocket)
 *
 * Internal tunnel hostnames (wells-side, only the Worker calls these):
 *   wells-tunnel.cells.md         → cloudflared → http://192.168.64.206:3000
 *   wells-convex-tunnel.cells.md  → cloudflared → http://192.168.64.206:3210
 *
 * The Worker maps public → internal and forwards. Cloudflared's ingress
 * rules match on the internal hostname (Host header preserved). The
 * backend gets `X-Forwarded-Host`/`-Proto` so its URL generation
 * (redirects, Convex client URLs) reflects the public origin.
 *
 * Auth: shared bearer at the edge, cookie-based so the browser carries
 * it on every request including WS upgrades. Bootstrap via ?token=<secret>
 * on first visit — Worker validates, Set-Cookie on `.cells.md`, 302
 * redirects to strip the token from the URL.
 */
export interface Env {
  WELLS_DASHBOARD_BEARER: string;
}

// public hostname → wells-side internal tunnel hostname.
const UPSTREAM: Record<string, string> = {
  "wells.cells.md": "wells-tunnel.cells.md",
  "wells-convex.cells.md": "wells-convex-tunnel.cells.md",
};

const COOKIE_NAME = "cells_auth";
const COOKIE_DOMAIN = ".cells.md";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function buildSetCookie(value: string): string {
  return [
    `${COOKIE_NAME}=${value}`,
    `Domain=${COOKIE_DOMAIN}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ].join("; ");
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

function unauthorized(): Response {
  return new Response(
    "Unauthorized. This dashboard requires a valid auth cookie or ?token= bootstrap.",
    { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

async function proxyToTunnel(req: Request, publicHost: string): Promise<Response> {
  const url = new URL(req.url);
  const upstreamHost = UPSTREAM[publicHost];
  if (!upstreamHost) return new Response("not found", { status: 404 });

  const upstreamUrl = `https://${upstreamHost}${url.pathname}${url.search}`;

  // Preserve client headers; let `Host` default to the upstream hostname
  // so cloudflared's ingress-rule matcher fires. Hint the backend about
  // the user-facing origin via standard forwarded headers — Next.js +
  // Convex both honor these for URL generation.
  const headers = new Headers(req.headers);
  headers.set("x-forwarded-host", publicHost);
  headers.set("x-forwarded-proto", "https");

  const init: RequestInit = {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  };

  // CF Workers honors Upgrade: websocket on outbound fetch and returns a
  // response with the WS pair attached — the runtime stitches client and
  // upstream sockets together for us. (Convex's WS goes through here.)
  return fetch(upstreamUrl, init as any);
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = url.hostname;

    if (!UPSTREAM[host]) {
      return new Response("not found", { status: 404 });
    }

    // 1. Cookie path — preferred. Set once via the token bootstrap below.
    const cookieVal = readCookie(req, COOKIE_NAME);
    if (cookieVal && cookieVal === env.WELLS_DASHBOARD_BEARER) {
      return proxyToTunnel(req, host);
    }

    // 2. Token bootstrap — only on wells.cells.md (the dashboard origin).
    //    Convex traffic from JS is post-bootstrap, so wells-convex.cells.md
    //    should always arrive cookie-authed; if not, 401.
    if (host === "wells.cells.md") {
      const token = url.searchParams.get("token");
      if (token && token === env.WELLS_DASHBOARD_BEARER) {
        // Strip the token from the URL and redirect with the cookie set.
        const cleanUrl = new URL(url.toString());
        cleanUrl.searchParams.delete("token");
        const dest = cleanUrl.pathname + (cleanUrl.search === "?" ? "" : cleanUrl.search);
        return new Response(null, {
          status: 302,
          headers: {
            location: dest || "/",
            "set-cookie": buildSetCookie(env.WELLS_DASHBOARD_BEARER),
            "cache-control": "no-store",
          },
        });
      }
    }

    return unauthorized();
  },
};
