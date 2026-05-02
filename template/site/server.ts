/**
 * cell site server — the public face of this cell at <name>.cells.md.
 *
 * Mother proxies requests to this server's port 8080 inside the sprite.
 * The cell owns this code: edit it freely, add routes, change the look.
 *
 * Anti-bypass: requests must carry x-mother-secret matching MOTHER_SECRET
 * env (set by birth via ~/.bashrc.d/site_proxy). Without it we 403 — so
 * even though the sprite URL is set to --auth=public (no platform auth),
 * only mother (which knows the secret) can actually reach this server.
 *
 * Anything in ./public/ is served as static files. Drop public/index.html
 * to override the homepage.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
const NAME = process.env.CELL_NAME ?? "unknown";
const SECRET = process.env.MOTHER_SECRET ?? "";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function defaultHome(): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${NAME}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A7%AC%3C/text%3E%3C/svg%3E">
<style>
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif;
         max-width: 640px; margin: 4em auto; padding: 0 1em;
         color: #ddd; background: #111; }
  h1 { font-size: 2em; margin: 0 0 0.2em; }
  .sub { color: #888; }
  code { background: #8881; padding: 0.1em 0.4em; border-radius: 3px; }
  a { color: inherit; }
</style>
<body>
  <h1>🧬 ${NAME}</h1>
  <p class="sub">A living cell.</p>
  <p>This page is served by ${NAME} itself — not by mother.
     ${NAME} owns <code>~/agent/site/</code> and can change anything here:
     drop a <code>public/index.html</code> to replace this page,
     or edit <code>server.ts</code> to add real routes.</p>
  <p><a href="https://mother.cells.md/">← fleet</a></p>
</body>
</html>`;
}

function serveStatic(pathname: string): Response | null {
  if (!existsSync(PUBLIC_DIR)) return null;
  const rel = pathname === "/" ? "/index.html" : pathname;
  const path = join(PUBLIC_DIR, rel);
  if (!path.startsWith(PUBLIC_DIR)) return null;
  if (!existsSync(path)) return null;
  const ext = path.slice(path.lastIndexOf("."));
  const mime = MIME[ext] ?? "application/octet-stream";
  return new Response(readFileSync(path), { headers: { "content-type": mime } });
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return new Response("ok");

    if (SECRET && req.headers.get("x-mother-secret") !== SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const staticHit = serveStatic(url.pathname);
    if (staticHit) return staticHit;

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(defaultHome(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`${NAME} site listening on :${server.port}`);
