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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const MOTHER_ROOT = join(REPO_ROOT, "proto", "mother");

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
  // Other providers (openai, deepseek, ...) may live alongside; we don't touch them.
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

// ───────────────────── proxy (api path) ─────────────────────

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
    return htmlPage(
      "pulse · cells",
      `<h1>pulse</h1>
       <p class="sub">timekeeper · reads HEARTBEAT.md, fires scheduled wake-ups</p>
       <p>This is the inbox endpoint pulse listens to. Cells POST schedule
       changes here; pulse drains them on its next tick. See
       <a href="https://proxy.cells.md/">the proxy</a> for the fleet dashboard.</p>`,
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

    await mkdir(PULSE_INBOX_DIR, { recursive: true });
    const tsMs = Date.now();
    const filename = `${cell}-${tsMs}.md`;
    await writeFile(join(PULSE_INBOX_DIR, filename), content);

    console.log(
      `[${new Date().toISOString()}] pulse ${cell} heartbeat-changed -> ${filename} (${content.length}B)`,
    );
    return new Response(null, { status: 204 });
  }

  return new Response("not found", { status: 404 });
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

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
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
      if (url.pathname.startsWith("/codex/")) {
        return handleCodexProxy(req);
      }
      return handleApiProxy(req);
    }

    // pulse.cells.md → pulse's inbox (POST /heartbeat-changed) + status page
    if (host.startsWith("pulse.cells.md")) {
      return handlePulseProxy(req);
    }

    // slack.cells.md → handled by Cloudflare Worker (cells-front-slack).
    // <cell>.cells.md → handled by per-cell Cloudflare Worker.
    // Neither reaches the subscriptions proxy in v2.

    return new Response("unknown host", { status: 404 });
  },
});

console.log(`subscriptions proxy listening on http://localhost:${server.port}`);
console.log(`  routes:`);
console.log(`    proxy.cells.md/             → dashboard`);
console.log(`    proxy.cells.md/v1/*         → Anthropic proxy (Bearer auth)`);
console.log(`    proxy.cells.md/codex/*      → OpenAI Codex proxy (Bearer auth)`);
console.log(`    proxy.cells.md/_proxy/health`);
console.log(`    pulse.cells.md/heartbeat-changed → pulse inbox (Bearer auth)`);
console.log(`    (slack.cells.md and <cell>.cells.md handled by Cloudflare Workers)`);
console.log(`  upstreams: ${UPSTREAM}, ${CODEX_UPSTREAM}`);
console.log(`  auth file: ${AUTH_PATH}`);
