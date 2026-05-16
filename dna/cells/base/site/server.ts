/**
 * cell site server (v2) — supervises pi, bridges it to Slack, and
 * publishes the cell's website.
 *
 * Three responsibilities:
 *
 *  1. Site publishing — the cell's website lives in public/. This server
 *     pushes a snapshot of it up to the per-cell Worker (on boot, and
 *     debounced on any change under public/). The Worker serves
 *     <name>.cells.md from that snapshot, so the site stays up even
 *     while the cell sleeps or hibernates — availability is decoupled
 *     from cell liveness. public/ is also served locally at / for
 *     in-cell preview.
 *  2. WebSocket bridge at /agent
 *     - The cell Worker (Cloudflare DO) opens an outbound WS to this
 *       server and holds it open. That inbound TCP keeps the well
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
 * Auth: WS upgrade + site publish both require
 * Authorization: Bearer <CELLS_PROXY_SECRET>.
 */

import { type Subprocess, spawn } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
const NAME = process.env.CELL_NAME ?? "unknown";
const SECRET = process.env.CELLS_PROXY_SECRET ?? "";
const HOME = process.env.HOME ?? "/home/well";

// Wells bridge gateway (from inside the VM). host.well resolves to the host
// 192.168.64.1; welld serves cooperation endpoints on :7879.
const HOST_WELL = process.env.HOST_WELL_URL ?? "http://host.well:7879";

// Stable per-cell session file. We pin pi to this on every spawn so
// conversations survive pi restarts.
const SESSION_DIR = `${HOME}/.pi/agent/sessions/root-${NAME}`;
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
  <!--
    The cells-front Worker strips anything wearing the data-private
    attribute before sending HTML to anonymous visitors, and injects
    a Clerk sign-in widget into every page. Anything inside the block
    below is visible only to signed-in users — single sign-on across
    every cell on .cells.md. This is the editorial convention an
    agent uses to gate the private parts of its site.
  -->
  <div data-private style="margin-top:2em;padding:1em;border:1px dashed #444;border-radius:6px">
    <p class="sub">🔓 You're signed in.</p>
    <p>This block is wrapped in <code>&lt;div data-private&gt;</code> —
       anonymous visitors never see it.</p>
    <p><a href="/private">→ View private content</a></p>
  </div>
</body>
</html>`;
}

// The private companion to defaultHome(). Anonymous visitors hitting
// /private get a near-empty body — every element here is inside a
// [data-private] wrapper, so the Worker's HTMLRewriter strips them all
// at the edge. Signed-in visitors see the full page. This is the
// "private site" the agent (and human) can extend by editing public/
// or writing additional [data-private]-wrapped HTML.
function defaultPrivate(): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${NAME} · private</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%94%92%3C/text%3E%3C/svg%3E">
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
  <div data-private>
    <h1>🔒 ${NAME} · private</h1>
    <p class="sub">A signed-in-only view.</p>
    <p>You're seeing this because you're signed in. To an anonymous
       visitor this page renders as an empty body — every element here
       sits inside <code>&lt;div data-private&gt;</code>, which the
       edge Worker strips before the response leaves Cloudflare.</p>
    <p>The agent edits this page (and the public home) over time —
       wrap any block in <code>&lt;div data-private&gt;</code> and it's
       gated. Treat it like an editorial convention, not a security
       feature: the gating is the bit-stripping, not access control on
       the agent itself.</p>
    <p><a href="/">← back to public home</a></p>
  </div>
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
// Pi setup race: spawnPi() returns immediately, but switch_session +
// set_model + set_thinking_level are delayed via setTimeout(750). If a
// client `prompt` arrives during that window, sendToPi succeeds (pi's
// stdin is open) but pi has no session pinned yet → the prompt is
// processed against the default/transient session and the response is
// effectively lost from the user's perspective. Track readiness; queue
// pre-ready prompts and flush after setup completes.
let piReady = false;
const pendingPrompts: object[] = [];
// Id of the bridge-issued switch_session we're waiting for pi to ack
// before flushing pendingPrompts. null when no ack outstanding.
let awaitingSwitchAck: string | null = null;
const PI_RESPAWN_DELAY_MS = 1000;

// Active WebSocket clients (typically 0 or 1 — the cell Worker DO).
type WsClient = { ws: any /* ServerWebSocket */ };
const wsClients = new Set<WsClient>();

// ---------------------------------------------------------------------------
// Lifecycle signaling.
//
// Two complementary signals to welld's bridge gateway (host.well:7879):
//
//   POST /lifecycle {state:"busy"|"idle"}   informational hint. busy =
//                                            don't try to hibernate me;
//                                            idle = no agent in flight.
//                                            Welld may use this with WS
//                                            bridge state for eligibility.
//
//   POST /sleep                              explicit "release my RAM
//                                            now." Fired after agent_end
//                                            once a short grace window
//                                            elapses with no new turn —
//                                            gives WS clients time to
//                                            drain the final stream.
//
// Fire-and-forget; failures are logged and swallowed so older welld
// builds (or transient bridge hiccups) don't break the cell.
// ---------------------------------------------------------------------------

const SLEEP_GRACE_MS = 1500;

let lastLifecycleState: "busy" | "idle" | null = null;
let pendingSleepTimer: Timer | null = null;

async function signalLifecycle(state: "busy" | "idle") {
  if (lastLifecycleState === state) return;
  lastLifecycleState = state;
  try {
    await fetch(`${HOST_WELL}/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(2000),
    });
  } catch (e) {
    console.error(`[bridge] lifecycle ${state} signal failed: ${String(e).slice(0, 120)}`);
  }
}

