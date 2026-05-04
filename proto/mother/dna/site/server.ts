/**
 * cell site server (v2) — the public face of this cell at <name>.cells.md
 * AND the Slack ↔ pi bridge.
 *
 * Two responsibilities:
 *
 *  1. Static site at /  (homepage, public/ overrides)
 *  2. WebSocket bridge at /agent
 *     - The cell Worker (Cloudflare DO) opens an outbound WS to this
 *       server and holds it open. That inbound TCP keeps the sprite
 *       warm continuously (per sprites.dev hibernation rules).
 *     - We spawn `pi --mode rpc` as a child process. WS frames going
 *       down become lines on pi's stdin (e.g. {type:"prompt"}). Pi's
 *       stdout JSONL events go up to the WS client unchanged.
 *
 * Pi has no idea Slack exists. It just runs in RPC mode emitting its
 * normal event stream; the cell-Worker DO renders that into Slack
 * messages. No slack_post tool, no skill enforcement, no safety-net
 * session-tail. The bridge is the only delivery path.
 *
 * Auth: WS upgrade requires Authorization: Bearer <CELLS_PROXY_SECRET>.
 */

import { type Subprocess, spawn } from "bun";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
const NAME = process.env.CELL_NAME ?? "unknown";
const SECRET = process.env.CELLS_PROXY_SECRET ?? "";
const HOME = process.env.HOME ?? "/home/sprite";

// Stable per-cell session file. We pin pi to this on every spawn so
// conversations survive pi restarts.
const SESSION_DIR = `${HOME}/.pi/agent/sessions/cell-${NAME}`;
const SESSION_FILE = `${SESSION_DIR}/main.jsonl`;
mkdirSync(SESSION_DIR, { recursive: true });

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
  <p>This page is served by ${NAME} itself — not by mother.</p>
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

// ---------------------------------------------------------------------------
// pi RPC subprocess supervisor
// ---------------------------------------------------------------------------

let pi: Subprocess<"pipe", "pipe", "pipe"> | null = null;
let piStdoutBuffer = "";
let piRespawnTimer: Timer | null = null;
const PI_RESPAWN_DELAY_MS = 1000;

// Active WebSocket clients (typically 0 or 1 — the cell Worker DO).
type WsClient = { ws: any /* ServerWebSocket */ };
const wsClients = new Set<WsClient>();

function broadcastToClients(line: string) {
  for (const c of wsClients) {
    try { c.ws.send(line); } catch (e) { console.error(`[bridge] ws send failed: ${String(e).slice(0, 120)}`); }
  }
}

function onPiStdoutChunk(chunk: string) {
  piStdoutBuffer += chunk;
  const lines = piStdoutBuffer.split("\n");
  piStdoutBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.trim()) continue;
    broadcastToClients(trimmed);
  }
}

async function pumpPiStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      onPiStdoutChunk(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    console.error(`[bridge] pi stdout reader error: ${String(e).slice(0, 200)}`);
  } finally {
    reader.releaseLock();
  }
}

async function pumpPiStderr(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) console.error(`[pi-err] ${line}`);
      }
    }
  } catch (e) {
    console.error(`[bridge] pi stderr reader error: ${String(e).slice(0, 200)}`);
  } finally {
    reader.releaseLock();
  }
}

function sendToPi(cmd: object): boolean {
  if (!pi || pi.stdin == null) return false;
  try {
    (pi.stdin as any).write(JSON.stringify(cmd) + "\n");
    return true;
  } catch (e) {
    console.error(`[bridge] pi stdin write failed: ${String(e).slice(0, 200)}`);
    return false;
  }
}

function spawnPi() {
  if (pi) return;
  console.log(`[bridge] spawning pi --mode rpc`);
  piStdoutBuffer = "";
  pi = spawn(["pi", "--mode", "rpc", "--session-dir", SESSION_DIR], {
    cwd: `${HOME}/agent`,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  void pumpPiStream(pi.stdout!);
  void pumpPiStderr(pi.stderr!);

  void pi.exited.then((code) => {
    console.error(`[bridge] pi exited code=${code}; respawning in ${PI_RESPAWN_DELAY_MS}ms`);
    pi = null;
    piRespawnTimer = setTimeout(() => {
      piRespawnTimer = null;
      spawnPi();
    }, PI_RESPAWN_DELAY_MS);
  });

  // Pin to the stable per-cell session file. switch_session is best-effort —
  // if the file doesn't exist yet, pi creates it; if it does, pi resumes.
  // After switching, re-apply settings.json defaults — the session file may
  // have been created under a different model/thinking level, and pi sticks
  // with whatever is recorded in it unless we override per-session.
  setTimeout(() => {
    if (!sendToPi({ type: "switch_session", sessionPath: SESSION_FILE })) {
      console.error(`[bridge] could not send initial switch_session`);
      return;
    }
    console.log(`[bridge] pinned pi to ${SESSION_FILE}`);

    try {
      const settings = JSON.parse(readFileSync(`${HOME}/agent/.pi/settings.json`, "utf8"));
      if (settings.defaultProvider && settings.defaultModel) {
        sendToPi({ type: "set_model", provider: settings.defaultProvider, modelId: settings.defaultModel });
        console.log(`[bridge] set_model ${settings.defaultProvider}/${settings.defaultModel}`);
      }
      if (settings.defaultThinkingLevel) {
        sendToPi({ type: "set_thinking_level", level: settings.defaultThinkingLevel });
        console.log(`[bridge] set_thinking_level ${settings.defaultThinkingLevel}`);
      }
    } catch (e) {
      console.error(`[bridge] failed to apply settings: ${String(e).slice(0, 200)}`);
    }
  }, 750);
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return new Response("ok");

    // WebSocket bridge endpoint. The cell Worker DO connects here.
    if (url.pathname === "/agent") {
      const auth = req.headers.get("authorization") ?? "";
      if (!SECRET || auth !== `Bearer ${SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const ok = srv.upgrade(req, { data: { kind: "agent" } });
      if (ok) return undefined;
      return new Response("upgrade failed", { status: 500 });
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
  websocket: {
    open(ws) {
      const client: WsClient = { ws };
      (ws as any).__client = client;
      wsClients.add(client);
      console.log(`[bridge] ws client connected (total=${wsClients.size})`);
      // Greet so client knows we're alive.
      try { ws.send(JSON.stringify({ type: "bridge_hello", cell: NAME })); } catch {}
    },
    message(ws, message) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message as Uint8Array);
      for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "").trim();
        if (!line) continue;
        let cmd: any;
        try { cmd = JSON.parse(line); }
        catch (e) { console.error(`[bridge] bad ws json: ${String(e).slice(0, 120)}`); continue; }

        // Bridge-level commands (don't forward to pi)
        if (cmd?.type === "ping") {
          try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
          continue;
        }

        // Forward everything else to pi as-is. The DO speaks pi's RPC dialect.
        if (!sendToPi(cmd)) {
          console.error(`[bridge] pi not running, dropping cmd ${cmd?.type}`);
        }
      }
    },
    close(ws) {
      const client = (ws as any).__client as WsClient | undefined;
      if (client) wsClients.delete(client);
      console.log(`[bridge] ws client disconnected (total=${wsClients.size})`);
    },
  },
});

console.log(`${NAME} site listening on :${server.port}`);
spawnPi();
