// Subscriptions proxy for the cells fleet — single Bun.serve that handles:
//
//   proxy.cells.md
//     /                   → fleet dashboard (HTML)
//     /v1/*               → Anthropic API proxy (Bearer auth required)
//     /codex/*            → OpenAI Codex (ChatGPT sub) proxy (Bearer auth required)
//     /_proxy/health      → JSON health
//
//   pulse.cells.md
//     /                   → pulse status page (HTML)
//     /heartbeat-changed  → cell HEARTBEAT.md change events written to
//                           ~/.cells/pulse-inbox/ (Bearer auth required)
//
//   slack.cells.md
//     /                   → slack status page (HTML)
//     /send               → cell-side Slack outbound. Cells POST
//                           {cell, text, channel?, thread_ts?, username?,
//                           icon_url?}; proxy resolves channel from
//                           ~/.cells/channels.json and calls
//                           chat.postMessage with username/icon override.
//                           (Bearer auth required.)
//
//   <cell>.cells.md
//     /                   → per-cell info page (HTML, rendered by mother)
//
// One tunnel, one Bun process. The wildcard CNAME *.cells.md → cells-proxy
// tunnel sends every Host here; we route by Host header.
//
// Auth model:
//   - /v1/* and /codex/* require Authorization: Bearer <CELLS_PROXY_SECRET>.
//     Pi clients send this via ANTHROPIC_AUTH_TOKEN (anthropic) or
//     OPENAI_CODEX_API_KEY (codex).
//   - / pages are public reads for now (auth coming later).
//
// Token strategy:
//   - This proxy is the SOLE owner of OAuth refresh in the fleet, for both
//     anthropic and openai-codex. Independent refresh managers (timer +
//     mutex + 429 backoff) per provider — failures in one don't stop the
//     other. Anthropic ticks every 5 min and refreshes with < 60 min
//     headroom (its tokens are short-lived). Codex ticks every 30 min and
//     refreshes with < 24 h headroom (its JWTs are 10 days).
//   - Mother pi and cells only READ auth.json. Because this proxy keeps
//     access tokens fresh with comfortable headroom, neither ever observes
//     an expired token, so pi-ai's per-call refresh stays dormant.
//   - On upstream 401 we self-heal: force a refresh, retry the original
//     request once. If refresh ALSO returns 401, the refresh token is
//     genuinely revoked — we surface a Mac notification + write a flag file
//     (~/.cells/auth-needs-login or ~/.cells/codex-needs-login), and Pete
//     /login's pi when convenient.
//   - See docs/oauth-refresh.md for the full architecture, contract, and
//     ops playbook.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyClerkSession, gateHtml } from "./shared/clerk-gate";
import { wellNameForCell } from "./lib/resolve";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const MOTHER_ROOT = join(REPO_ROOT, "dna", "specials", "mother");

const AUTH_PATH = join(homedir(), ".pi/agent/auth.json");
const SECRETS_PATH = join(homedir(), ".cells/secrets.json");
const PULSE_INBOX_DIR = join(homedir(), ".cells/pulse-inbox");
const CELLS_REGISTRY = join(homedir(), ".cells/cells.json");
const ACTIVITY_PATH = join(MOTHER_ROOT, "state/memory/project_cells_activity.md");
const UPSTREAM = "https://api.anthropic.com";
const CODEX_UPSTREAM = "https://chatgpt.com/backend-api";
const PORT = Number(process.env.CELLS_PROXY_PORT ?? 8787);

function readSecret(): string {
  if (process.env.CELLS_PROXY_SECRET) return process.env.CELLS_PROXY_SECRET;
  if (existsSync(SECRETS_PATH)) {
    const s = JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
    if (s.CELLS_PROXY_SECRET) return s.CELLS_PROXY_SECRET;
  }
  console.error("CELLS_PROXY_SECRET not set (env or ~/.cells/secrets.json)");
  process.exit(1);
}
const SHARED_SECRET = readSecret();

// Clerk keys for gating HTML responses on mother.cells.md / pulse.cells.md
// (the bespoke pages the proxy serves directly — every other *.cells.md
// goes through its own Cloudflare Worker). Both are optional: if either
// is missing, the proxy serves pages exactly as it did pre-Clerk.
function readClerkKeys(): { publishableKey?: string; jwtKey?: string } {
  try {
    if (!existsSync(SECRETS_PATH)) return {};
    const s = JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
    return {
      publishableKey: typeof s.CLERK_PUBLISHABLE_KEY === "string" ? s.CLERK_PUBLISHABLE_KEY : undefined,
      jwtKey:         typeof s.CLERK_JWT_KEY         === "string" ? s.CLERK_JWT_KEY         : undefined,
    };
  } catch { return {}; }
}
const CLERK_KEYS = readClerkKeys();

// Wrap an HTML Response with the same Clerk gating the per-cell Workers
// apply: verify the __session cookie, strip [data-private] for anon
// visitors, inject the widget snippet. Non-HTML responses pass through.
// Use on any proxy handler that serves a *.cells.md HTML page (mother,
// pulse, future specials).
async function gateProxyHtml(req: Request, response: Response): Promise<Response> {
  const signedIn = await verifyClerkSession(req, CLERK_KEYS.jwtKey);
  return gateHtml(response, { signedIn, publishableKey: CLERK_KEYS.publishableKey });
}


type AnthropicAuth = { type: "oauth"; refresh: string; access: string; expires: number };
type CodexAuth = {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId: string;
};
type AuthJson = {
  anthropic: AnthropicAuth;
  // Optional — mother always has it, but tolerate absence so startup doesn't
  // hard-fail when only one sub is configured.
  "openai-codex"?: CodexAuth;
  // Other providers (openai, ...) may live alongside; we don't touch them.
  [k: string]: unknown;
};

async function readAccessToken(): Promise<{ access: string; expiresMs: number }> {
  const raw = await readFile(AUTH_PATH, "utf-8");
  const parsed = JSON.parse(raw) as AuthJson;
  return { access: parsed.anthropic.access, expiresMs: parsed.anthropic.expires };
}

async function readCodexAuth(): Promise<{
  access: string;
  refresh: string;
  expiresMs: number;
  accountId: string;
}> {
  const raw = await readFile(AUTH_PATH, "utf-8");
  const parsed = JSON.parse(raw) as AuthJson;
  const c = parsed["openai-codex"];
  if (!c) throw new Error("auth.json has no openai-codex entry");
  return { access: c.access, refresh: c.refresh, expiresMs: c.expires, accountId: c.accountId };
}

// Decode the chatgpt_account_id claim from an OpenAI Codex JWT. The codex
// provider in pi-ai extracts this at request time; on mother we extract it
// once at refresh time and persist alongside the access token, so request
// handling stays a header-swap rather than a JWT-parse.
function extractAccountIdFromJwt(jwt: string): string {
  const parts = jwt.split(".");
  if (parts.length < 2) return "";
  let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  payload += "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    const json = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    return json["https://api.openai.com/auth"]?.chatgpt_account_id ?? "";
  } catch {
    return "";
  }
}

// ───────────────────── refresh manager ─────────────────────
// See docs/oauth-refresh.md for the full design rationale.

const ANTHROPIC_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Refresh proactively when access has < 60 min left. Pi-ai's own per-call
// refresh fires only when access is already expired, so 60 min headroom
// keeps pi from ever observing a stale token in practice.
const REFRESH_HEADROOM_MS = 60 * 60 * 1000;
const REFRESH_TICK_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;
const AUTH_NEEDS_LOGIN_FLAG = join(homedir(), ".cells", "auth-needs-login");


let blockedUntilMs = 0;
let inFlight: Promise<void> | null = null;
let lastRefresh: { at: number; outcome: "ok" | "429" | "401" | "error"; detail?: string } | null = null;

