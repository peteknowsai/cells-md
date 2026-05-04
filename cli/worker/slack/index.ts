/**
 * cells-front-slack — the Slack twin.
 *
 * Two routes:
 *   POST /events  — Slack Events API webhook (inbound). Verifies HMAC,
 *                   resolves channel→cell via KV, fans out to the cell's
 *                   Worker at https://<cell>.cells.md/inbox/append.
 *   POST /send    — outbound from cells. Replaces the mother-proxy /send
 *                   route. Cells' slack_post extension already POSTs here;
 *                   the URL is unchanged, the backend is now Cloudflare.
 *
 * Channel→cell bindings live in the CHANNELS KV namespace, keyed by
 * channel ID with the cell name as value. `cells channel link/unlink`
 * on the Mac writes through to KV.
 */

export interface Env {
  CHANNELS: KVNamespace;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  CELLS_PROXY_SECRET: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/events") return handleEvents(req, env, ctx);
    if (req.method === "POST" && url.pathname === "/send") return handleSend(req, env);
    if (req.method === "POST" && url.pathname === "/edit") return handleEdit(req, env);
    if (req.method === "GET" && url.pathname === "/_debug/kv") {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${env.CELLS_PROXY_SECRET}`) return new Response("unauthorized", { status: 401 });
      const channel = url.searchParams.get("channel") ?? "";
      const cached = await env.CHANNELS.get(channel, { cacheTtl: 60 });
      const fresh = await env.CHANNELS.get(channel);
      return Response.json({ channel, cached, fresh });
    }
    return new Response("not found", { status: 404 });
  },
};

// ───────────────────── inbound: Slack → cell ─────────────────────

async function handleEvents(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  const raw = await req.text();

  if (!(await verifySlackSignature(env.SLACK_SIGNING_SECRET, ts, raw, sig))) {
    return new Response("bad signature", { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // url_verification handshake — Slack pings this when you set the URL.
  if (body.type === "url_verification") {
    return Response.json({ challenge: body.challenge });
  }

  if (body.type !== "event_callback" || !body.event) {
    console.log(`drop: type=${body.type}`);
    return new Response("ok", { status: 200 });
  }

  const event = body.event;

  // Loop prevention: drop messages posted by our cells bot user OR
  // any bot_message — chat.postMessage replies from cells come back
  // as subtype=bot_message with no user field. Other bot integrations
  // (GitHub, etc.) also subtype=bot_message; cells don't react to
  // those automatically.
  const CELLS_BOT_USER_ID = "U0B231DT0D6";
  if (event.user === CELLS_BOT_USER_ID || event.subtype === "bot_message") {
    console.log(`drop self/bot: type=${event.type} subtype=${event.subtype} user=${event.user}`);
    return new Response("ok", { status: 200 });
  }
  if (event.subtype && event.subtype !== "thread_broadcast") {
    console.log(`drop subtype: type=${event.type} subtype=${event.subtype}`);
    return new Response("ok", { status: 200 });
  }

  const channelId = event.channel as string | undefined;
  if (!channelId) {
    console.log(`drop no-channel: type=${event.type}`);
    return new Response("ok", { status: 200 });
  }

  // cacheTtl: 60 keeps KV reads at the edge for a minute — the
  // CHANNELS namespace is small and changes only on `cells channel
  // link/unlink`. Default cacheTtl was bigger and caused stale
  // "missing" reads after a fresh binding.
  const cell = await env.CHANNELS.get(channelId, { cacheTtl: 60 });
  if (!cell) {
    console.log(`drop unbound: channel=${channelId}`);
    return new Response("ok", { status: 200 });
  }
  console.log(`route ${channelId} -> ${cell} (user=${event.user} text=${(event.text??"").slice(0,50)})`);

  // Fan out to the cell's Worker. Don't await — return 200 to Slack
  // immediately; Slack retries on >3s response so we don't want to
  // serialize the cell hop into the response budget.
  ctx.waitUntil(
    fetch(`https://${cell}.cells.md/inbox/append`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CELLS_PROXY_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ event, team_id: body.team_id, event_id: body.event_id }),
    }).then((r) => {
      console.log(`fan-out -> ${cell}: ${r.status}`);
      if (!r.ok) {
        return r.text().then((t) => console.error(`fan-out body: ${t.slice(0, 200)}`));
      }
    }).catch((e) => console.error(`fan-out to ${cell} threw: ${String(e).slice(0, 300)}`)),
  );

  return new Response("ok", { status: 200 });
}

// HMAC-SHA256 verify per https://api.slack.com/authentication/verifying-requests-from-slack
async function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  if (!signingSecret || !timestamp || !signature) return false;
  // Replay protection: reject anything older than 5 minutes.
  const now = Math.floor(Date.now() / 1000);
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 300) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const expected = "v0=" + bufToHex(mac);
  return timingSafeEqual(expected, signature);
}

function bufToHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ───────────────────── outbound: cell → Slack ─────────────────────

