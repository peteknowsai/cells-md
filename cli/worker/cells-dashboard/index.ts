/**
 * cells-dashboard — live-ingress Worker for the cells dashboard cell.
 *
 * Public Custom Domains (user-facing):
 *   cells.cells.md           — Next.js dashboard
 *   cells-convex.cells.md    — Convex backend (HTTP + WebSocket)
 *
 * Internal tunnel hostnames (cells-side, only the Worker calls these):
 *   cells-tunnel.cells.md         → cloudflared → http://127.0.0.1:13001
 *   cells-convex-tunnel.cells.md  → cloudflared → http://127.0.0.1:13211
 *
 * The Worker maps public → internal and forwards. cloudflared's ingress
 * rules match on the internal hostname (Host header preserved). The
 * backend gets `X-Forwarded-Host`/`-Proto` so its URL generation
 * (redirects, Convex client URLs) reflects the public origin.
 *
 * No auth at the edge — sibling to wells.cells.md's just-works pattern.
 * The hostnames aren't published anywhere; surface area is minimal.
 */

const UPSTREAM: Record<string, string> = {
  "cells.cells.md": "cells-tunnel.cells.md",
  "cells-convex.cells.md": "cells-convex-tunnel.cells.md",
};

async function proxyToTunnel(req: Request, publicHost: string): Promise<Response> {
  const url = new URL(req.url);
  const upstreamHost = UPSTREAM[publicHost];
  if (!upstreamHost) return new Response("not found", { status: 404 });

  const upstreamUrl = `https://${upstreamHost}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  headers.set("x-forwarded-host", publicHost);
  headers.set("x-forwarded-proto", "https");

  const init: RequestInit = {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  };

  // CF Workers honors Upgrade: websocket on outbound fetch — Convex's WS
  // goes through here.
  return fetch(upstreamUrl, init as any);
}

export default {
  async fetch(req: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = url.hostname;
    if (!UPSTREAM[host]) return new Response("not found", { status: 404 });
    return proxyToTunnel(req, host);
  },
};
