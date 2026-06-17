// Subscriptions proxy for the cells fleet — single Bun.serve that handles:
//
//   proxy.cells.md
//     /                   → fleet dashboard (HTML)
//     /v1/*               → Anthropic API proxy (Bearer auth required)
//     /codex/*            → OpenAI Codex (ChatGPT sub) proxy (Bearer auth required)
//     /heartbeat-changed  → cell HEARTBEAT.md change events written to
//                           ~/.cells/pulse-inbox/ (Bearer auth required)
//     /_proxy/health      → JSON health
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
import { isValidCellName } from "./lib/cell-name";
import { pulseOwner } from "./lib/pulse-owner";
import { loadRegistry, loadRegistrySafe, saveRegistry, withRegistryLock, isStaleWarming, type Cell, type Registry } from "./lib/registry";
import { cellRows, type CellRow } from "./lib/status-rows";
import { ensurePreamble, classifyOAuthRoute, anthropicRouteVerdict, gateCacheNeedsReload } from "./lib/proxy-oauth";
import { latestOpusFrom, normalizeAnthropicModel } from "./lib/model-normalizer";
import { firstByteTimeoutStream, requestWantsStream } from "./lib/stream-timeout";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const MOTHER_ROOT = join(REPO_ROOT, "dna", "specials", "mother");

const AUTH_PATH = join(homedir(), ".pi/agent/auth.json");
const SECRETS_PATH = join(homedir(), ".cells/secrets.json");
const PULSE_INBOX_DIR = join(homedir(), ".cells/pulse-inbox");
// The Mac-side "freshest-seen HEARTBEAT.md" mirror, one file per cell. Written
// on every /heartbeat-changed; read by cli/cells.ts when a project-pulse birth
// / death / retag must re-seed a cell's schedule into a different pulse. It is
// the source of truth for that handoff: always current (updated the instant a
// cell posts a change) and readable without waking the cell.
const HEARTBEAT_MIRROR_DIR = join(homedir(), ".cells/heartbeat-mirror");
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

// Streaming-request guards (docs/BACKLOG.md "Proxy zero-token stream hang").
// A streaming LLM request returns headers ~immediately and its first SSE
// frame within seconds; a wedged upstream produces neither and nothing
// detected it (one process sat 23h40m). Both guards apply ONLY to streaming
// requests — a non-streaming request legitimately takes minutes to its first
// byte, so guarding it would cut healthy long completions. Generous defaults
// (60s) so normal thinking-before-first-token never trips them; env-tunable.
const STREAM_HEADERS_TIMEOUT_MS = Number(
  process.env.PROXY_STREAM_HEADERS_TIMEOUT_MS ?? 60_000,
);
const STREAM_FIRST_BYTE_TIMEOUT_MS = Number(
  process.env.PROXY_STREAM_FIRST_BYTE_TIMEOUT_MS ?? 60_000,
);