async function handleSend(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.CELLS_PROXY_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload: {
    cell?: string;
    text?: string;
    channel?: string;
    thread_ts?: string;
    username?: string;
    icon_url?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const cell = (payload.cell ?? "").trim();
  const text = payload.text ?? "";
  if (!cell || !/^[a-z0-9-]+$/.test(cell)) return new Response("missing or bad cell", { status: 400 });
  if (typeof text !== "string" || !text) return new Response("missing text", { status: 400 });

  let channel = payload.channel;
  if (!channel) channel = (await reverseLookup(env.CHANNELS, cell)) ?? undefined;
  if (!channel) {
    return Response.json({ ok: false, error: "no channel for cell" }, { status: 404 });
  }

  const username = payload.username ?? cell;
  const iconUrl =
    payload.icon_url ?? `https://www.gravatar.com/avatar/${await md5Hex(`cell:${cell}`)}?d=identicon&s=96`;

  // Use markdown_text — Slack server-side renders standard markdown
  // (headings, **bold**, *italic*, [text](url), bullets, blockquotes,
  // inline code), so cells can emit normal markdown without us
  // running a client-side converter. Note: markdown_text and text
  // are mutually exclusive per Slack's API.
  const body = {
    channel,
    markdown_text: text,
    username,
    icon_url: iconUrl,
    ...(payload.thread_ts ? { thread_ts: payload.thread_ts } : {}),
  };

  const upstream = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const respText = await upstream.text();
  let respJson: any = null;
  try { respJson = JSON.parse(respText); } catch { /* keep raw */ }
  const okFlag = respJson?.ok === true;
  console.log(
    `slack ${cell} → ${channel} ${okFlag ? `ok ts=${respJson.ts}` : `FAIL ${respJson?.error ?? upstream.status}`} (${text.length}B)`,
  );

  return new Response(respText, {
    status: okFlag ? 200 : 502,
    headers: { "content-type": "application/json" },
  });
}

// chat.update for streaming edits. The CellAgent DO calls this every ~1Hz
// while a turn is in flight, posting deltas as text replacements.
async function handleEdit(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.CELLS_PROXY_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  let payload: { cell?: string; text?: string; channel?: string; ts?: string };
  try { payload = await req.json(); }
  catch { return new Response("bad json", { status: 400 }); }

  const cell = (payload.cell ?? "").trim();
  const text = payload.text ?? "";
  const channel = (payload.channel ?? "").trim();
  const ts = (payload.ts ?? "").trim();
  if (!cell || !channel || !ts) return new Response("missing cell/channel/ts", { status: 400 });
  if (typeof text !== "string") return new Response("missing text", { status: 400 });

  const upstream = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, ts, markdown_text: text }),
  });
  const respText = await upstream.text();
  let respJson: any = null;
  try { respJson = JSON.parse(respText); } catch { /* keep raw */ }
  const okFlag = respJson?.ok === true;
  if (!okFlag) console.log(`slack edit ${cell} ${channel}/${ts} FAIL ${respJson?.error ?? upstream.status}`);
  return new Response(respText, {
    status: okFlag ? 200 : 502,
    headers: { "content-type": "application/json" },
  });
}

// Cell→channel reverse lookup. KV keys are channel IDs; values are cell
// names. To find a channel for a given cell we scan. Fan-out is small
// (one binding per channel, a handful of channels per workspace) so a
// list is fine; if it grows we can maintain a `cell:<name>` reverse key
// at link time.
async function reverseLookup(kv: KVNamespace, cell: string): Promise<string | null> {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ cursor, limit: 1000 });
    for (const k of page.keys) {
      const v = await kv.get(k.name);
      if (v === cell) return k.name;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return null;
}

async function md5Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("MD5" as any, new TextEncoder().encode(input)).catch(() => null);
  if (buf) return bufToHex(buf);
  // Workers' SubtleCrypto doesn't ship MD5 in all runtimes. Fall back to
  // a tiny pure-JS implementation so gravatar URLs still render.
  return md5HexPure(input);
}

// Minimal MD5 (RFC 1321) — used only to build deterministic gravatar
// identicons, never for security. Inlined to avoid the dep.
function md5HexPure(s: string): string {
  function toBytes(str: string) {
    const out: number[] = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }
  function rl(x: number, n: number) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
  function add32(a: number, b: number) { return ((a + b) & 0xffffffff) >>> 0; }
  const bytes = toBytes(s);
  const len = bytes.length;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const bitLen = len * 8;
  for (let i = 0; i < 8; i++) bytes.push((bitLen >>> (i * 8)) & 0xff);
  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < bytes.length; off += 64) {
    const M: number[] = [];
    for (let i = 0; i < 16; i++) {
      M.push(
        (bytes[off + i * 4]!) |
        (bytes[off + i * 4 + 1]! << 8) |
        (bytes[off + i * 4 + 2]! << 16) |
        (bytes[off + i * 4 + 3]! << 24),
      );
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = add32(add32(add32(F, A), K[i]!), M[g]!);
      A = D; D = C; C = B; B = add32(B, rl(F, S[i]!));
    }
    a0 = add32(a0, A); b0 = add32(b0, B); c0 = add32(c0, C); d0 = add32(d0, D);
  }
  function hex(n: number) {
    let r = "";
    for (let i = 0; i < 4; i++) r += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    return r;
  }
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