// Cache of valid client bearers. Always includes SHARED_SECRET (cells use this
// via ANTHROPIC_AUTH_TOKEN). Also includes the *current* anthropic OAuth access
// token so mother's local pi — which reads auth.json directly and sends that
// OAuth token as Bearer — can authenticate to its own proxy. Updated on every
// successful refresh + on startup.
const validBearers = new Set<string>([SHARED_SECRET]);

async function refreshValidBearers(): Promise<void> {
  try {
    const { access } = await readAccessToken();
    validBearers.clear();
    validBearers.add(SHARED_SECRET);
    validBearers.add(access);
  } catch { /* auth.json missing/corrupt — fall back to SHARED_SECRET only */ }
}

async function atomicWriteAuth(json: AuthJson): Promise<void> {
  const tmp = AUTH_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(json, null, 2), { mode: 0o600 });
  await rename(tmp, AUTH_PATH);
  // Whenever we rewrite auth.json (anthropic OR codex refresh), refresh the
  // bearer cache so mother's pi can keep authenticating after a token rotate.
  await refreshValidBearers();
}

async function performRefresh(): Promise<void> {
  if (Date.now() < blockedUntilMs) {
    const wait = Math.round((blockedUntilMs - Date.now()) / 60000);
    console.log(`[refresh] backoff active, ${wait}m remaining`);
    return;
  }

  let auth: AuthJson;
  try {
    auth = JSON.parse(await readFile(AUTH_PATH, "utf-8")) as AuthJson;
  } catch (e) {
    lastRefresh = { at: Date.now(), outcome: "error", detail: `read auth.json: ${e}` };
    console.error(`[refresh] cannot read auth.json: ${e}`);
    return;
  }
  const refreshToken = auth.anthropic?.refresh;
  if (!refreshToken) {
    lastRefresh = { at: Date.now(), outcome: "error", detail: "no anthropic.refresh in auth.json" };
    console.error(`[refresh] auth.json has no anthropic.refresh — run /login`);
    return;
  }

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
  } catch (e) {
    lastRefresh = { at: Date.now(), outcome: "error", detail: String(e) };
    console.error(`[refresh] network error: ${e}`);
    return;
  }

  if (res.status === 429) {
    blockedUntilMs = Date.now() + RATE_LIMIT_BACKOFF_MS;
    lastRefresh = { at: Date.now(), outcome: "429" };
    console.warn(`[refresh] rate-limited, backing off until ${new Date(blockedUntilMs).toISOString()}`);
    return;
  }

  if (res.status === 401) {
    lastRefresh = { at: Date.now(), outcome: "401" };
    notifyHumanForLogin().catch(() => {});
    console.error(`[refresh] 401 — refresh token rejected. /login required.`);
    return;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    lastRefresh = { at: Date.now(), outcome: "error", detail: `${res.status}: ${body.slice(0, 200)}` };
    console.error(`[refresh] unexpected ${res.status}: ${body.slice(0, 200)}`);
    return;
  }

  const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const newAuth: AuthJson = {
    ...auth,
    anthropic: {
      type: "oauth",
      access: data.access_token,
      refresh: data.refresh_token,
      // Match pi-ai's 5-min skew so we never disagree on freshness.
      expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    },
  };
  await atomicWriteAuth(newAuth);
  lastRefresh = { at: Date.now(), outcome: "ok" };
  // Successful refresh clears any stale "needs login" flag.
  await Bun.file(AUTH_NEEDS_LOGIN_FLAG).exists().then(async (e) => {
    if (e) await Bun.write(AUTH_NEEDS_LOGIN_FLAG + ".cleared", `${new Date().toISOString()}\n`).catch(() => {});
  }).catch(() => {});
  console.log(`[refresh] ok in ${Date.now() - startedAt}ms; access expires ${new Date(newAuth.anthropic.expires).toISOString()}`);
}