// Shared upstream-forward tail for both the Anthropic and Codex proxy paths:
// fetch (with a headers timeout for streaming requests), the one 401-refresh
// retry, the access log, and a first-byte-timeout wrapper on the streamed
// body. Both handlers prepared identical tails inline; this unifies them and
// adds the wedge guards in one place.
async function forwardWithStreamGuards(opts: {
  label: string; // "api" | "codex" — access-log + warn prefix
  cell: string;
  method: string;
  pathname: string;
  upstreamUrl: string;
  baseHeaders: Headers;
  bodyBytes: Uint8Array | undefined;
  access: string;
  refreshAndReadFresh: () => Promise<string>; // force-refresh, return fresh token
}): Promise<Response> {
  const { label, cell, method, pathname, upstreamUrl, baseHeaders, bodyBytes, access } = opts;
  const wantStream = requestWantsStream(bodyBytes);

  const callUpstream = async (
    bearer: string,
  ): Promise<{ resp: Response; controller: AbortController }> => {
    const headers = new Headers(baseHeaders);
    headers.set("authorization", `Bearer ${bearer}`);
    const controller = new AbortController();
    // Headers timeout: for a streaming request the upstream returns headers
    // almost immediately; if it never does (the wedge — socket open, no frames
    // ever) abort so fetch() rejects instead of hanging forever. Streaming-only
    // because a non-streaming response's headers arrive only after generation.
    const headersTimer = wantStream
      ? setTimeout(() => controller.abort(), STREAM_HEADERS_TIMEOUT_MS)
      : null;
    try {
      const resp = await fetch(upstreamUrl, {
        method,
        headers,
        body: bodyBytes,
        signal: controller.signal,
      });
      return { resp, controller };
    } finally {
      if (headersTimer) clearTimeout(headersTimer);
    }
  };

  const startedAt = Date.now();
  let chosen: { resp: Response; controller: AbortController };
  try {
    chosen = await callUpstream(access);
  } catch (e) {
    const ms = Date.now() - startedAt;
    console.error(
      `[${new Date().toISOString()}] ${label} ${cell} ${method} ${pathname} -> NO-HEADERS (${ms}ms) ${e instanceof Error ? e.message : String(e)}`,
    );
    return new Response(
      `upstream timeout: no response headers within ${STREAM_HEADERS_TIMEOUT_MS}ms`,
      { status: 504 },
    );
  }

  // Self-heal on 401 at the boundary of an access-token expiry the proactive
  // timer hasn't caught — force a refresh and retry once.
  if (chosen.resp.status === 401) {
    console.warn(`[${label}-proxy] upstream 401 for ${cell} — forcing refresh and retrying once`);
    try {
      const fresh = await opts.refreshAndReadFresh();
      if (fresh !== access) chosen = await callUpstream(fresh);
    } catch (e) {
      console.error(`[${label}-proxy] retry-after-refresh failed: ${e}`);
    }
  }

  const upstream = chosen.resp;
  const elapsed = Date.now() - startedAt;
  console.log(
    `[${new Date().toISOString()}] ${label} ${cell} ${method} ${pathname} -> ${upstream.status} (${elapsed}ms)`,
  );

  let body = upstream.body;
  const isEventStream = (upstream.headers.get("content-type") ?? "").includes(
    "text/event-stream",
  );
  if (wantStream && body && isEventStream) {
    body = firstByteTimeoutStream(body, {
      timeoutMs: STREAM_FIRST_BYTE_TIMEOUT_MS,
      onTimeout: () => {
        console.error(
          `[${new Date().toISOString()}] ${label} ${cell} ${method} ${pathname} -> FIRST-BYTE-TIMEOUT (${STREAM_FIRST_BYTE_TIMEOUT_MS}ms) — aborting upstream`,
        );
        try {
          chosen.controller.abort();
        } catch {
          /* best-effort socket teardown */
        }
      },
    });
  }
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardableHeaders(upstream.headers),
  });
}

// ───────────────────── well-host routing — removed ─────────────────────
//
// Until the bridge-direction flip (2026-05-22) the proxy carried a whole
// well-routing layer: `<well>.cells.md` hostnames (egg-*, cells-*) rode
// the *.cells.md tunnel into here and were forwarded — HTTP and WS — to
// welld at 127.0.0.1:7878, so the per-cell Worker DO could dial the
// bridge in at `wss://<well>.cells.md/agent`.
//
// Post-flip the bridge runs the other way: the well's supervisor dials
// OUT to `wss://<cell>.cells.md/agent` (its own Worker). Nothing dials
// `<well>.cells.md` anymore, so the isWellHost / WELL_HOST_RE /
// handleWellHttp / WS-forwarding code is all gone. A request to a
// `<well>.cells.md` host now falls through to the 404 below.

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
    const reg = await loadRegistrySafe();
    const cells: any[] = Array.isArray(reg?.cells) ? reg.cells : [];
    const peers = cells
      // "warming" = a cell mid-birth or a leaked crash artifact — not a
      // contactable peer; don't advertise it to agent-comms discovery.
      .filter((c) => c?.status !== "killed" && c?.status !== "warming")
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