async function signalSleep() {
  try {
    await fetch(`${HOST_WELL}/sleep`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
  } catch (e) {
    console.error(`[bridge] sleep signal failed: ${String(e).slice(0, 120)}`);
  }
}

function scheduleSleepAfterGrace() {
  if (pendingSleepTimer) clearTimeout(pendingSleepTimer);
  pendingSleepTimer = setTimeout(() => {
    pendingSleepTimer = null;
    void signalSleep();
  }, SLEEP_GRACE_MS);
}

function cancelPendingSleep() {
  if (pendingSleepTimer) {
    clearTimeout(pendingSleepTimer);
    pendingSleepTimer = null;
  }
}

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

    // Sniff for lifecycle events. Pi emits agent_start at the top of a turn
    // and agent_end after the final stream chunk has flushed.
    //   agent_start → cancel any pending sleep, signal busy
    //   agent_end   → signal idle, schedule explicit sleep after grace
    //   response (command=switch_session, our id) → run setup-acked hook
    try {
      const evt = JSON.parse(trimmed);
      if (evt?.type === "agent_start") {
        cancelPendingSleep();
        void signalLifecycle("busy");
      } else if (evt?.type === "agent_end") {
        void signalLifecycle("idle");
        scheduleSleepAfterGrace();
      } else if (
        evt?.type === "response" &&
        evt?.command === "switch_session" &&
        awaitingSwitchAck !== null &&
        evt?.id === awaitingSwitchAck
      ) {
        console.log(`[bridge] switch_session acked`);
        awaitingSwitchAck = null;
        onPiSetupAcked();
      }
    } catch {
      // not JSON or partial — broadcast already happened, lifecycle skipped
    }
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
    const sink = pi.stdin as any;
    sink.write(JSON.stringify(cmd) + "\n");
    // Force flush — Bun's FileSink buffers writes; without explicit flush,
    // rapid back-to-back writes during setup can accumulate and arrive at
    // pi in a single chunk that pi's RPC dispatcher fails to parse cleanly.
    if (typeof sink.flush === "function") sink.flush();
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
    cwd: "/root",
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
    // If pi died mid-turn welld would otherwise wait forever for agent_end.
    // Force-clear the busy state so the well is hibernate-eligible.
    void signalLifecycle("idle");
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
  //
  // Setup race: pi's rpc dispatcher takes a few hundred ms to come fully
  // online after spawn. We tag switch_session with an id and wait for pi
  // to ACK it via stdout before sending further commands or flushing
  // queued prompts. Prior version used a blind setTimeout which was
  // racy — observed: switch_session/set_model/set_thinking_level landed
  // fine but immediately-flushed prompts were silently dropped (no user
  // entry in pi's session jsonl). Waiting on the ACK is deterministic.
  const SWITCH_ID = `bridge-init-${Date.now()}`;
  awaitingSwitchAck = SWITCH_ID;
  setTimeout(() => {
    if (!sendToPi({ id: SWITCH_ID, type: "switch_session", sessionPath: SESSION_FILE })) {
      console.error(`[bridge] could not send initial switch_session`);
      return;
    }
    console.log(`[bridge] pinned pi to ${SESSION_FILE} (awaiting ack)`);
  }, 250);
}

