// Mother proxy for the cells fleet — single Bun.serve that handles:
//
//   mother.cells.md
//     /                   → fleet dashboard (HTML)
//
//   keeper.cells.md       (legacy hostname; still the API endpoint cells
//                          have baked into their pi-ai patch)
//     /v1/*               → Anthropic API proxy (Bearer auth required)
//     /_proxy/health      → JSON health
//     /                   → 302 → mother.cells.md
//
//   <cell>.cells.md
//     /                   → per-cell info page (HTML, rendered by mother)
//
// One tunnel, one Bun process. The wildcard CNAME *.cells.md → cells-proxy
// tunnel sends every Host here; we route by Host header.
//
// Auth model:
//   - /v1/* on keeper.cells.md requires Authorization: Bearer <CELLS_PROXY_SECRET>.
//     Pi clients send this via ANTHROPIC_AUTH_TOKEN.
//   - / pages are public reads for now (auth coming later).
//
// Token strategy:
//   - Proxy reads ~/.pi/agent/auth.json on each upstream request.
//   - Mother's own pi keeps that file fresh (refresh token rotates on use,
//     so only ONE entity in the fleet may ever refresh — that's the mother).
//   - Cells never refresh; they have no real OAuth credentials.

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_PATH = join(homedir(), ".pi/agent/auth.json");
const SECRETS_PATH = join(homedir(), ".cell/secrets.json");
const CELLS_REGISTRY = join(homedir(), ".cell/cells.json");
const ROSTER_PATH = join(homedir(), "Projects/cell/memory/project_cells_roster.md");
const ACTIVITY_PATH = join(homedir(), "Projects/cell/memory/project_cells_activity.md");
const UPSTREAM = "https://api.anthropic.com";
const PORT = Number(process.env.CELLS_PROXY_PORT ?? 8787);

function readSecret(): string {
  if (process.env.CELLS_PROXY_SECRET) return process.env.CELLS_PROXY_SECRET;
  if (existsSync(SECRETS_PATH)) {
    const s = JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
    if (s.CELLS_PROXY_SECRET) return s.CELLS_PROXY_SECRET;
  }
  console.error("CELLS_PROXY_SECRET not set (env or ~/.cell/secrets.json)");
  process.exit(1);
}
const SHARED_SECRET = readSecret();

type AuthJson = {
  anthropic: { type: "oauth"; refresh: string; access: string; expires: number };
};

async function readAccessToken(): Promise<{ access: string; expiresMs: number }> {
  const raw = await readFile(AUTH_PATH, "utf-8");
  const parsed = JSON.parse(raw) as AuthJson;
  return { access: parsed.anthropic.access, expiresMs: parsed.anthropic.expires };
}

// ───────────────────── routing ─────────────────────

function hostOf(req: Request): string {
  const url = new URL(req.url);
  return (req.headers.get("host") ?? url.host).toLowerCase();
}

function cellNameFromHost(host: string): string | null {
  // keeper.cells.md → null (legacy API host, handled separately)
  // mother.cells.md → null (dashboard host, handled separately)
  // pete.cells.md   → "pete"
  // localhost:8787  → null (dev/health checks)
  const m = host.match(/^([a-z0-9-]+)\.cells\.md$/);
  if (!m) return null;
  if (m[1] === "keeper" || m[1] === "mother") return null;
  return m[1];
}

// ───────────────────── proxy (api path) ─────────────────────

function checkClientAuth(req: Request): { ok: true; cell: string } | { ok: false; reason: string } {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, reason: "missing Bearer auth" };
  if (m[1] !== SHARED_SECRET) return { ok: false, reason: "bad bearer" };
  const cell = req.headers.get("x-cell-name") ?? "unknown";
  return { ok: true, cell };
}

async function handleApiProxy(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/_proxy/health") {
    try {
      const { access, expiresMs } = await readAccessToken();
      return Response.json({
        ok: true,
        access_prefix: access.slice(0, 20),
        expires_in_min: Math.round((expiresMs - Date.now()) / 60000),
      });
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
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("x-cell-name");
  headers.delete("authorization");
  headers.set("authorization", `Bearer ${access}`);
  if (!headers.get("anthropic-beta")?.includes("oauth-2025-04-20")) {
    const existing = headers.get("anthropic-beta");
    headers.set("anthropic-beta", existing ? `${existing}, oauth-2025-04-20` : "oauth-2025-04-20");
  }

  const startedAt = Date.now();
  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    // @ts-expect-error Bun-specific
    duplex: "half",
  });
  const elapsed = Date.now() - startedAt;
  console.log(
    `[${new Date().toISOString()}] api ${auth.cell} ${req.method} ${url.pathname} -> ${upstream.status} (${elapsed}ms)`,
  );
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

// ───────────────────── dashboard / cell page data ─────────────────────

type CellInfo = {
  name: string;
  born?: string;
  notes?: string;
  registry?: { spriteUrl?: string };
};

function readRoster(): CellInfo[] {
  if (!existsSync(ROSTER_PATH)) return [];
  const text = readFileSync(ROSTER_PATH, "utf-8");
  const out: CellInfo[] = [];
  for (const line of text.split("\n")) {
    // | pete   | 2026-04-30 05:29  | clean birth |
    const m = line.match(/^\|\s*([a-z0-9-]+)\s*\|\s*([0-9-: ]+?)\s*\|\s*(.*?)\s*\|$/i);
    if (!m) continue;
    if (m[1].toLowerCase() === "cell") continue; // header row
    out.push({ name: m[1], born: m[2], notes: m[3] });
  }
  return out;
}