// Registry lookup for the Max-policy gate (anthropicRouteVerdict), cached so
// the hot path doesn't re-read cells.json per request. 30s staleness is fine
// for the policy decision — but a miss reloads once (see below), because a
// claude-code cell mid-birth registers ("warming") only moments before its
// end-test's first Anthropic call, and a stale-cache 403 there fails the birth.
const REGISTRY_CACHE_TTL_MS = 30_000;
// Floor on miss-triggered reloads: an unknown caller can force at most one
// disk read per this window, while a just-registered cell still surfaces to
// its end-test within ~a second (bake takes far longer, so no race).
const GATE_MISS_RELOAD_FLOOR_MS = 1_000;
let registryCache: { at: number; byName: Map<string, { harness?: string; modelChain?: string[] }> } | null = null;
async function refreshGateCache(): Promise<void> {
  const reg = await loadRegistrySafe();
  registryCache = { at: Date.now(), byName: new Map(reg.cells.map((c) => [c.name, c])) };
}
async function lookupCellForGate(name: string) {
  // Cold cache or TTL staleness (nameFound=true skips the miss branch here).
  if (gateCacheNeedsReload(registryCache?.at ?? null, Date.now(), true, REGISTRY_CACHE_TTL_MS, GATE_MISS_RELOAD_FLOOR_MS)) {
    await refreshGateCache();
  }
  let cell = registryCache!.byName.get(name);
  // Miss → the name may have just been registered (a cell mid-birth running
  // its end-test). Reload once (bounded by the floor) before the gate denies.
  if (gateCacheNeedsReload(registryCache!.at, Date.now(), cell !== undefined, REGISTRY_CACHE_TTL_MS, GATE_MISS_RELOAD_FLOOR_MS)) {
    await refreshGateCache();
    cell = registryCache!.byName.get(name);
  }
  return cell;
}

// ── "opus means latest opus" ────────────────────────────────────────
// Discovered live from GET /v1/models (the Max OAuth token can call it —
// verified 2026-06-11) and cached. Cells never pin an Opus version: any
// opus-family model in a request body is rewritten to this before it goes
// upstream. See cli/lib/model-normalizer.ts for the pure logic.
const OPUS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let latestOpus: string | null = null;
let latestOpusFetchedAt = 0;
let latestOpusFetch: Promise<void> | null = null;