// Called from onPiStdoutChunk when pi acks switch_session for our bridge-init
// id. Sends set_model + set_thinking_level, flushes queued prompts, signals
// bridge_ready to all ws clients.
function onPiSetupAcked() {
  try {
    const settings = JSON.parse(readFileSync(`${HOME}/.pi/settings.json`, "utf8"));
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
  piReady = true;
  if (pendingPrompts.length > 0) {
    console.log(`[bridge] flushing ${pendingPrompts.length} pending prompt(s)`);
    for (const cmd of pendingPrompts) sendToPi(cmd);
    pendingPrompts.length = 0;
  }
  for (const c of wsClients) {
    try { c.ws.send(JSON.stringify({ type: "bridge_ready" })); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Site publishing — push public/ up to the per-cell Worker.
//
// The Worker (cells-front-<name>) serves <name>.cells.md from a snapshot
// held in its Durable Object. We push that snapshot here: once on boot,
// and debounced on any change under public/. The Worker then serves the
// site whether this cell is awake, asleep, or hibernating. The cell only
// needs to be awake to *change* the site, not to serve it.
// ---------------------------------------------------------------------------

const SITE_PUBLISH_URL = `https://${NAME}.cells.md/site/publish`;
const PUBLISH_DEBOUNCE_MS = 800;
// Per-file ceiling. The Worker's DO storage caps a value at 128 KiB and
// base64 inflates ~33%, so an on-disk file must stay under ~96 KiB. v1 is
// text-first (HTML/CSS/JS/markdown); large media is a later, R2-backed path.
const SITE_FILE_CAP = 96 * 1024;

let publishing = false;
let dirtyDuringPublish = false;
let publishTimer: Timer | null = null;

function collectSiteFiles(dir: string, base: string, out: Record<string, { ct: string; data: string }>) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSiteFiles(full, base, out);
    } else if (st.isFile()) {
      if (st.size > SITE_FILE_CAP) {
        console.error(`[site] skipping ${full} — ${Math.round(st.size / 1024)}KB over ${SITE_FILE_CAP / 1024}KB cap`);
        continue;
      }
      const rel = "/" + full.slice(base.length).replace(/^\/+/, "");
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
      out[rel] = {
        ct: MIME[ext] ?? "application/octet-stream",
        data: readFileSync(full).toString("base64"),
      };
    }
  }
}

// Build the current public/ snapshot and POST it to the Worker. Returns
// true iff the Worker accepted it. Swallows + logs all errors.
async function publishSite(): Promise<boolean> {
  if (publishing) { dirtyDuringPublish = true; return false; }
  publishing = true;
  try {
    if (!SECRET) {
      console.error(`[site] no CELLS_PROXY_SECRET — cannot publish`);
      return false;
    }
    const files: Record<string, { ct: string; data: string }> = {};
    if (existsSync(PUBLIC_DIR)) collectSiteFiles(PUBLIC_DIR, PUBLIC_DIR, files);
    // Nothing in public/ yet — seed /index.html from defaultHome() so
    // <name>.cells.md is live from birth, not a 404. Seed /private.html
    // too so the public/private split has a working demo from day zero.
    if (!files["/index.html"]) {
      files["/index.html"] = {
        ct: "text/html; charset=utf-8",
        data: Buffer.from(defaultHome()).toString("base64"),
      };
    }
    // Publish as /private/index.html so the directory-index fallback in
    // the Worker's DO (serveSite: extensionless path → look up
    // `<path>/index.html`) resolves `/private` cleanly.
    if (!files["/private/index.html"]) {
      files["/private/index.html"] = {
        ct: "text/html; charset=utf-8",
        data: Buffer.from(defaultPrivate()).toString("base64"),
      };
    }
    const res = await fetch(SITE_PUBLISH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ files }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[site] publish failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    const j: any = await res.json().catch(() => ({}));
    const skipped = Array.isArray(j?.skipped) ? j.skipped.length : 0;
    console.log(`[site] published ${Object.keys(files).length} file(s) to ${NAME}.cells.md` +
      (skipped ? ` (${skipped} skipped server-side)` : ""));
    return true;
  } catch (e) {
    console.error(`[site] publish error: ${String(e).slice(0, 200)}`);
    return false;
  } finally {
    publishing = false;
    // A change landed mid-publish — fold it into the next debounced run.
    if (dirtyDuringPublish) {
      dirtyDuringPublish = false;
      schedulePublish();
    }
  }
}

function schedulePublish() {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    void publishSite();
  }, PUBLISH_DEBOUNCE_MS);
}

// Boot: ensure public/ exists (a dir to watch + a place for the agent to
// write), publish the initial snapshot — retrying, since the Worker may
// still be deploying during birth — then re-publish on any change.
function startSitePublishing() {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  void (async () => {
    for (let i = 0; i < 6; i++) {
      if (await publishSite()) break;
      await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  })();
  try {
    watch(PUBLIC_DIR, { recursive: true }, () => schedulePublish());
    console.log(`[site] watching ${PUBLIC_DIR} for changes`);
  } catch (e) {
    console.error(`[site] watch unavailable — site publishes at boot only: ${String(e).slice(0, 160)}`);
  }
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
    if (url.pathname === "/private" || url.pathname === "/private.html") {
      return new Response(defaultPrivate(), {
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
      // Greet so client knows we're alive. If pi is already fully
      // configured (post-warm-cell, late client connect), send
      // bridge_ready immediately so the client doesn't wait.
      try { ws.send(JSON.stringify({ type: "bridge_hello", cell: NAME })); } catch {}
      if (piReady) {
        try { ws.send(JSON.stringify({ type: "bridge_ready" })); } catch {}
      }
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

        // Buffer prompts that arrive before pi is fully configured. The
        // setTimeout(750) in spawnPi() that does switch_session +
        // set_model + set_thinking_level is a race window — if a prompt
        // hits pi.stdin before switch_session, pi processes it against
        // a default/transient session and the user sees nothing back.
        if (!piReady && cmd?.type === "prompt") {
          console.log(`[bridge] queuing prompt (pi not ready yet)`);
          pendingPrompts.push(cmd);
          // Echo a response so client knows the prompt was accepted.
          try {
            ws.send(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }));
          } catch {}
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
startSitePublishing();