async function refreshIfNeeded(force = false): Promise<void> {
  if (inFlight) return inFlight; // serialize concurrent callers
  if (!force) {
    try {
      const { expiresMs } = await readAccessToken();
      if (expiresMs - Date.now() > REFRESH_HEADROOM_MS) return;
    } catch (e) {
      console.error(`[refresh] readAccessToken pre-check failed: ${e}`);
      // Fall through and try a refresh anyway.
    }
  }
  inFlight = performRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function notifyHumanForLogin(): Promise<void> {
  const msg = "OAuth refresh token revoked. Run /login in pi to recover.";
  // Mac notification — best effort; ignore if osascript not available.
  Bun.spawn(["osascript", "-e", `display notification "${msg}" with title "cells: auth needs attention"`], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited.catch(() => {});
  // Flag file for cells doctor / status-line checks.
  await Bun.write(AUTH_NEEDS_LOGIN_FLAG, `${new Date().toISOString()}\n`).catch(() => {});
}

// Kick off the periodic refresh loop. The first tick runs immediately so
// startup never starts cold against a near-expired token.
setInterval(() => {
  refreshIfNeeded().catch((e) => console.error(`[refresh] tick error: ${e}`));
}, REFRESH_TICK_MS);
refreshIfNeeded().catch((e) => console.error(`[refresh] startup error: ${e}`));

// ───────────────────── codex refresh manager ─────────────────────
// Mirrors the anthropic refresh manager. Independent state so failures in one
// don't impact the other. Codex JWTs are 10-day; we tick less often and
// refresh with comfortable headroom so cells never observe a stale token.

const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const CODEX_REFRESH_HEADROOM_MS = 24 * 60 * 60 * 1000; // 24 h
const CODEX_REFRESH_TICK_MS = 30 * 60 * 1000; // 30 min
const CODEX_NEEDS_LOGIN_FLAG = join(homedir(), ".cells", "codex-needs-login");

let codexBlockedUntilMs = 0;
let codexInFlight: Promise<void> | null = null;
let lastCodexRefresh: { at: number; outcome: "ok" | "429" | "401" | "error"; detail?: string } | null = null;

async function performCodexRefresh(): Promise<void> {
  if (Date.now() < codexBlockedUntilMs) {
    const wait = Math.round((codexBlockedUntilMs - Date.now()) / 60000);
    console.log(`[codex-refresh] backoff active, ${wait}m remaining`);
    return;
  }

  let auth: AuthJson;
  try {
    auth = JSON.parse(await readFile(AUTH_PATH, "utf-8")) as AuthJson;
  } catch (e) {
    lastCodexRefresh = { at: Date.now(), outcome: "error", detail: `read auth.json: ${e}` };
    console.error(`[codex-refresh] cannot read auth.json: ${e}`);
    return;
  }
  const refreshToken = auth["openai-codex"]?.refresh;
  if (!refreshToken) {
    lastCodexRefresh = { at: Date.now(), outcome: "error", detail: "no openai-codex.refresh in auth.json" };
    console.error(`[codex-refresh] auth.json has no openai-codex.refresh — run /login codex`);
    return;
  }

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(OPENAI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: OPENAI_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
  } catch (e) {
    lastCodexRefresh = { at: Date.now(), outcome: "error", detail: String(e) };
    console.error(`[codex-refresh] network error: ${e}`);
    return;
  }

  if (res.status === 429) {
    codexBlockedUntilMs = Date.now() + RATE_LIMIT_BACKOFF_MS;
    lastCodexRefresh = { at: Date.now(), outcome: "429" };
    console.warn(`[codex-refresh] rate-limited, backing off until ${new Date(codexBlockedUntilMs).toISOString()}`);
    return;
  }

  if (res.status === 401) {
    lastCodexRefresh = { at: Date.now(), outcome: "401" };
    notifyCodexLoginNeeded().catch(() => {});
    console.error(`[codex-refresh] 401 — refresh token rejected. /login codex required.`);
    return;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    lastCodexRefresh = { at: Date.now(), outcome: "error", detail: `${res.status}: ${body.slice(0, 200)}` };
    console.error(`[codex-refresh] unexpected ${res.status}: ${body.slice(0, 200)}`);
    return;
  }

  const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const accountId = extractAccountIdFromJwt(data.access_token) || auth["openai-codex"]?.accountId || "";
  if (!accountId) {
    console.warn(`[codex-refresh] could not extract chatgpt_account_id from new JWT; downstream calls will likely fail`);
  }
  const newAuth: AuthJson = {
    ...auth,
    "openai-codex": {
      type: "oauth",
      access: data.access_token,
      refresh: data.refresh_token,
      // 5-min skew so pi-ai's per-call check never disagrees on freshness.
      expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
      accountId,
    },
  };
  await atomicWriteAuth(newAuth);
  lastCodexRefresh = { at: Date.now(), outcome: "ok" };
  await Bun.file(CODEX_NEEDS_LOGIN_FLAG).exists().then(async (e) => {
    if (e) await Bun.write(CODEX_NEEDS_LOGIN_FLAG + ".cleared", `${new Date().toISOString()}\n`).catch(() => {});
  }).catch(() => {});
  console.log(
    `[codex-refresh] ok in ${Date.now() - startedAt}ms; access expires ${new Date(newAuth["openai-codex"]!.expires).toISOString()}`,
  );
}

async function refreshCodexIfNeeded(force = false): Promise<void> {
  if (codexInFlight) return codexInFlight;
  if (!force) {
    try {
      const { expiresMs } = await readCodexAuth();
      if (expiresMs - Date.now() > CODEX_REFRESH_HEADROOM_MS) return;
    } catch (e) {
      console.error(`[codex-refresh] readCodexAuth pre-check failed: ${e}`);
      // Fall through and try a refresh anyway.
    }
  }
  codexInFlight = performCodexRefresh().finally(() => {
    codexInFlight = null;
  });
  return codexInFlight;
}

async function notifyCodexLoginNeeded(): Promise<void> {
  const msg = "Codex OAuth refresh token revoked. Run /login codex in pi to recover.";
  Bun.spawn(["osascript", "-e", `display notification "${msg}" with title "cells: codex auth needs attention"`], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited.catch(() => {});
  await Bun.write(CODEX_NEEDS_LOGIN_FLAG, `${new Date().toISOString()}\n`).catch(() => {});
}

setInterval(() => {
  refreshCodexIfNeeded().catch((e) => console.error(`[codex-refresh] tick error: ${e}`));
}, CODEX_REFRESH_TICK_MS);
refreshCodexIfNeeded().catch((e) => console.error(`[codex-refresh] startup error: ${e}`));

// ───────────────────── routing ─────────────────────

function hostOf(req: Request): string {
  const url = new URL(req.url);
  return (req.headers.get("host") ?? url.host).toLowerCase();
}

// Strip encoding headers before forwarding an upstream response downstream.
// Bun's fetch transparently decodes the body when it's streamed, but
// `upstream.headers` still carries the original `content-encoding` plus the
// now-wrong (compressed) `content-length`. Forwarding those over a decoded
// body makes a downstream client — notably the `claude` CLI — try to gunzip
// plaintext and blow up with a ZlibError. Drop both; the runtime re-derives
// content-length for the body it actually sends.
function forwardableHeaders(upstream: Headers): Headers {
  const h = new Headers(upstream);
  h.delete("content-encoding");
  h.delete("content-length");
  return h;
}

// ───────────────────── well-host fallthrough ─────────────────────
//
// The cloudflared tunnel routes `*.cells.md → cells proxy:8787` because the
// cells proxy is the catch-all for known cell-shaped hostnames (mother,
// pulse, proxy). Well-shaped hostnames (`egg-<hex>.cells.md`, served by
// welld at 127.0.0.1:7878) ride the same tunnel and land here too — the
// per-cell Cloudflare Worker DO opens `wss://<wellname>.cells.md/agent` to
// push Slack-driven prompts into the live well. Without this fallthrough
// that WS upgrade 404s and slack→cell is silently broken fleet-wide.
//
// Per the wells/cells V1 boundary, the namespace authority for "what's a
// well?" is welld — we just forward anything matching the well-name shape
// and let welld validate. Two well-name shapes: pool/egg wells (`egg-<hex>`)
// and special wells (`cells-<name>`, e.g. cells-pulse / cells-mother). Both
// need the fallthrough once the special runs the agent-comms bridge — its
// CF Worker DO opens `wss://cells-<name>.cells.md/agent`. The special's
// *cell* host (`pulse.cells.md`, `mother.cells.md`) is unaffected: those
// are matched by the bespoke handlers above, before this fallthrough.
const WELLD_HTTP = "http://127.0.0.1:7878";
const WELLD_WS = "ws://127.0.0.1:7878";
const WELL_HOST_RE = /^(egg-[a-z0-9]+|cells-[a-z0-9-]+)\.cells\.md(:\d+)?$/i;

function isWellHost(host: string): boolean {
  return WELL_HOST_RE.test(host);
}

async function handleWellHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const upstreamUrl = `${WELLD_HTTP}${url.pathname}${url.search}`;
  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: req.headers, // welld dispatches on the original Host
      body: req.body,
      // @ts-expect-error Bun streams bodies through fetch with duplex:'half'
      duplex: req.body ? "half" : undefined,
      redirect: "manual",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: forwardableHeaders(upstream.headers),
    });
  } catch (e) {
    return new Response(`welld unreachable: ${String(e).slice(0, 200)}`, { status: 502 });
  }
}

// WS forwarding state, parked on `ws.data` for the lifetime of the upgrade.
// `queued` buffers downstream→upstream frames that arrive before the
// upstream socket finishes its handshake (the cell Worker DO sends nothing
// before the server speaks first today, but the queue keeps us safe for
// future protocols).
type WellWsData = {
  upstreamUrl: string;
  fwdHeaders: Record<string, string>;
  upstream: WebSocket | null;
  upstreamReady: boolean;
  queued: (string | ArrayBufferLike | Uint8Array)[];
};

function buildWellWsData(req: Request, host: string): WellWsData {
  const url = new URL(req.url);
  const upstreamUrl = `${WELLD_WS}${url.pathname}${url.search}`;
  const fwdHeaders: Record<string, string> = { host };
  const pass = ["authorization", "cookie", "origin", "sec-websocket-protocol"];
  for (const h of pass) {
    const v = req.headers.get(h);
    if (v) fwdHeaders[h] = v;
  }
  for (const [k, v] of req.headers) {
    if (k.toLowerCase().startsWith("x-")) fwdHeaders[k] = v;
  }
  return { upstreamUrl, fwdHeaders, upstream: null, upstreamReady: false, queued: [] };
}

// ───────────────────── proxy (api path) ─────────────────────

// Peer registry — discovery surface for `cells talk --list`. Reads the
// operator's local registry at ~/.cells/cells.json and returns the alive
// cells in a stable shape. Bearer-auth-gated (same secret as other proxy
// routes). The agent-comms primitive doesn't lean on capability filtering
// yet — that lands when we add `~/.cells/capabilities/<name>.json` files
// (deferred from v1).
async function handlePeers(req: Request): Promise<Response> {
  const auth = checkClientAuth(req);
  if (!auth.ok) return new Response(auth.reason, { status: 401 });
  try {
    const reg = JSON.parse(readFileSync(CELLS_REGISTRY, "utf8"));
    const cells: any[] = Array.isArray(reg?.cells) ? reg.cells : [];
    const peers = cells
      .filter((c) => c?.status !== "killed")
      .map((c) => ({
        name: c.name,
        status: c.status ?? "unknown",
        harness: c.harness ?? "pi",
        model: Array.isArray(c.modelChain) ? c.modelChain[0] : (c.model ?? ""),
        special: !!c.special,
        site_url: `https://${c.name}.cells.md`,
      }));
    return Response.json({ peers, as_of: new Date().toISOString() });
  } catch (e) {
    return new Response(`could not read registry: ${String(e).slice(0, 200)}`, { status: 500 });
  }
}