function readRegistry(): Record<string, any> {
  if (!existsSync(CELLS_REGISTRY)) return {};
  try {
    const r = JSON.parse(readFileSync(CELLS_REGISTRY, "utf-8"));
    const map: Record<string, any> = {};
    for (const c of r.cells ?? []) map[c.name] = c;
    return map;
  } catch {
    return {};
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

function htmlPage(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
<body>
${body}
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function dashboardHtml(): Response {
  const cells = readRoster();
  const registry = readRegistry();
  const rows = cells
    .map((c) => {
      const reg = registry[c.name] ?? {};
      const url = `https://${c.name}.cells.md/`;
      return `<tr>
        <td><a href="${url}"><strong>${c.name}</strong></a></td>
        <td>${c.born ?? ""}</td>
        <td>${c.notes ?? ""}</td>
        <td>${reg.spriteUrl ? `<a href="${reg.spriteUrl}"><code>sprite</code></a>` : ""}</td>
      </tr>`;
    })
    .join("\n");
  const activity = readActivity(undefined, 10)
    .map((l) => `<li>${l}</li>`)
    .join("\n");
  return htmlPage(
    "cells",
    `<h1>cells</h1>
    <p class="sub">Living cells in the fleet. Routed via <code>*.cells.md</code> through the mother.</p>
    <table>
      <thead><tr><th>Cell</th><th>Born</th><th>Notes</th><th>Sprite</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4"><em>no cells</em></td></tr>`}</tbody>
    </table>
    <h2>Recent activity</h2>
    <ul class="activity">${activity || "<li><em>no activity</em></li>"}</ul>
    <p class="sub">mother.cells.md \u00b7 <span class="pill">proxy + dashboard</span></p>`,
  );
}

function cellPageHtml(name: string): Response {
  const cells = readRoster();
  const cell = cells.find((c) => c.name === name);
  if (!cell) {
    return htmlPage(
      `${name} \u2014 unknown`,
      `<h1>${name}</h1>
      <p class="sub">No cell by that name in the roster.</p>
      <p><a href="https://mother.cells.md/">\u2190 fleet</a></p>`,
    );
  }
  const registry = readRegistry();
  const reg = registry[name] ?? {};
  const activity = readActivity(name, 30).map((l) => `<li>${l}</li>`).join("\n");
  return htmlPage(
    `${name} \u00b7 cells`,
    `<h1>${name}</h1>
    <p class="sub">Born ${cell.born ?? "?"} \u00b7 ${cell.notes ?? ""}</p>
    <table>
      <tr><th>Sprite URL</th><td>${reg.spriteUrl ? `<a href="${reg.spriteUrl}"><code>${reg.spriteUrl}</code></a>` : "<em>unknown</em>"}</td></tr>
      <tr><th>Born</th><td>${cell.born ?? ""}</td></tr>
      <tr><th>Notes</th><td>${cell.notes ?? ""}</td></tr>
    </table>
    <h2>Activity</h2>
    <ul class="activity">${activity || "<li><em>no entries</em></li>"}</ul>
    <p><a href="https://mother.cells.md/">\u2190 fleet</a></p>`,
  );
}

// ───────────────────── server ─────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const host = hostOf(req);
    const url = new URL(req.url);

    // mother.cells.md → dashboard (canonical home for the roster).
    if (host.startsWith("mother.cells.md")) {
      if (url.pathname === "/" || url.pathname === "") {
        return dashboardHtml();
      }
      return new Response("not found", { status: 404 });
    }

    // keeper.cells.md → legacy hostname. Still the API endpoint (cells have
    // it baked into their pi-ai patch + shared secret). Dashboard requests
    // redirect to the new home.
    if (host.startsWith("keeper.cells.md") || host.startsWith(`localhost:${PORT}`)) {
      if (url.pathname === "/" || url.pathname === "") {
        if (host.startsWith("keeper.cells.md")) {
          return Response.redirect("https://mother.cells.md/", 302);
        }
        return dashboardHtml();
      }
      // API + health + everything else routes to proxy
      return handleApiProxy(req);
    }

    // <cell>.cells.md
    const cell = cellNameFromHost(host);
    if (cell) {
      if (url.pathname === "/" || url.pathname === "") {
        return cellPageHtml(cell);
      }
      return new Response("not found", { status: 404 });
    }

    return new Response("unknown host", { status: 404 });
  },
});

console.log(`mother listening on http://localhost:${server.port}`);
console.log(`  routes:`);
console.log(`    mother.cells.md/        → dashboard`);
console.log(`    keeper.cells.md/        → 302 → mother.cells.md (legacy)`);
console.log(`    keeper.cells.md/v1/*    → Anthropic proxy (Bearer auth)`);
console.log(`    keeper.cells.md/_proxy/health`);
console.log(`    <cell>.cells.md/        → cell page`);
console.log(`  upstream: ${UPSTREAM}`);
console.log(`  auth file: ${AUTH_PATH}`);