function refreshLatestOpus(access: string): Promise<void> {
  if (latestOpusFetch) return latestOpusFetch;
  latestOpusFetch = (async () => {
    try {
      const res = await fetch(`${UPSTREAM}/v1/models?limit=100`, {
        headers: {
          authorization: `Bearer ${access}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
      if (!res.ok) {
        console.warn(`[opus-latest] /v1/models -> ${res.status}; keeping ${latestOpus ?? "none"}`);
        return;
      }
      const data = (await res.json()) as { data?: { id: string; created_at?: string }[] };
      const picked = latestOpusFrom(data.data ?? []);
      if (picked && picked !== latestOpus) console.log(`[opus-latest] latest opus is ${picked}`);
      if (picked) latestOpus = picked;
      latestOpusFetchedAt = Date.now();
    } catch (e) {
      console.warn(`[opus-latest] models fetch failed: ${e}`);
    } finally {
      latestOpusFetch = null;
    }
  })();
  return latestOpusFetch;
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

  // Max-policy gate: the Anthropic route serves claude-code cells only
  // (see anthropicRouteVerdict in cli/lib/proxy-oauth.ts). Denials are loud
  // on purpose — a pi/hermes cell landing here is misconfigured, and a 403
  // with the policy spelled out beats silently riding the Max sub.
  const verdict = anthropicRouteVerdict(await lookupCellForGate(auth.cell));
  if (!verdict.allowed) {
    console.warn(`[proxy] anthropic route denied for '${auth.cell}': ${verdict.reason}`);
    return new Response(`forbidden: ${verdict.reason}`, { status: 403 });
  }

  let access: string;
  try {
    access = (await readAccessToken()).access;
  } catch (e) {
    return new Response(`proxy: cannot read auth.json: ${e}`, { status: 503 });
  }

  // hermes's OAuth route arrives as /anthropic.com/v1/* — strip the prefix so
  // the upstream path is the normal /v1/* (see cli/lib/proxy-oauth.ts).
  const { isHermesOAuthRoute, upstreamPath } = classifyOAuthRoute(url.pathname);

  const upstreamUrl = UPSTREAM + upstreamPath + url.search;
  const baseHeaders = new Headers(req.headers);
  baseHeaders.delete("host");
  baseHeaders.delete("x-cell-name");
  baseHeaders.delete("authorization");
  // Never forward x-api-key upstream: we ALWAYS authenticate to Anthropic with
  // the real Max OAuth bearer (set below). Stripping it makes "no paid metered
  // key ever reaches api.anthropic.com" a structural guarantee, not just an
  // emergent property of how the cell clients happen to be configured.
  baseHeaders.delete("x-api-key");
  // We may re-serialize the body (preamble injection) and Bun recomputes
  // content-length from the buffer we hand fetch, so a stale client-supplied
  // length must not ride along. Harmless to drop on the pass-through path too.
  baseHeaders.delete("content-length");

  // Buffer the body so we can retry on 401. Anthropic message bodies are
  // small text payloads, so this is fine; streaming responses go back
  // through `upstream.body` unchanged.
  let bodyBytes =
    req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());

  // On the hermes OAuth route only, guarantee the Claude Code preamble is
  // system block[0] (the opus gate). Idempotent: a no-op when hermes already
  // prepended it. pi/claude-code on plain /v1 are never touched here.
  if (isHermesOAuthRoute && upstreamPath.startsWith("/v1/messages") && bodyBytes && bodyBytes.length) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as Record<string, unknown>;
      bodyBytes = new TextEncoder().encode(JSON.stringify(ensurePreamble(parsed)));
    } catch {
      // Not JSON / unparseable — forward unchanged rather than break the call.
    }
  }

  // "opus means latest opus": rewrite any opus-family model ID to the newest
  // Opus before forwarding. Covers /v1/messages and /v1/messages/count_tokens.
  // First request after proxy start awaits the catalog fetch once; afterwards
  // it's a cached lookup refreshed in the background every 6h. The body is
  // already buffered (401-retry), so this adds no buffering cost.
  if (bodyBytes && bodyBytes.length && upstreamPath.startsWith("/v1/messages")) {
    if (!latestOpus) await refreshLatestOpus(access);
    else if (Date.now() - latestOpusFetchedAt > OPUS_CACHE_TTL_MS) void refreshLatestOpus(access);
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as Record<string, unknown>;
      if (typeof parsed.model === "string") {
        const normalized = normalizeAnthropicModel(parsed.model, latestOpus);
        if (normalized !== parsed.model) {
          console.log(`[opus-latest] ${auth.cell}: ${parsed.model} -> ${normalized}`);
          parsed.model = normalized;
          bodyBytes = new TextEncoder().encode(JSON.stringify(parsed));
        }
      }
    } catch {
      // Not JSON / unparseable — forward unchanged rather than break the call.
    }
  }

  return forwardWithStreamGuards({
    label: "api",
    cell: auth.cell,
    method: req.method,
    pathname: url.pathname,
    upstreamUrl,
    baseHeaders,
    bodyBytes,
    access,
    refreshAndReadFresh: async () => {
      await refreshIfNeeded(true);
      return (await readAccessToken()).access;
    },
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

  // This proxy doesn't speak WebSocket — refuse upgrades honestly so the
  // client's handshake fails clean and it falls back to POST/SSE. Without
  // this, a fetch-forwarded upgrade can surface as a fake 101 whose socket
  // never switches protocols; under idleTimeout:0 that socket stays open
  // and pi-ai's codex provider dies reading garbage frames ("Invalid
  // opcode received") instead of falling back. The fleet's WS attempts
  // only ever "worked" by failing — the old 10s idle timeout closed the
  // fake socket, which pi-ai read as WS-unavailable and fell back to SSE.
  if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
    console.log(`[${new Date().toISOString()}] codex ${auth.cell} WS upgrade refused (SSE only)`);
    return new Response("codex proxy: websocket not supported — use POST (SSE)", { status: 426 });
  }

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

  return forwardWithStreamGuards({
    label: "codex",
    cell: auth.cell,
    method: req.method,
    pathname: url.pathname,
    upstreamUrl,
    baseHeaders,
    bodyBytes,
    access,
    refreshAndReadFresh: async () => {
      await refreshCodexIfNeeded(true);
      return (await readCodexAuth()).access;
    },
  });
}

// ───────────────────── heartbeat inbox ─────────────────────

// proxy.cells.md/heartbeat-changed — the fleet heartbeat inbox. Cells POST
// HEARTBEAT.md change events here; the proxy validates the bearer and writes
// the payload where the pulse scheduler drains it. This lived on
// pulse.cells.md until 2026-05-21, when the pulse cell got a per-cell Worker
// that needed the hostname — moved here so a fleet endpoint isn't squatting
// a cell's hostname.
async function handleHeartbeatChanged(req: Request): Promise<Response> {
  const url = new URL(req.url);

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

    // Persist the freshest HEARTBEAT.md we've seen for this cell, so a future
    // project-pulse birth/death/retag can re-seed its schedule into a different
    // pulse without waking the cell. Best-effort — never fail the push on it.
    try {
      await mkdir(HEARTBEAT_MIRROR_DIR, { recursive: true });
      await writeFile(join(HEARTBEAT_MIRROR_DIR, `${cell}.md`), content);
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] heartbeat-mirror write failed for ${cell}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Two destinations during the Phase 3 transition:
    //   - default: Mac path (~/.cells/pulse-inbox/) — legacy pulse-on-Mac.
    //   - CELLS_USE_PULSE_CELL=1: bridge into the pulse cell's well at
    //     /root/.cells/pulse-inbox/. CELLS_PULSE_CELL names the cell
    //     (default `pulse`).
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
//   POST /bridge/registry/read  — return ~/.cells/cells.json
//   POST /bridge/registry/write — replace ~/.cells/cells.json (full doc)
//   POST /bridge/well/ssh       — exec a script in a well via `well exec`, return {ok, stdout, stderr}
//   POST /bridge/mac_exec       — exec a bash script on the Mac (cwd=cells repo); logged to ~/.cells/logs/mac_exec.log
//   POST /bridge/birth/outcome  — receive {birthId, success, message} from mother
//   POST /bridge/talk           — fire `cells talk <cell> <msg>` (used by cron on the pulse cell)
//   POST /bridge/inbox/pulse    — push a HEARTBEAT.md payload into pulse-cell's well
//
// All routes Bearer-auth via CELLS_PROXY_SECRET. Birth outcomes are
// correlated via short ids written to ~/.cells/birth-outcomes/<id>.json
// so the cells CLI can long-poll for them.

const BIRTH_OUTCOMES_DIR = join(homedir(), ".cells/birth-outcomes");

async function bridgeRegistryRead(): Promise<Response> {
  // Mirror the registry to the host-bridge. loadRegistry gives the same
  // behavior the raw read had (missing → {cells:[]}, malformed → throw →
  // 500) while centralizing the shape in cli/lib/registry.
  return Response.json(await loadRegistry());
}

async function bridgeRegistryWrite(body: { cells: any[] }): Promise<Response> {
  if (!body || !Array.isArray(body.cells)) {
    return new Response("bad body: {cells: []}", { status: 400 });
  }
  // This is a full-document overwrite from mother's registry_write tool
  // (she read-modify-writes the roster across the bridge). Take the registry
  // lock so it serializes with every Mac-side writer (a birth pre-registering
  // /promoting, cells model/kill/project/chain) instead of racing them — and
  // PRESERVE any "warming" entry the incoming body omits. Warming entries are
  // owned by an in-flight Mac-side birth and are transient; a stale mother
  // snapshot dropping one would re-introduce the end-test 403 this hardening
  // exists to prevent. saveRegistry stays atomic (tmp+rename) within the lock.
  await withRegistryLock(async () => {
    const current = await loadRegistrySafe();
    const incoming = new Set(
      body.cells.map((c: any) => c?.name).filter((n: any): n is string => typeof n === "string"),
    );
    // Preserve only FRESH warming entries (an in-flight Mac-side birth). A
    // stale warming orphan (>15min, from a hard-crashed birth) is dropped here
    // rather than re-preserved forever — births are the only other reaper, and
    // they might not run for a while.
    const now = Date.now();
    const preservedWarming = current.cells.filter(
      (c) => c.status === "warming" && !isStaleWarming(c, now) && !incoming.has(c.name),
    );
    await saveRegistry({ cells: [...(body.cells as Cell[]), ...preservedWarming] } as Registry);
  });
  return new Response(null, { status: 204 });
}

async function bridgeWellSsh(body: { wellName: string; script: string }): Promise<Response> {
  if (!body.wellName || !/^[a-z0-9-]+$/.test(body.wellName)) {
    return new Response("bad wellName", { status: 400 });
  }
  if (typeof body.script !== "string" || body.script.length === 0) {
    return new Response("bad script", { status: 400 });
  }
  // Mirror cells.ts wellExecCapture: lift to root with HOME=/root explicitly.
  // mother's well_exec only ever imprints /root (no user param), and the
  // birth smoke tests run a harness — pi/claude/codex/hermes all key off
  // HOME. A plain `well exec` lands as the `well` user unless the substrate
  // default says otherwise; wrapping here keeps mother correct regardless of
  // the wells default (and is what left /home/well/.claude on pre-flip cells).
  const proc = Bun.spawn(
    ["well", "exec", "-s", body.wellName, "--", "sudo", "bash", "-lc", `export HOME=/root; ${body.script}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return Response.json({ ok: exit === 0, exit, stdout, stderr });
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
  // THE partition point: route this cell's heartbeat to the pulse that owns it —
  // its project's pulse if one is registered + alive, else the global pulse.
  // pulseOwner is the SAME pure resolver cli/cells.ts uses for kill/retag/birth
  // handoff, so the Mac never disagrees with itself about who watches a cell;
  // every cell resolves to exactly one owning well (no double-watch, no gap).
  // This load is cold relative to LLM traffic (heartbeat changes are rare), so
  // a fresh read is fine — the gate's 30s cache only holds {harness,modelChain}.
  const reg = await loadRegistrySafe();
  const owner = reg.cells.find((c) => c.name === body.cell);
  const pulseWell = await wellNameForCell(
    pulseOwner(owner?.project, reg.cells, process.env.CELLS_PULSE_CELL ?? "pulse"),
  );
  // base64 the (cell-authored) HEARTBEAT.md so a line equal to a heredoc
  // delimiter can't truncate the write and run trailing lines as root in the
  // pulse well — base64 output is shell-inert. Decoded well-side.
  const b64 = Buffer.from(body.content, "utf-8").toString("base64");
  const script = `set -euo pipefail
sudo mkdir -p /root/.cells/pulse-inbox
TS=$(date +%s%N)
F=/root/.cells/pulse-inbox/${body.cell}-$TS.md
printf %s '${b64}' | base64 -d | sudo tee "$F" >/dev/null
echo "$F"`;
  const proc = Bun.spawn(["well", "exec", "-s", pulseWell, "--", "bash", "-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = await proc.exited;
  if (exit !== 0) return new Response("inbox write failed", { status: 502 });
  return new Response(null, { status: 204 });
}

// ──────────────────────────────── html escape ─────────────────────────────
//
// (The mother.cells.md fleet-activity page that used to live here was
// retired 2026-05-21 when cells-mother got a per-cell Worker and the
// agent-comms bridge. The fleet view now lives in `cells agents` — the
// Ink cockpit — and this proxy's own status page at `/`.)

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
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

// ───────────────────────────── doorbell ───────────────────────────────
//
// proxy.cells.md/wake — wake a sleeping cell's well on demand.
//
// Background: today a sleeping well is woken as a side effect of the cell
// Worker DO dialing the bridge in (`wss://<well>.cells.md/agent` traverses
// the tunnel → proxy → welld, and welld wakes the VM to serve it). After
// the bridge-direction flip the VM dials OUT, so a sleeping cell holds no
// connection and nothing wakes it when a message lands at the Worker.
// This endpoint splits waking off as its own primitive: the Worker rings
// the doorbell, the proxy wakes the well, the VM boots and dials in.
//
// Bearer-gated (same CELLS_PROXY_SECRET as every other proxy route); body
// {cell}. Resolves the well name and runs `well start -s` — the exact path
// `cells wake` / `ensureWellRunningForTalk` use, which handles both
// hibernated (resume from saved RAM) and cold-stopped wells and blocks
// until SSH-accept is ready.
async function handleWake(req: Request): Promise<Response> {
  const auth = checkClientAuth(req);
  if (!auth.ok) return new Response(`unauthorized: ${auth.reason}`, { status: 401 });
  if (req.method !== "POST") return new Response("method", { status: 405 });

  let body: { cell?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const cell = (body.cell ?? "").trim();
  if (!cell || !/^[a-z0-9-]+$/.test(cell)) return new Response("missing or bad cell", { status: 400 });

  const wellName = await wellNameForCell(cell);
  const startedAt = Date.now();
  const proc = Bun.spawn(["well", "start", "-s", wellName], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = await proc.exited;
  const elapsed = Date.now() - startedAt;
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`[wake] ${cell} (${wellName}) failed in ${elapsed}ms: ${stderr.slice(0, 200)}`);
    return new Response(`wake failed: ${stderr.slice(0, 200)}`, { status: 502 });
  }
  console.log(`[${new Date().toISOString()}] wake ${cell} (${wellName}) ok in ${elapsed}ms`);
  return new Response(null, { status: 204 });
}

// ───────────────────── dashboard / cell page data ─────────────────────

async function readCells(): Promise<CellRow[]> {
  // cellRows is tolerant of malformed entries (loadRegistrySafe validates
  // only the envelope, not each cell) — see cli/lib/status-rows.
  return cellRows((await loadRegistrySafe()).cells);
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
  const cells = await readCells();
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
  // Bun's default idleTimeout is 10s — long model responses stream for
  // minutes with quiet gaps (thinking pauses), and the default was cutting
  // them mid-flight ("request timed out after 10 seconds" in cells-proxy.err).
  // 0 = no idle timeout; cloudflared in front has its own connection
  // lifecycle. Mirrors the cell-side supervisor (site/server.ts).
  idleTimeout: 0,
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
      if (url.pathname === "/heartbeat-changed") {
        return handleHeartbeatChanged(req);
      }
      if (url.pathname === "/wake") {
        return handleWake(req);
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

    // slack.cells.md   → Cloudflare Worker (cells-front-slack).
    // <cell>.cells.md  → per-cell Cloudflare Worker.
    // <well>.cells.md  → nothing — the bridge dials <cell>.cells.md now.
    // None of these reach the subscriptions proxy.

    return new Response("unknown host", { status: 404 });
  },
});

console.log(`subscriptions proxy listening on http://localhost:${server.port}`);
console.log(`  routes:`);
console.log(`    proxy.cells.md/             → dashboard`);
console.log(`    proxy.cells.md/v1/*         → Anthropic proxy (Bearer auth)`);
console.log(`    proxy.cells.md/codex/*      → OpenAI Codex proxy (Bearer auth)`);
console.log(`    proxy.cells.md/_proxy/health`);
console.log(`    proxy.cells.md/bridge/*     → back-channel for in-well cells (Bearer auth)`);
console.log(`    proxy.cells.md/heartbeat-changed → pulse heartbeat inbox (Bearer auth)`);
console.log(`    proxy.cells.md/wake         → wake a sleeping cell's well (Bearer auth)`);
console.log(`    (slack.cells.md and <cell>.cells.md handled by Cloudflare Workers)`);
console.log(`  upstreams: ${UPSTREAM}, ${CODEX_UPSTREAM}`);
console.log(`  auth file: ${AUTH_PATH}`);
