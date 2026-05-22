/**
 * cells-front-<cell> — per-cell twin (v2).
 *
 * One Worker per cell, named at birth (cells-front-bob, cells-front-pete, …).
 *
 * Control-plane routes (Bearer CELLS_PROXY_SECRET):
 *   GET  /agent         — the well's supervisor dials in here; the
 *                         per-cell Durable Object accepts and holds the
 *                         WebSocket. That WS is the bidirectional bridge
 *                         for prompts (down) and pi RPC events (up).
 *   POST /inbox/append  — receive Slack events from the Slack Worker.
 *                         Forwarded into the per-cell Durable Object. If
 *                         the cell is hibernating the DO rings the
 *                         doorbell (proxy.cells.md/wake) and queues the
 *                         message until the supervisor dials back in.
 *   POST /site/publish  — the cell's site server pushes a full snapshot
 *                         of its public/ dir here; the DO stores it.
 *   POST /image/upload  — relay an image to Cloudflare Images. The CF
 *                         token is a Worker secret — it never lands on
 *                         a cell VM. Returns the delivery URL.
 *   GET  /debug         — dump current DO state (ws status, active turn).
 *
 * Public route (no auth — this is the cell's public face):
 *   GET  /*             — <cell>.cells.md, served from the snapshot the
 *                         DO holds. Push model: the cell publishes while
 *                         awake, the DO serves always — so the site stays
 *                         up while the cell sleeps or hibernates.
 *
 * Pi runs in --mode rpc inside the well, supervised by site/server.ts.
 * The DO renders pi's event stream into Slack messages by
 * chat.postMessage on agent_start and chat.update as deltas arrive.
 * No slack_post tool needed.
 */

import { verifyClerkSession } from "../../shared/clerk-gate";

export { CellAgent } from "./cell-agent";

export interface Env {
  CELL_NAME: string;
  CELL_AGENT: DurableObjectNamespace;
  CHANNELS: KVNamespace;
  CELLS_PROXY_SECRET: string;
  // Cloudflare Images relay (POST /image/upload). The token is a Worker
  // secret — it never lands on a cell VM. The account id is a plain var.
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  // Clerk auth — one app across all cells, cookie domain `.cells.md` so
  // sign-in on one cell unlocks every cell. Both are Worker secrets:
  //   - CLERK_PUBLISHABLE_KEY: the pk_(test|live)_… string. Embedded in
  //     the served HTML so the Clerk widget can bootstrap. Public by
  //     definition; kept as a secret for rotation convenience.
  //   - CLERK_JWT_KEY: PEM-encoded RSA public key for networkless JWT
  //     verification (no extra hop to clerk.com on every request).
  // Both are optional — if either is missing, the Worker skips the auth
  // path and the site behaves exactly as it did pre-Clerk.
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_JWT_KEY?: string;
}

function doStub(env: Env): DurableObjectStub {
  return env.CELL_AGENT.get(env.CELL_AGENT.idFromName(env.CELL_NAME));
}

// Relay an image to Cloudflare Images on the cell's behalf. The cell's
// publish-image script sends the raw image bytes as the request body
// (content-type = the image's mime, x-filename = its name). We wrap
// those into the multipart form the CF Images API wants and forward it
// with the account token — so the CF credential never lands on a cell
// VM — then hand back the delivery URL. Stateless: no DO, nothing
// stored cell-side.
async function handleImageUpload(req: Request, env: Env): Promise<Response> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return new Response("image upload not configured (missing CF credentials)", { status: 503 });
  }
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) {
    return new Response("empty body — send the image as the raw request body", { status: 400 });
  }
  const ct = req.headers.get("content-type") || "application/octet-stream";
  const filename = req.headers.get("x-filename") || "image";

  const cfForm = new FormData();
  cfForm.append("file", new Blob([bytes], { type: ct }), filename);
  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/images/v1`,
    { method: "POST", headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, body: cfForm },
  );
  const cfJson = await cfRes.json().catch(() => null) as any;
  if (!cfRes.ok || !cfJson?.success) {
    const msg = cfJson?.errors?.[0]?.message ?? `HTTP ${cfRes.status}`;
    return new Response(`cloudflare images upload failed: ${msg}`, { status: 502 });
  }
  const variants: string[] = cfJson.result?.variants ?? [];
  // Prefer the "public" variant; fall back to whatever CF returned first.
  const url = variants.find((v) => v.endsWith("/public")) ?? variants[0] ?? "";
  return Response.json({ url, id: cfJson.result?.id ?? "" });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Control plane — bridge WS, Slack inbox, site publish, image upload,
    // debug. Bearer-gated: only the cell's own supervisor and the Slack
    // Worker reach these.
    if (
      path === "/agent" ||
      path === "/inbox/append" ||
      path === "/site/publish" ||
      path === "/image/upload" ||
      path === "/debug"
    ) {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${env.CELLS_PROXY_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }

      // Bridge WebSocket — the well's supervisor dials in here and the
      // CellAgent DO accepts it (post-direction-flip). Forward the upgrade
      // request straight to the DO, which holds the connection.
      if (path === "/agent") {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("expected websocket upgrade", { status: 426 });
        }
        return doStub(env).fetch(req);
      }

      if (req.method === "POST" && path === "/inbox/append") {
        const bodyText = await req.text();
        // Forward into the DO, which owns the WebSocket to the well and
        // the per-turn Slack message lifecycle.
        const r = await doStub(env).fetch("https://do/append", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyText,
        });
        return new Response(null, { status: r.ok ? 202 : r.status });
      }

      if (req.method === "POST" && path === "/site/publish") {
        const bodyText = await req.text();
        // The cell's site server pushes a full snapshot of its public/
        // dir; the DO stores it and serves it on the public route below
        // — so <cell>.cells.md stays up even while the cell sleeps.
        return doStub(env).fetch("https://do/site-publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyText,
        });
      }

      if (req.method === "POST" && path === "/image/upload") {
        return handleImageUpload(req, env);
      }

      if (req.method === "GET" && path === "/debug") {
        return doStub(env).fetch("https://do/debug");
      }

      return new Response("not found", { status: 404 });
    }

    // Public site — <cell>.cells.md, the cell's public face. Served by
    // the DO from the last published snapshot, whether the cell is
    // awake, asleep, or hibernating. The DO never sees the control-
    // plane paths here: the worker names every internal route.
    //
    // Clerk gating: verify the `__session` cookie networklessly against
    // CLERK_JWT_KEY. We pass the result into the DO as `x-signed-in`,
    // and the DO uses HTMLRewriter to strip `[data-private]` elements
    // for anon visitors. Private bytes never leave the edge for users
    // without a valid session. Cookie domain `.cells.md` means one
    // sign-in covers every cell in the fleet.
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    const signedIn = await verifyClerkSession(req, env.CLERK_JWT_KEY);
    return doStub(env).fetch("https://do/site-serve", {
      headers: {
        "x-site-path": path,
        "x-signed-in": signedIn ? "1" : "0",
      },
    });
  },
};