function checkClientAuth(req: Request): { ok: true; cell: string } | { ok: false; reason: string } {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, reason: "missing Bearer auth" };
  if (!validBearers.has(m[1])) return { ok: false, reason: "bad bearer" };
  const cell = req.headers.get("x-cell-name") ?? "unknown";
  return { ok: true, cell };
}

async function handleApiProxy(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/_proxy/health") {
    try {
      const { access, expiresMs } = await readAccessToken();
      const anthropic = {
        access_prefix: access.slice(0, 20),
        expires_in_min: Math.round((expiresMs - Date.now()) / 60000),
        last_refresh: lastRefresh,
        blocked_until: blockedUntilMs > Date.now() ? new Date(blockedUntilMs).toISOString() : null,
        needs_login: existsSync(AUTH_NEEDS_LOGIN_FLAG),
      };
      let codex: Record<string, unknown> = { configured: false };
      try {
        const c = await readCodexAuth();
        codex = {
          configured: true,
          access_prefix: c.access.slice(0, 20),
          account_id: c.accountId,
          expires_in_min: Math.round((c.expiresMs - Date.now()) / 60000),
          last_refresh: lastCodexRefresh,
          blocked_until: codexBlockedUntilMs > Date.now() ? new Date(codexBlockedUntilMs).toISOString() : null,
          needs_login: existsSync(CODEX_NEEDS_LOGIN_FLAG),
        };
      } catch (e) {
        codex = { configured: false, error: String(e) };
      }
      return Response.json({ ok: true, anthropic, codex });
    } catch (e) {
      return Response.json({ ok: false, error: String(e) }, { status: 500 });
    }
  }

  const auth = checkClientAuth(req);
  if (!auth.ok) return new Response(`unauthorized: ${auth.reason}`, { status: 401 });

  let access: string;
  try {
    access = (await readAccessToken()).access;
  } catch (e) {
    return new Response(`proxy: cannot read auth.json: ${e}`, { status: 503 });
  }

  const upstreamUrl = UPSTREAM + url.pathname + url.search;
  const baseHeaders = new Headers(req.headers);
  baseHeaders.delete("host");
  baseHeaders.delete("x-cell-name");
  baseHeaders.delete("authorization");

  // Buffer the body so we can retry on 401. Anthropic message bodies are
  // small text payloads, so this is fine; streaming responses go back
  // through `upstream.body` unchanged.
  const bodyBytes =
    req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());

  const callUpstream = async (bearer: string): Promise<Response> => {
    const headers = new Headers(baseHeaders);
    headers.set("authorization", `Bearer ${bearer}`);
    return fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: bodyBytes,
    });
  };

  const startedAt = Date.now();
  let upstream = await callUpstream(access);

  // Self-heal on 401: this can happen at the boundary of an access-token
  // expiry that the proactive timer hasn't caught yet. Force a refresh
  // and retry once.
  if (upstream.status === 401) {
    console.warn(`[proxy] upstream 401 for ${auth.cell} — forcing refresh and retrying once`);
    try {
      await refreshIfNeeded(true);
      const fresh = (await readAccessToken()).access;
      if (fresh !== access) upstream = await callUpstream(fresh);
    } catch (e) {
      console.error(`[proxy] retry-after-refresh failed: ${e}`);
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[${new Date().toISOString()}] api ${auth.cell} ${req.method} ${url.pathname} -> ${upstream.status} (${elapsed}ms)`,
  );
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardableHeaders(upstream.headers),
  });
}

// ───────────────────── proxy (codex path) ─────────────────────
//
// Cells hit https://proxy.cells.md/codex/<rest>; we strip the /codex prefix
// and forward to chatgpt.com/backend-api/<rest>. Cell-side ships the
// CELLS_PROXY_SECRET as Bearer; we replace it with the real codex JWT and
// inject chatgpt-account-id + originator (the cell's pi-ai is patched to
// skip JWT-based account-id extraction since its bearer isn't a JWT).

async function handleCodexProxy(req: Request): Promise<Response> {
  const url = new URL(req.url);

  const auth = checkClientAuth(req);
  if (!auth.ok) return new Response(`unauthorized: ${auth.reason}`, { status: 401 });

  let access: string;
  let accountId: string;
  try {
    const c = await readCodexAuth();
    access = c.access;
    accountId = c.accountId;
  } catch (e) {
    return new Response(`codex proxy: cannot read auth.json: ${e}`, { status: 503 });
  }
  if (!accountId) {
    return new Response(`codex proxy: no accountId — refresh has not run successfully yet`, { status: 503 });
  }

  // Forward the full path verbatim. The cell's pi-ai posts to /codex/responses
  // (with baseUrl=https://proxy.cells.md/codex, the codex provider's URL
  // resolver appends /responses). Backend-api's matching endpoint is
  // /codex/responses, so the path lines up — no stripping required.
  const upstreamUrl = CODEX_UPSTREAM + url.pathname + url.search;
  const baseHeaders = new Headers(req.headers);
  baseHeaders.delete("host");
  baseHeaders.delete("x-cell-name");
  baseHeaders.delete("authorization");
  // Strip CF/proxy headers added by cloudflared on the way in. chatgpt.com
  // is also behind Cloudflare, and forwarding these triggers anti-loop
  // protection → 403 with a generic block page.
  // (Re-verified 2026-05-07: removing this still produces 403 + CF block page.)
  for (const h of [...baseHeaders.keys()]) {
    if (h.startsWith("cf-") || h.startsWith("x-forwarded-") || h === "cdn-loop" || h === "x-real-ip") {
      baseHeaders.delete(h);
    }
  }
  baseHeaders.set("chatgpt-account-id", accountId);
  baseHeaders.set("originator", "codex_cli");

  // Buffer body for 401 retry. Codex requests are SSE-streamed responses
  // but the request bodies (POST /responses) are small JSON payloads.
  const bodyBytes =
    req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());

  const callUpstream = async (bearer: string): Promise<Response> => {
    const headers = new Headers(baseHeaders);
    headers.set("authorization", `Bearer ${bearer}`);
    return fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: bodyBytes,
    });
  };

  const startedAt = Date.now();
  let upstream = await callUpstream(access);

  if (upstream.status === 401) {
    console.warn(`[codex-proxy] upstream 401 for ${auth.cell} — forcing refresh and retrying once`);
    try {
      await refreshCodexIfNeeded(true);
      const fresh = (await readCodexAuth()).access;
      if (fresh !== access) upstream = await callUpstream(fresh);
    } catch (e) {
      console.error(`[codex-proxy] retry-after-refresh failed: ${e}`);
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[${new Date().toISOString()}] codex ${auth.cell} ${req.method} ${url.pathname} -> ${upstream.status} (${elapsed}ms)`,
  );
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardableHeaders(upstream.headers),
  });
}

// ───────────────────── pulse.cells.md ─────────────────────

// pulse.cells.md is the front door for events the pulse agent cares about.
// Mother proxy receives, validates the bearer, and writes payloads to a
// directory pulse owns. File system is the IPC — pulse drains the inbox
// each tick.

