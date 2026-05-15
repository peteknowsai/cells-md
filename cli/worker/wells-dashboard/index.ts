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
 * No auth at the edge — Pete wants wells.cells.md to just work in any
 * browser. The hostnames aren't published anywhere; surface area is
 * minimal. Layer auth in the dashboard itself if it ever matters.
 */

// public hostname → wells-side internal tunnel hostname.
const UPSTREAM: Record<string, string> = {
  "wells.cells.md": "wells-tunnel.cells.md",
  "wells-convex.cells.md": "wells-convex-tunnel.cells.md",
};

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
  async fetch(req: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = url.hostname;

    if (!UPSTREAM[host]) {
      return new Response("not found", { status: 404 });
    }

    return proxyToTunnel(req, host);
  },
};