async function handlePulseProxy(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
    return gateProxyHtml(
      req,
      htmlPage(
        "pulse · cells",
        `<h1>pulse</h1>
         <p class="sub">timekeeper · reads HEARTBEAT.md, fires scheduled wake-ups</p>
         <p>This is the inbox endpoint pulse listens to. Cells POST schedule
         changes here; pulse drains them on its next tick. See
         <a href="https://proxy.cells.md/">the proxy</a> for the fleet dashboard.</p>
         <div data-private style="margin-top:2em;padding:1em;border:1px dashed #444;border-radius:6px">
           <p class="sub">🔓 You're signed in.</p>
           <p>This block is wrapped in <code>&lt;div data-private&gt;</code> —
              anonymous visitors never see it. The same gating as the
              per-cell sites, served straight from the Mac proxy.</p>
         </div>`,
      ),
    );
  }

  if (req.method === "POST" && url.pathname === "/heartbeat-changed") {
    const auth = checkClientAuth(req);
    if (!auth.ok) return new Response(`unauthorized: ${auth.reason}`, { status: 401 });

    let payload: { cell?: string; content?: string; ts?: string };
    try {
      payload = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const cell = (payload.cell ?? "").trim();
    const content = payload.content ?? "";
    if (!cell || !/^[a-z0-9-]+$/.test(cell)) return new Response("missing or bad cell", { status: 400 });
    if (typeof content !== "string") return new Response("bad content", { status: 400 });

    // Two destinations during the Phase 3 transition:
    //   - default: Mac path (~/.cells/pulse-inbox/) — legacy pulse-on-Mac.
    //   - CELLS_USE_PULSE_CELL=1: bridge into the active pulse cell's well
    //     at /var/cells/pulse/pulse-inbox/. Which cell is CELLS_PULSE_CELL
    //     (default `pulse`; set `pulse-cc` for the claude-code pulse).
    const useCell = process.env.CELLS_USE_PULSE_CELL === "1";
    const tsMs = Date.now();
    const filename = `${cell}-${tsMs}.md`;

    if (useCell) {
      const r = await bridgeInboxPulse({ cell, content });
      if (r.status >= 400) {
        console.warn(`[${new Date().toISOString()}] pulse-cell inbox failed (${r.status}); falling back to Mac path`);
        await mkdir(PULSE_INBOX_DIR, { recursive: true });
        await writeFile(join(PULSE_INBOX_DIR, filename), content);
      } else {
        console.log(`[${new Date().toISOString()}] pulse-cell ${cell} heartbeat-changed (${content.length}B)`);
        return new Response(null, { status: 204 });
      }
    } else {
      await mkdir(PULSE_INBOX_DIR, { recursive: true });
      await writeFile(join(PULSE_INBOX_DIR, filename), content);
    }

    console.log(
      `[${new Date().toISOString()}] pulse ${cell} heartbeat-changed -> ${filename} (${content.length}B)`,
    );
    return new Response(null, { status: 204 });
  }

  return new Response("not found", { status: 404 });
}

// ──────────────────────────── bridge endpoints ────────────────────────────
//
// proxy.cells.md/bridge/* — the cells substrate's back-channel for cells
// that need to reach the Mac (mother for birth ops, pulse for fire/inbox).
// Same Bearer auth as the LLM proxies; routes do file/process work on the
// Mac via the same primitives cli/cells.ts uses.
//
// Endpoints:
//   POST /bridge/pool/claim     — claim a generic egg, return {wellName, tier, id}
//   POST /bridge/pool/sweep     — destroy a half-born egg + trigger refill
//   POST /bridge/registry/read  — return ~/.cells/cells.json
//   POST /bridge/registry/write — replace ~/.cells/cells.json (full doc)
//   POST /bridge/well/ssh       — exec a script in a well via `well exec`, return {ok, stdout, stderr}
//   POST /bridge/mac_exec       — exec a bash script on the Mac (cwd=cells repo); logged to ~/.cells/logs/mac_exec.log
//   POST /bridge/birth/outcome  — receive {birthId, success, message} from mother
//   POST /bridge/talk           — fire `cells talk <cell> <msg>` (used by pulse)
//   POST /bridge/inbox/pulse    — push a HEARTBEAT.md payload into pulse-cell's well
//
// All routes Bearer-auth via CELLS_PROXY_SECRET. Birth outcomes are
// correlated via short ids written to ~/.cells/birth-outcomes/<id>.json
// so the cells CLI can long-poll for them.

const POOL_PATH = join(homedir(), ".cells/pool.json");
const POOL_LOCK_PATH = join(homedir(), ".cells/.pool.lock");
const BIRTH_OUTCOMES_DIR = join(homedir(), ".cells/birth-outcomes");
const V1_POOL_VARIANT_SIGNATURE = "v1-2026-05-13"; // mirror of cli/cells.ts

async function withPoolLockProxy<T>(fn: () => Promise<T>): Promise<T> {
  // Minimal lockfile shim. The full cli/cells.ts version waits + breaks
  // stale locks; the proxy is single-process so contention is rare.
  let attempts = 0;
  while (existsSync(POOL_LOCK_PATH) && attempts++ < 50) {
    await new Promise(r => setTimeout(r, 100));
  }
  await writeFile(POOL_LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }));
  try {
    return await fn();
  } finally {
    try { await import("node:fs/promises").then(m => m.unlink(POOL_LOCK_PATH)); } catch {}
  }
}

async function bridgePoolClaim(body: { cellName: string }): Promise<Response> {
  if (!body.cellName || !/^[a-z0-9-]+$/.test(body.cellName)) {
    return new Response("bad cellName", { status: 400 });
  }
  let chosen: { wellName: string; tier: number; id: string } | null = null;
  await withPoolLockProxy(async () => {
    if (!existsSync(POOL_PATH)) return;
    const file = JSON.parse(await readFile(POOL_PATH, "utf-8"));
    const warm = file.members.find((e: any) =>
      e.state === "warm" && e.variant_signature === V1_POOL_VARIANT_SIGNATURE && (e.tier ?? 2) === 4
    ) ?? file.members.find((e: any) =>
      e.state === "warm" && e.variant_signature === V1_POOL_VARIANT_SIGNATURE
    );
    if (!warm) return;
    warm.state = "claimed";
    warm.claimed_at = new Date().toISOString();
    warm.claimed_by = body.cellName;
    chosen = { wellName: warm.well_name, tier: warm.tier ?? 2, id: warm.well_name.slice("egg-".length) };
    await writeFile(POOL_PATH, JSON.stringify(file, null, 2));
  });
  if (!chosen) return Response.json({ error: "no warm egg available" }, { status: 503 });
  return Response.json(chosen);
}

async function bridgeRegistryRead(): Promise<Response> {
  if (!existsSync(CELLS_REGISTRY)) return Response.json({ cells: [] });
  return Response.json(JSON.parse(await readFile(CELLS_REGISTRY, "utf-8")));
}

async function bridgeRegistryWrite(body: { cells: any[] }): Promise<Response> {
  if (!body || !Array.isArray(body.cells)) {
    return new Response("bad body: {cells: []}", { status: 400 });
  }
  await mkdir(dirname(CELLS_REGISTRY), { recursive: true });
  await writeFile(CELLS_REGISTRY, JSON.stringify(body, null, 2));
  return new Response(null, { status: 204 });
}

async function bridgeWellSsh(body: { wellName: string; script: string }): Promise<Response> {
  if (!body.wellName || !/^[a-z0-9-]+$/.test(body.wellName)) {
    return new Response("bad wellName", { status: 400 });
  }
  if (typeof body.script !== "string" || body.script.length === 0) {
    return new Response("bad script", { status: 400 });
  }
  const proc = Bun.spawn(["well", "exec", "-s", body.wellName, "--", "bash", "-c", body.script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return Response.json({ ok: exit === 0, exit, stdout, stderr });
}

async function bridgePoolSweep(body: { wellName: string }): Promise<Response> {
  if (!body.wellName || !/^[a-z0-9-]+$/.test(body.wellName)) {
    return new Response("bad wellName", { status: 400 });
  }
  // Destroy + drop from pool. Refill is a fire-and-forget; we don't wait.
  Bun.spawn(["well", "destroy", body.wellName, "--force"], { stdio: ["ignore", "ignore", "ignore"] });
  await withPoolLockProxy(async () => {
    if (!existsSync(POOL_PATH)) return;
    const file = JSON.parse(await readFile(POOL_PATH, "utf-8"));
    file.members = file.members.filter((e: any) => e.well_name !== body.wellName);
    await writeFile(POOL_PATH, JSON.stringify(file, null, 2));
  });
  Bun.spawn(["bun", join(REPO_ROOT, "cli/cells.ts"), "pool", "refill"], { stdio: ["ignore", "ignore", "ignore"] });
  return new Response(null, { status: 204 });
}

async function bridgeBirthOutcome(body: { birthId: string; success: boolean; message: string }): Promise<Response> {
  if (!body.birthId || !/^[a-z0-9-]+$/.test(body.birthId)) {
    return new Response("bad birthId", { status: 400 });
  }
  await mkdir(BIRTH_OUTCOMES_DIR, { recursive: true });
  await writeFile(
    join(BIRTH_OUTCOMES_DIR, `${body.birthId}.json`),
    JSON.stringify({ success: !!body.success, message: String(body.message ?? ""), at: new Date().toISOString() }),
  );
  return new Response(null, { status: 204 });
}

async function bridgeTalk(body: { cell: string; message: string }): Promise<Response> {
  if (!body.cell || !/^[a-z0-9-]+$/.test(body.cell)) {
    return new Response("bad cell", { status: 400 });
  }
  if (typeof body.message !== "string") return new Response("bad message", { status: 400 });
  Bun.spawn(["bun", join(REPO_ROOT, "cli/cells.ts"), "talk", body.cell, body.message], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return new Response(null, { status: 204 });
}

async function bridgeInboxPulse(body: { cell: string; content: string }): Promise<Response> {
  if (!body.cell || !/^[a-z0-9-]+$/.test(body.cell)) return new Response("bad cell", { status: 400 });
  if (typeof body.content !== "string") return new Response("bad content", { status: 400 });
  // The active pulse — pi `pulse` by default, `pulse-cc` (claude-code)
  // when CELLS_PULSE_CELL says so. Resolved to a well name per call.
  const pulseWell = await wellNameForCell(process.env.CELLS_PULSE_CELL ?? "pulse");
  const script = `set -euo pipefail
sudo mkdir -p /var/cells/pulse/pulse-inbox
TS=$(date +%s%N)
F=/var/cells/pulse/pulse-inbox/${body.cell}-$TS.md
sudo tee "$F" >/dev/null <<'__INBOX_EOF__'
${body.content}
__INBOX_EOF__
echo "$F"`;
  const proc = Bun.spawn(["well", "exec", "-s", pulseWell, "--", "bash", "-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = await proc.exited;
  if (exit !== 0) return new Response("inbox write failed", { status: 502 });
  return new Response(null, { status: 204 });
}

// ──────────────────────── mother.cells.md activity ────────────────────────
//
// Mother's public face. Reads ~/.cells/birth-log/*.json (written by the
// cells CLI's talkAndAwaitOutcome) and renders a minimalist table: each
// birth, duration, success/failure, the message on issue. Style matches
// the proxy.cells.md dashboard.

const BIRTH_LOG_DIR_PROXY = join(homedir(), ".cells/birth-log");
const DEATH_LOG_DIR_PROXY = join(homedir(), ".cells/death-log");

type BirthLogEntry = {
  birthId: string;
  name?: string;
  harness?: string;          // the BIRTHED cell's harness
  model?: string;            // the BIRTHED cell's model
  mother_harness?: string;   // which harness mother used to run the ritual (pi | claude-code)
  started_at?: string;
  ended_at?: string;
  elapsed_ms?: number;
  success?: boolean;
  message?: string;
};

type DeathLogEntry = {
  kind: "death";
  name: string;
  killed_at: string;
  model?: string | null;
  harness?: string | null;
  born_at?: string | null;
  destroyOk?: boolean;
};

type ActivityEntry =
  | (BirthLogEntry & { kind: "birth"; t: string })
  | (DeathLogEntry & { kind: "death"; t: string });

function readBirthLog(limit = 50): BirthLogEntry[] {
  if (!existsSync(BIRTH_LOG_DIR_PROXY)) return [];
  const entries: BirthLogEntry[] = [];
  for (const f of require("node:fs").readdirSync(BIRTH_LOG_DIR_PROXY)) {
    if (!f.endsWith(".json")) continue;
    try {
      const body = readFileSync(join(BIRTH_LOG_DIR_PROXY, f), "utf-8");
      entries.push(JSON.parse(body));
    } catch {/* skip malformed */}
  }
  entries.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  return entries.slice(0, limit);
}

function readDeathLog(limit = 50): DeathLogEntry[] {
  if (!existsSync(DEATH_LOG_DIR_PROXY)) return [];
  const entries: DeathLogEntry[] = [];
  for (const f of require("node:fs").readdirSync(DEATH_LOG_DIR_PROXY)) {
    if (!f.endsWith(".json")) continue;
    try {
      const body = readFileSync(join(DEATH_LOG_DIR_PROXY, f), "utf-8");
      entries.push(JSON.parse(body));
    } catch {/* skip malformed */}
  }
  entries.sort((a, b) => (b.killed_at ?? "").localeCompare(a.killed_at ?? ""));
  return entries.slice(0, limit);
}

// Merge births and deaths into one chronological fleet activity feed.
// Each entry has a unified `kind` + `t` (canonical timestamp) so the
// renderer can format both uniformly.
function readFleetActivity(limit = 50): ActivityEntry[] {
  const births: ActivityEntry[] = readBirthLog(limit).map(b => ({
    ...b, kind: "birth", t: b.started_at ?? "",
  }));
  const deaths: ActivityEntry[] = readDeathLog(limit).map(d => ({
    ...d, kind: "death", t: d.killed_at ?? "",
  }));
  return [...births, ...deaths]
    .sort((a, b) => b.t.localeCompare(a.t))
    .slice(0, limit);
}

function formatElapsed(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r}s`;
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

async function handleMotherProxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "GET" || (url.pathname !== "/" && url.pathname !== "")) {
    return new Response("not found", { status: 404 });
  }
  const activity = readFleetActivity(50);
  const births = activity.filter(e => e.kind === "birth") as Array<BirthLogEntry & { kind: "birth"; t: string }>;
  const deaths = activity.filter(e => e.kind === "death") as Array<DeathLogEntry & { kind: "death"; t: string }>;
  const successCount = births.filter(e => e.success).length;
  const failCount = births.filter(e => e.success === false && e.ended_at).length;
  const inFlight = births.filter(e => !e.ended_at).length;

  const rows = activity.length === 0
    ? `<tr><td colspan="6"><em>no fleet activity recorded yet</em></td></tr>`
    : activity.map(e => {
        if (e.kind === "death") {
          return `<tr>
            <td><code>${escapeHtml(e.name)}</code></td>
            <td><span class="pill" style="background:#8884">killed</span></td>
            <td>—</td>
            <td>${formatBorn(e.killed_at)}</td>
            <td><span style="color:#888;font-size:0.85em">${escapeHtml([e.harness, e.model].filter(Boolean).join(" · "))}</span></td>
            <td><span style="color:#888;font-size:0.85em">—</span></td>
          </tr>`;
        }
        const status = !e.ended_at
          ? `<span class="pill">in flight</span>`
          : e.success
            ? `<span class="pill" style="background:#0a01">born</span>`
            : `<span class="pill" style="background:#a001">FAIL</span>`;
        const when = e.started_at ? formatBorn(e.started_at) : "—";
        const dur = formatElapsed(e.elapsed_ms);
        const meta = [e.harness, e.model].filter(Boolean).join(" · ");
        const motherCell = e.mother_harness ? `by ${e.mother_harness}` : "—";
        const note = e.message && !e.success ? `<br><code>${escapeHtml(e.message)}</code>` : "";
        return `<tr>
          <td><code>${escapeHtml(e.name ?? e.birthId)}</code></td>
          <td>${status}${note}</td>
          <td>${dur}</td>
          <td>${when}</td>
          <td><span style="color:#888;font-size:0.85em">${escapeHtml(meta)}</span></td>
          <td><span style="color:#888;font-size:0.85em">${escapeHtml(motherCell)}</span></td>
        </tr>`;
      }).join("\n");

  const body = `
    <h1>mother</h1>
    <p class="sub">fleet activity · births + kills · last 50</p>
    <p>
      <span class="pill" style="background:#0a01">${successCount} born</span>
      <span class="pill" style="background:#a001">${failCount} failed</span>
      <span class="pill" style="background:#8884">${deaths.length} killed</span>
      ${inFlight > 0 ? `<span class="pill">${inFlight} in flight</span>` : ""}
    </p>
    <table>
      <thead><tr>
        <th>Cell</th><th>Event</th><th>Duration</th><th>When</th><th>Harness · Model</th><th>Born by</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="sub">Data: <code>~/.cells/birth-log/</code> + <code>~/.cells/death-log/</code> on Pete's Mac.</p>
    <div data-private style="margin-top:2em;padding:1em;border:1px dashed #444;border-radius:6px">
      <p class="sub">🔓 You're signed in.</p>
      <p>This block is wrapped in <code>&lt;div data-private&gt;</code> —
         anonymous visitors never see it. Same gating as the per-cell
         <code>&lt;name&gt;.cells.md</code> sites; just served straight
         from the proxy instead of a per-cell Worker.</p>
    </div>
  `;
  return gateProxyHtml(req, htmlPage("mother · cells", body));
}

const MAC_EXEC_LOG = join(homedir(), ".cells/logs/mac_exec.log");

// Mac-side script execution for mother-in-a-well. The ritual uses local
// bash for cell-color.sh, register-site-service.sh, deploy-cell-worker.sh
// (which calls wrangler with CF creds). cwd is locked to the cells repo
// root so relative `scripts/...` paths work as written in the ritual.
// Every invocation is appended to ~/.cells/logs/mac_exec.log — the
// CELLS_PROXY_SECRET bearer is the only access boundary, so an audit log
// is the minimum.
async function bridgeMacExec(body: { script: string; cell?: string }): Promise<Response> {
  if (typeof body.script !== "string" || body.script.length === 0) {
    return new Response("bad script", { status: 400 });
  }
  await mkdir(dirname(MAC_EXEC_LOG), { recursive: true });
  const startTs = new Date().toISOString();
  const cell = body.cell ?? "?";
  const proc = Bun.spawn(["bash", "-c", body.script], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  // One JSON line per invocation; script truncated so the log stays scannable.
  const line = JSON.stringify({
    ts: startTs,
    cell,
    exit,
    script: body.script.slice(0, 400),
    stderr_tail: stderr.slice(-200),
  }) + "\n";
  try { await writeFile(MAC_EXEC_LOG, line, { flag: "a" }); } catch { /* best-effort */ }
  return Response.json({ ok: exit === 0, exit, stdout, stderr });
}

async function handleBridgeProxy(req: Request): Promise<Response> {
  const auth = checkClientAuth(req);
  if (!auth.ok) return new Response(`unauthorized: ${auth.reason}`, { status: 401 });
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/bridge/, "");

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  try {
    switch (path) {
      case "/pool/claim":     return await bridgePoolClaim(body);
      case "/pool/sweep":     return await bridgePoolSweep(body);
      case "/registry/read":  return await bridgeRegistryRead();
      case "/registry/write": return await bridgeRegistryWrite(body);
      case "/well/ssh":       return await bridgeWellSsh(body);
      case "/mac_exec":       return await bridgeMacExec(body);
      case "/birth/outcome":  return await bridgeBirthOutcome(body);
      case "/talk":           return await bridgeTalk(body);
      case "/inbox/pulse":    return await bridgeInboxPulse(body);
      default:                return new Response("bridge: not found", { status: 404 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[bridge] ${path} -> 500: ${msg}`);
    return new Response(`bridge error: ${msg.slice(0, 300)}`, { status: 500 });
  }
}

// ───────────────────── dashboard / cell page data ─────────────────────

type CellInfo = {
  name: string;
  born: string;
};

// 2026-04-30T05:29:45.393Z → 2026-04-30 05:29
function formatBorn(iso?: string): string {
  if (!iso) return "?";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function readCells(): CellInfo[] {
  if (!existsSync(CELLS_REGISTRY)) return [];
  try {
    const r = JSON.parse(readFileSync(CELLS_REGISTRY, "utf-8"));
    return (r.cells ?? []).map((c: { name: string; created_at?: string }) => ({
      name: c.name,
      born: formatBorn(c.created_at),
    }));
  } catch {
    return [];
  }
}

function readActivity(filterName?: string, limit = 20): string[] {
  if (!existsSync(ACTIVITY_PATH)) return [];
  const lines = readFileSync(ACTIVITY_PATH, "utf-8")
    .split("\n")
    .filter((l) => /^\d{4}-/.test(l));
  const filtered = filterName
    ? lines.filter((l) => new RegExp(`\\b${filterName}\\b`).test(l))
    : lines;
  return filtered.slice(-limit).reverse();
}

// ───────────────────── HTML ─────────────────────

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
         max-width: 760px; margin: 3em auto; padding: 0 1.2em; }
  h1 { font-size: 1.6em; margin-bottom: 0.2em; }
  .sub { color: #888; font-size: 0.9em; margin-bottom: 2em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { text-align: left; padding: 0.5em 0.7em; border-bottom: 1px solid #ddd3; }
  th { font-weight: 600; color: #888; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; }
  a { color: inherit; text-decoration: none; border-bottom: 1px solid #8884; }
  a:hover { border-bottom-color: currentColor; }
  code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #8881; padding: 0.1em 0.4em; border-radius: 3px; }
  ul.activity { list-style: none; padding: 0; font-family: ui-monospace, monospace; font-size: 13px; }
  ul.activity li { padding: 0.25em 0; border-bottom: 1px solid #8881; }
  .pill { display: inline-block; padding: 0.1em 0.6em; border-radius: 999px;
          font-size: 0.8em; background: #8882; }
`;

// SVG emoji favicon — 🧬 (DNA). Inline data URL avoids a separate request.
const FAVICON =
  `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A7%AC%3C/text%3E%3C/svg%3E`;

function htmlPage(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="icon" href="${FAVICON}">
<style>${STYLE}</style>
<body>
${body}
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// Format ms-since-epoch as "Nd Hh" (or "Hh Mm" if < 24h, "expired" if past).
function formatExpiry(expiresMs: number): string {
  const remainMs = expiresMs - Date.now();
  if (remainMs <= 0) return "expired";
  const days = Math.floor(remainMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remainMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((remainMs % (60 * 60 * 1000)) / 60000);
  return `${hours}h ${mins}m`;
}

function formatLastRefresh(lr: typeof lastRefresh): string {
  if (!lr) return "<em>\u2014</em>";
  const ago = Math.round((Date.now() - lr.at) / 60000);
  const tag = lr.outcome === "ok" ? "" : ` <span class="pill">${lr.outcome}</span>`;
  return `${ago}m ago${tag}`;
}

async function authRows(): Promise<string> {
  let anthropicRow = `<tr><td>anthropic</td><td><em>\u2014</em></td><td><em>\u2014</em></td></tr>`;
  try {
    const { expiresMs } = await readAccessToken();
    anthropicRow = `<tr><td>anthropic <span class="pill">claude max</span></td><td>${formatExpiry(expiresMs)}</td><td>${formatLastRefresh(lastRefresh)}</td></tr>`;
  } catch {
    /* leave dash row */
  }
  let codexRow = `<tr><td>openai-codex</td><td><em>not configured</em></td><td>\u2014</td></tr>`;
  try {
    const c = await readCodexAuth();
    codexRow = `<tr><td>openai-codex <span class="pill">chatgpt plus</span></td><td>${formatExpiry(c.expiresMs)}</td><td>${formatLastRefresh(lastCodexRefresh)}</td></tr>`;
  } catch {
    /* leave dash row */
  }
  return anthropicRow + "\n" + codexRow;
}

async function dashboardHtml(): Promise<Response> {
  const cells = readCells();
  const rows = cells
    .map((c) => {
      const url = `https://${c.name}.cells.md/`;
      return `<tr>
        <td><a href="${url}"><strong>${c.name}</strong></a></td>
        <td>${c.born}</td>
      </tr>`;
    })
    .join("\n");
  const activity = readActivity(undefined, 10)
    .map((l) => `<li>${l}</li>`)
    .join("\n");
  const auth = await authRows();
  return htmlPage(
    "mother",
    `<h1>cells</h1>
    <p class="sub">Living cells in the fleet. Routed via <code>*.cells.md</code> through the mother.</p>
    <table>
      <thead><tr><th>Cell</th><th>Born</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="2"><em>no cells</em></td></tr>`}</tbody>
    </table>
    <h2>Subscriptions</h2>
    <table>
      <thead><tr><th>Provider</th><th>Expires</th><th>Last refresh</th></tr></thead>
      <tbody>${auth}</tbody>
    </table>
    <h2>Recent activity</h2>
    <ul class="activity">${activity || "<li><em>no activity</em></li>"}</ul>
    <p class="sub">proxy.cells.md \u00b7 <span class="pill">subscriptions proxy + dashboard</span></p>`,
  );
}

// ───────────────────── server ─────────────────────

// Prime the bearer cache so mother's local pi can authenticate from the very
// first request (otherwise her OAuth bearer wouldn't be in the set yet and
// would 401 until the first auth.json refresh).
await refreshValidBearers();

const server = Bun.serve<WellWsData>({
  port: PORT,
  async fetch(req, server) {
    const host = hostOf(req);
    const url = new URL(req.url);

    // proxy.cells.md → Anthropic at /v1/*, codex at /codex/*, health at
    // /_proxy/health, dashboard at /. localhost:PORT serves the same routes
    // for local dev.
    if (
      host.startsWith("proxy.cells.md") ||
      host.startsWith(`localhost:${PORT}`)
    ) {
      if (url.pathname === "/" || url.pathname === "") {
        return await dashboardHtml();
      }
      if (url.pathname === "/peers") {
        return handlePeers(req);
      }
      if (url.pathname.startsWith("/codex/")) {
        return handleCodexProxy(req);
      }
      if (url.pathname.startsWith("/bridge/")) {
        return handleBridgeProxy(req);
      }
      return handleApiProxy(req);
    }

    // pulse.cells.md → pulse's inbox (POST /heartbeat-changed) + status page
    if (host.startsWith("pulse.cells.md")) {
      return handlePulseProxy(req);
    }

    // mother.cells.md → mother's activity page (births, durations, issues).
    // Served by this proxy until cells-mother gets a per-cell Cloudflare
    // Worker; the dashboard reads ~/.cells/birth-log/*.json directly.
    if (host.startsWith("mother.cells.md")) {
      return handleMotherProxy(req);
    }

    // <well>.cells.md (egg-* or cells-*) → welld at 127.0.0.1:7878. The
    // per-cell CF Worker DO hits this for the wss://<wellname>.cells.md/agent
    // bridge; welld
    // already dispatches by Host and bridges to the guest's :8080 (HTTP
    // and WS). We're just a hop so cloudflared's `*.cells.md → :8787`
    // catch-all can reach welld. See the well-host fallthrough block above.
    if (isWellHost(host)) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const ok = server.upgrade<WellWsData>(req, { data: buildWellWsData(req, host) });
        if (ok) return undefined as unknown as Response;
        return new Response("ws upgrade failed", { status: 426 });
      }
      return handleWellHttp(req);
    }

    // slack.cells.md → handled by Cloudflare Worker (cells-front-slack).
    // <cell>.cells.md → handled by per-cell Cloudflare Worker.
    // Neither reaches the subscriptions proxy in v2.

    return new Response("unknown host", { status: 404 });
  },
  websocket: {
    // Downstream (CF Worker DO) is now upgraded. Open the matching upstream
    // WS to welld, then bridge in both directions. Pre-handshake frames
    // from downstream queue until the upstream open event fires.
    open(ws) {
      const data = ws.data;
      let upstream: WebSocket;
      try {
        upstream = new WebSocket(data.upstreamUrl, { headers: data.fwdHeaders } as any);
      } catch (e) {
        console.error(`[well-ws] upstream construct: ${String(e).slice(0, 200)}`);
        try { ws.close(1011, "upstream construct failed"); } catch {}
        return;
      }
      data.upstream = upstream;
      upstream.addEventListener("open", () => {
        data.upstreamReady = true;
        for (const frame of data.queued) {
          try { upstream.send(frame as any); } catch {}
        }
        data.queued.length = 0;
      });
      upstream.addEventListener("message", (ev: MessageEvent) => {
        try { ws.send(ev.data as any); } catch {}
      });
      upstream.addEventListener("close", (ev: CloseEvent) => {
        try { ws.close(ev.code || 1000, ev.reason || ""); } catch {}
      });
      upstream.addEventListener("error", (ev) => {
        console.error(`[well-ws] upstream error: ${String((ev as any)?.message ?? ev).slice(0, 200)}`);
        try { ws.close(1011, "upstream error"); } catch {}
      });
    },
    message(ws, msg) {
      const data = ws.data;
      if (data.upstreamReady && data.upstream && data.upstream.readyState === 1 /* OPEN */) {
        try { data.upstream.send(msg as any); } catch {}
      } else {
        data.queued.push(msg as any);
      }
    },
    close(ws) {
      try { ws.data.upstream?.close(); } catch {}
    },
  },
});

console.log(`subscriptions proxy listening on http://localhost:${server.port}`);
console.log(`  routes:`);
console.log(`    proxy.cells.md/             → dashboard`);
console.log(`    proxy.cells.md/v1/*         → Anthropic proxy (Bearer auth)`);
console.log(`    proxy.cells.md/codex/*      → OpenAI Codex proxy (Bearer auth)`);
console.log(`    proxy.cells.md/_proxy/health`);
console.log(`    proxy.cells.md/bridge/*     → back-channel for in-well cells (Bearer auth)`);
console.log(`    pulse.cells.md/heartbeat-changed → pulse inbox (Bearer auth)`);
console.log(`    egg-*.cells.md/*            → welld (HTTP + WS) at 127.0.0.1:7878`);
console.log(`    (slack.cells.md and <cell>.cells.md handled by Cloudflare Workers)`);
console.log(`  upstreams: ${UPSTREAM}, ${CODEX_UPSTREAM}`);
console.log(`  auth file: ${AUTH_PATH}`);
