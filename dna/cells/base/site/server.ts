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
import { getAdapter, type AdapterHost, type HarnessAdapter } from "../lib/harness-adapters";

const PORT = Number(process.env.PORT ?? 8080);
const NAME = process.env.CELL_NAME ?? "unknown";
const SECRET = process.env.CELLS_PROXY_SECRET ?? "";
const HOME = process.env.HOME ?? "/root";

// Wells bridge gateway (from inside the VM). host.well resolves to the host
// 192.168.64.1; welld serves cooperation endpoints on :7879.
const HOST_WELL = process.env.HOST_WELL_URL ?? "http://host.well:7879";

// Harness baked at birth — pi | claude-code | codex. Read from status.json
// (bake-egg writes it). Defaults to pi for safety.
function readHarness(): string {
  try {
    const j = JSON.parse(readFileSync(`${HOME}/.pi/status.json`, "utf8"));
    return typeof j?.harness === "string" ? j.harness : "pi";
  } catch { return "pi"; }
}
const HARNESS = readHarness();
const ADAPTER: HarnessAdapter = getAdapter(HARNESS);

// Stable per-cell session file (pi). Pin pi to this on every spawn so
// conversations survive pi restarts. claude/codex use their own birth-time
// cached ids (see CLAUDE_MAIN_ID / CODEX_MAIN_THREAD below).
const SESSION_DIR = `${HOME}/.pi/agent/sessions/root-${NAME}`;
const SESSION_FILE = `${SESSION_DIR}/main.jsonl`;
mkdirSync(SESSION_DIR, { recursive: true });

// claude-code / codex resume ids captured at birth (bake-egg.sh). Empty
// string if missing — the harness will start a fresh session on spawn and
// the supervisor logs a warning. Phase B birth always seeds these; existing
// pre-fix cells get a one-time manual warm-up before upgrade.
function readIdCache(path: string): string {
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}
const CLAUDE_MAIN_ID = HARNESS === "claude-code" ? readIdCache("/root/.cell/claude-main-session") : "";
const CODEX_MAIN_THREAD = HARNESS === "codex" ? readIdCache("/root/.cell/codex-main-thread") : "";

// Per-harness reference to the cell's main session, passed to the adapter's
// forkAndAsk. Format is harness-specific (see HarnessAdapter doc).
function getMainRef(): string {
  if (HARNESS === "pi") return SESSION_FILE;
  if (HARNESS === "claude-code") return CLAUDE_MAIN_ID;
  if (HARNESS === "codex") return CODEX_MAIN_THREAD;
  return "";
}

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
// Harness supervisor — adapter-driven (pi, claude-code, codex)
// ---------------------------------------------------------------------------
//
// The supervisor owns process lifecycle (spawn / respawn / per-turn spawn)
// and the cell-side spawn argv. Translation in both directions lives in the
// adapter (dna/cells/base/lib/harness-adapters.ts), so the cell Worker DO
// upstream sees only the pi event vocabulary — the harness flavour is
// invisible to anything past the supervisor.

// Persistent-harness state (pi, claude-code). null for per-turn (codex).
let harnessProc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
let harnessStdoutBuffer = "";
let harnessRespawnTimer: Timer | null = null;
// Race-tolerance: spawnHarness() returns immediately, but pi's setup +
// claude's first system/init take a few hundred ms. A `prompt` arriving in
// that window can land before the harness is steerable. Track readiness;
// queue pre-ready prompts and flush after the adapter flips ready.
let harnessReady = false;
const pendingPrompts: object[] = [];
const HARNESS_RESPAWN_DELAY_MS = 1000;

// Per-turn harness state (codex). turnInFlight gates one process at a time;
// concurrent prompts queue and drain in order.
let turnProc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
let turnInFlight = false;
const pendingTurns: string[] = [];

// AdapterHost shim — adapters read/write codexThreadId / awaitingSwitchAck /
// hermesSessionId here, and call writeLine/log/err/onPiSetupAcked on us.
const hostState: AdapterHost = {
  codexThreadId: HARNESS === "codex" ? (CODEX_MAIN_THREAD || null) : null,
  awaitingSwitchAck: null,
  hermesSessionId: null,
  writeLine: (line) => writeToHarness(line),
  log: (msg) => console.log(`[bridge] ${msg}`),
  err: (msg) => console.error(`[bridge] ${msg}`),
  onPiSetupAcked: () => onHarnessReady(),
};

// ---------------------------------------------------------------------------
// Bridge WebSocket — outbound to the cell Worker.
//
// Post-direction-flip (2026-05-22): the supervisor dials OUT to
// wss://<cell>.cells.md/agent and the cell Worker's Durable Object accepts.
// This reverses the pre-flip arrangement (the DO dialed in to
// <well>.cells.md/agent through the cloudflared tunnel + proxy) and
// collapses the second hostname, the tunnel hop, and the proxy's
// well-routing. A hibernated cell holds no connection; the DO rings a
// doorbell (proxy.cells.md/wake) so welld wakes us, then we dial back in.
// ---------------------------------------------------------------------------

const BRIDGE_URL = `wss://${NAME}.cells.md/agent`;
const BRIDGE_RECONNECT_MIN_MS = 1_000;
const BRIDGE_RECONNECT_MAX_MS = 30_000;
// A dial that never opens also won't surface close/error for a long time —
// an OS TCP connect can stall for minutes, and the first dial after a
// hibernation thaw (before the guest's networking is warm) is exactly when
// it does. Bound it: abort a dial that hasn't opened within this window, so
// the `bridgeConnecting` latch can't wedge every reconnect path forever.
const BRIDGE_CONNECT_TIMEOUT_MS = 12_000;
// Heartbeat. The well hibernates and thaws; when it does the bridge WS
// dies, but Bun's WebSocket won't reliably surface a `close` on an idle
// socket — the supervisor would sit on a zombie connection forever. So
// every BRIDGE_PING_MS we ping; the DO auto-answers with a pong via
// setWebSocketAutoResponse (without un-hibernating). We count heartbeats
// that saw no frame come back — BRIDGE_MAX_MISSED in a row means the
// socket is dead, reconnect. A *count* (not a wall-clock delta) so a
// post-thaw clock skew can't mask the staleness.
const BRIDGE_PING_MS = 15_000;
const BRIDGE_MAX_MISSED = 3;
const BRIDGE_PING_FRAME = JSON.stringify({ type: "ping" });

let bridgeWs: WebSocket | null = null;
let bridgeConnecting = false;
let bridgeReconnectMs = BRIDGE_RECONNECT_MIN_MS;
let bridgeReconnectTimer: Timer | null = null;
// Heartbeat liveness: a frame (any frame, pong included) arrived since the
// last tick? Cleared each tick; consecutive misses → zombie.
let bridgeSawFrame = false;
let bridgeMissedPings = 0;

// ---------------------------------------------------------------------------
// Lifecycle signaling.
//
// The cell reports *state* to welld's bridge gateway (host.well:7879) — it
// never commands hibernation:
//
//   POST /lifecycle {state:"busy"|"idle"}   busy = an agent turn is in
//                                            flight; idle = none. welld's
//                                            watchdog is the SOLE decider of
//                                            when an idle cell hibernates —
//                                            it alone weighs this signal
//                                            against the never-sleep pin,
//                                            seal-readiness and activity.
//
// One signal, one decider (hibernation model, invariant 2). The cell used to
// also POST /sleep — an imperative "hibernate me now" — but welld's /sleep
// hibernated unconditionally, bypassing the pin, so a pinned always-on cell
// could hibernate itself. Removed: welld owns the decision; the cell's whole
// hibernation vocabulary is busy/idle.
//
// Fire-and-forget; failures are logged and swallowed so older welld builds
// (or transient hiccups) don't break the cell.
// ---------------------------------------------------------------------------

let lastLifecycleState: "busy" | "idle" | null = null;

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

// Send one pi-shaped event line up the bridge to the cell Worker DO.
// (Kept the "broadcast" name through the direction flip — there is now
// exactly one bridge, so this is a single send when it's up, a no-op
// when it isn't. A dropped frame is acceptable: the well is hibernating
// or reconnecting, and pi's session continuity is preserved on the well.)
function broadcastToClients(line: string) {
  if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
    try { bridgeWs.send(line); }
    catch (e) { console.error(`[bridge] ws send failed: ${String(e).slice(0, 120)}`); }
  }
}

// One translated pi-shaped event line — broadcast to WS clients and sniff
// for agent_end → idle lifecycle. agent_start is pi-only (passthrough); the
// busy signal fires at WS-prompt-receive time for uniform coverage across
// all three harnesses.
function onTranslatedLine(line: string) {
  broadcastToClients(line);
  try {
    const evt = JSON.parse(line);
    if (evt?.type === "agent_end") {
      void signalLifecycle("idle");
    } else if (evt?.type === "agent_start") {
      void signalLifecycle("busy");
    }
  } catch { /* not JSON — already broadcast */ }
}

// One raw harness stdout line → adapter → broadcast each resulting line.
function onHarnessRawLine(line: string) {
  const { lines, ready } = ADAPTER.translateOutbound(hostState, line);
  for (const out of lines) onTranslatedLine(out);
  if (ready && !harnessReady) onHarnessReady();
}

function onHarnessStdoutChunk(chunk: string) {
  harnessStdoutBuffer += chunk;
  const lines = harnessStdoutBuffer.split("\n");
  harnessStdoutBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.trim()) continue;
    onHarnessRawLine(trimmed);
  }
}

async function pumpHarnessStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      onHarnessStdoutChunk(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    console.error(`[bridge] harness stdout reader error: ${String(e).slice(0, 200)}`);
  } finally {
    reader.releaseLock();
  }
}

async function pumpHarnessStderr(stream: ReadableStream<Uint8Array>) {
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
        if (line.trim()) console.error(`[${HARNESS}-err] ${line}`);
      }
    }
  } catch (e) {
    console.error(`[bridge] harness stderr reader error: ${String(e).slice(0, 200)}`);
  } finally {
    reader.releaseLock();
  }
}

// Write one already-serialized line to the persistent harness's stdin.
// Bun's FileSink buffers writes; explicit flush keeps rapid back-to-back
// setup commands from arriving as one chunk pi's RPC dispatcher fumbles.
function writeToHarness(line: string): boolean {
  if (!harnessProc || harnessProc.stdin == null) return false;
  try {
    const sink = harnessProc.stdin as any;
    sink.write(line + "\n");
    if (typeof sink.flush === "function") sink.flush();
    return true;
  } catch (e) {
    console.error(`[bridge] harness stdin write failed: ${String(e).slice(0, 200)}`);
    return false;
  }
}

// Build cell-side spawn argv + env for the persistent harnesses. Returns
// null for codex (per-turn — runTurn() spawns one process per prompt).
function persistentSpawnArgs(): { cmd: string[]; env: Record<string, string> } | null {
  // HOME=/root: harnesses look for config under HOME (.pi/, .claude/, .codex/).
  // PATH: process.env already carries /etc/profile.d/cells-env.sh additions.
  const baseEnv = { ...process.env, HOME: "/root" } as Record<string, string>;
  if (HARNESS === "pi") {
    return {
      cmd: ["pi", "--mode", "rpc", "--session-dir", SESSION_DIR],
      env: baseEnv,
    };
  }
  if (HARNESS === "claude-code") {
    // --print + stream-json in/out keeps claude as a persistent multi-turn
    // process driven over stdin/stdout, the same shape host-bridge gives pi.
    // --resume pins to the birth-time main session id so every cell restart
    // continues the same conversation. IS_SANDBOX=1 satisfies claude's root +
    // bypassPermissions guard (the VM is the isolation boundary).
    const argv = [
      "claude", "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
    ];
    if (CLAUDE_MAIN_ID) {
      argv.push("--resume", CLAUDE_MAIN_ID);
    } else {
      console.error(`[bridge] claude-main-session cache missing — running without --resume; first turn creates a fresh session, conversation won't survive restarts`);
    }
    return {
      cmd: argv,
      env: { ...baseEnv, IS_SANDBOX: "1" },
    };
  }
  if (HARNESS === "hermes") {
    // hermes's TUI-gateway JSON-RPC server — a persistent stdio process, the
    // same one host-bridge spawns over SSH. `-u`: Python stdout to a pipe is
    // fully buffered, and a buffered gateway never flushes its gateway.ready
    // frame, so the handshake would hang. HERMES_PYTHON_SRC_ROOT makes the
    // gateway's in-process imports resolve. The session is opened by the
    // adapter handshake (translateOutbound), not here.
    const H = "/usr/local/lib/hermes-agent";
    return {
      cmd: [`${H}/venv/bin/python`, "-u", "-m", "tui_gateway.entry"],
      env: {
        ...baseEnv,
        TERMINAL_CWD: "/root",
        HERMES_HOME: "/root/.hermes",
        HERMES_PYTHON_SRC_ROOT: H,
        PYTHONUNBUFFERED: "1",
      },
    };
  }
  return null;
}

function spawnHarness() {
  if (harnessProc) return;
  if (ADAPTER.mode === "per-turn") {
    // No persistent process to spawn. Mark ready so prompts flow into runTurn().
    harnessReady = true;
    broadcastToClients(JSON.stringify({ type: "bridge_ready" }));
    if (HARNESS === "codex" && !CODEX_MAIN_THREAD) {
      console.error(`[bridge] codex-main-thread cache missing — first turn creates a fresh thread, conversation won't survive restarts`);
    } else if (HARNESS === "codex") {
      console.log(`[bridge] codex per-turn ready (resuming thread ${CODEX_MAIN_THREAD.slice(0, 8)})`);
    }
    return;
  }
  const args = persistentSpawnArgs();
  if (!args) {
    console.error(`[bridge] no spawn args for harness=${HARNESS}`);
    return;
  }
  console.log(`[bridge] spawning ${HARNESS}`);
  harnessStdoutBuffer = "";
  harnessReady = false;
  harnessProc = spawn(args.cmd, {
    cwd: "/root",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: args.env,
  });

  void pumpHarnessStream(harnessProc.stdout!);
  void pumpHarnessStderr(harnessProc.stderr!);

  void harnessProc.exited.then((code) => {
    console.error(`[bridge] ${HARNESS} exited code=${code}; respawning in ${HARNESS_RESPAWN_DELAY_MS}ms`);
    harnessProc = null;
    // If the harness died mid-turn welld would otherwise wait forever for
    // agent_end. Force-clear busy so the well is hibernate-eligible.
    void signalLifecycle("idle");
    harnessRespawnTimer = setTimeout(() => {
      harnessRespawnTimer = null;
      spawnHarness();
    }, HARNESS_RESPAWN_DELAY_MS);
  });

  // Harness-specific ready handshake (pi sends switch_session; claude-code
  // flips ready immediately — it has no pre-input ready event). ~250ms
  // after spawn so the pipe is live.
  if (ADAPTER.startHandshake) {
    setTimeout(() => ADAPTER.startHandshake!(hostState, SESSION_DIR), 250);
  }
}

// Per-turn-harness driver (codex). One process per prompt; subsequent
// prompts queue and drain in order via the exited handler.
function runTurn(prompt: string) {
  if (turnInFlight) { pendingTurns.push(prompt); return; }
  turnInFlight = true;
  // codex exec [resume <id>] --json --skip-git-repo-check --dangerously-... <prompt>
  const argv = ["codex", "exec"];
  if (hostState.codexThreadId) argv.push("resume", hostState.codexThreadId);
  argv.push("--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt);
  const label = hostState.codexThreadId ? `resume ${hostState.codexThreadId.slice(0, 8)}` : "new thread";
  console.log(`[bridge] spawning codex turn (${label})`);
  turnProc = spawn(argv, {
    cwd: "/root",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: "/root" },
  });
  void pumpHarnessStream(turnProc.stdout!);
  void pumpHarnessStderr(turnProc.stderr!);
  void turnProc.exited.then((code) => {
    console.log(`[bridge] codex turn exited code=${code}`);
    turnProc = null;
    turnInFlight = false;
    // `codex exec` exits 0 even on turn.failed (the failure rides the event
    // stream). Non-zero is an ssh/spawn failure — surface so the client isn't
    // left hanging on a turn that never reported back.
    if (code !== 0) {
      broadcastToClients(JSON.stringify({ type: "response", success: false, error: `codex turn process exited ${code}` }));
    }
    const next = pendingTurns.shift();
    if (next !== undefined) runTurn(next);
  });
}

// Called when the adapter flips ready (pi: switch_session ack; claude-code:
// immediately on spawn; codex: never via this path — runTurn-based). Re-apply
// pi-only settings, flush queued prompts, fire bridge_ready to all clients.
function onHarnessReady() {
  if (HARNESS === "pi") {
    try {
      const settings = JSON.parse(readFileSync(`${HOME}/.pi/settings.json`, "utf8"));
      if (settings.defaultProvider && settings.defaultModel) {
        writeToHarness(JSON.stringify({ type: "set_model", provider: settings.defaultProvider, modelId: settings.defaultModel }));
        console.log(`[bridge] set_model ${settings.defaultProvider}/${settings.defaultModel}`);
      }
      if (settings.defaultThinkingLevel) {
        writeToHarness(JSON.stringify({ type: "set_thinking_level", level: settings.defaultThinkingLevel }));
        console.log(`[bridge] set_thinking_level ${settings.defaultThinkingLevel}`);
      }
    } catch (e) {
      console.error(`[bridge] failed to apply pi settings: ${String(e).slice(0, 200)}`);
    }
  }
  harnessReady = true;
  if (pendingPrompts.length > 0) {
    console.log(`[bridge] flushing ${pendingPrompts.length} pending prompt(s)`);
    for (const cmd of pendingPrompts) {
      if (ADAPTER.mode === "per-turn") {
        if ((cmd as any)?.type === "prompt" && typeof (cmd as any).message === "string") {
          runTurn((cmd as any).message);
        }
      } else {
        const translated = ADAPTER.translateInbound?.(cmd, hostState);
        if (translated !== null && translated !== undefined) writeToHarness(translated);
      }
    }
    pendingPrompts.length = 0;
  }
  broadcastToClients(JSON.stringify({ type: "bridge_ready" }));
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

// Pending --await callers, keyed by corr_id. When the DO forwards an
// agent_reply over the WS, we look up the corr_id here and resolve the
// waiter's response promise — that completes the HTTP long-poll and the
// `cells talk --await` CLI prints the response and exits.
type AwaitWaiter = {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
};
const agentAwaiters = new Map<string, AwaitWaiter>();

const server = Bun.serve({
  port: PORT,
  // /agent-wait is a long-poll that holds the connection until a matching
  // agent_reply arrives (default 120s, capped at 600s). Bun.serve's default
  // idle timeout is 10s — bump it past our hard cap.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return new Response("ok");

    // /agent-wait — long-poll endpoint for `cells talk --await`. The CLI
    // calls this with its corr_id immediately after POSTing the envelope
    // to the peer's inbox. We hold the connection until the matching
    // agent_reply arrives over the bridge WS (forwarded by our DO when
    // the peer's response lands in our inbox), or the timeout expires.
    // No auth — bound to localhost-only callers (inside the cell VM).
    if (url.pathname === "/agent-wait") {
      const corrId = url.searchParams.get("corr_id") ?? "";
      const timeoutS = Math.max(1, Math.min(600, Number(url.searchParams.get("timeout") ?? "120")));
      if (!corrId) return new Response("missing corr_id", { status: 400 });
      const existing = agentAwaiters.get(corrId);
      if (existing) {
        // A second waiter for the same corr_id would race the first; reject.
        return new Response("already awaiting this corr_id", { status: 409 });
      }
      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          agentAwaiters.delete(corrId);
          resolve(new Response("timeout", { status: 408 }));
        }, timeoutS * 1000);
        agentAwaiters.set(corrId, {
          resolve: (text: string) => {
            clearTimeout(timer);
            agentAwaiters.delete(corrId);
            resolve(
              new Response(JSON.stringify({ text }), {
                headers: { "content-type": "application/json" },
              })
            );
          },
          timer,
        });
      });
    }

    // The bridge WebSocket is no longer served here — post-direction-flip
    // the supervisor dials OUT to the cell Worker (see connectBridge
    // below). This server keeps only the local HTTP surface: /health,
    // /agent-wait, and the in-cell static site preview.

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
});

// ---------------------------------------------------------------------------
// Bridge client — dial the cell Worker and pump frames both ways.
// ---------------------------------------------------------------------------

// Handle one inbound bridge frame (already line-split). The vocabulary is
// pi's RPC dialect plus bridge-control (ping) and agent-comms (agent_reply,
// agent_message). Replies go back up via broadcastToClients → bridgeWs.
function handleBridgeFrame(line: string) {
  let cmd: any;
  try { cmd = JSON.parse(line); }
  catch (e) { console.error(`[bridge] bad ws json: ${String(e).slice(0, 120)}`); return; }

  // Bridge-level commands (don't forward to the harness). The DO answers
  // our heartbeat ping via setWebSocketAutoResponse, so a `ping` from the
  // DO is unusual — but honor it anyway. A `pong` is our own heartbeat
  // coming back; lastBridgeRecvAt was already refreshed in the message
  // listener, so just drop it.
  if (cmd?.type === "ping") {
    broadcastToClients(JSON.stringify({ type: "pong" }));
    return;
  }
  if (cmd?.type === "pong") return;

  // agent_reply — forwarded by our DO when an in_reply_to envelope landed
  // in our inbox. Match the corr_id against waiting CLIs that called
  // /agent-wait. If no match, drop silently (timed out or never registered
  // — Pete might have run cells talk --await on the Mac).
  if (cmd?.type === "agent_reply") {
    const corrId = typeof cmd.in_reply_to === "string" ? cmd.in_reply_to : "";
    const text = typeof cmd.text === "string" ? cmd.text : "";
    const waiter = corrId ? agentAwaiters.get(corrId) : undefined;
    if (waiter) {
      waiter.resolve(text);
      console.log(`[bridge] agent_reply matched corr=${corrId.slice(0, 10)} → resolved waiter`);
    } else {
      console.log(`[bridge] agent_reply for unknown corr=${corrId.slice(0, 10)} — no local waiter`);
    }
    return;
  }

  // agent_message — a peer cell (or Pete via the Mac path) is asking us
  // something. Default target="fork": fork main read-only, answer, discard
  // the fork. The adapter owns the fork mechanic per harness (pi: --fork;
  // claude/codex: filename-clone + --resume).
  if (cmd?.type === "agent_message") {
    const corrId = typeof cmd.corr_id === "string" ? cmd.corr_id : "";
    const from = typeof cmd.from === "string" ? cmd.from : "unknown";
    const text = typeof cmd.text === "string" ? cmd.text : "";
    const target = typeof cmd.target === "string" ? cmd.target : "fork";
    console.log(`[bridge] agent_message corr=${corrId.slice(0, 10)} from=${from} target=${target} text=${text.slice(0, 100).replace(/\n/g, " ")}`);
    if (target === "main") {
      // --main escalation: write into the main thread like Slack/email.
      // Phase 4 wires this; for now reject so we don't silently fall through.
      broadcastToClients(JSON.stringify({
        type: "agent_response",
        in_reply_to: corrId,
        text: `[error] target="main" not yet implemented (Phase 4)`,
      }));
      return;
    }
    // Fork path. Wrap in an IIFE so we don't block the frame loop; multiple
    // peers can pipeline (the harness adapter runs the fork to completion).
    const cellName = NAME;
    void (async () => {
      const t0 = Date.now();
      const result = await ADAPTER.forkAndAsk({
        prompt: text,
        mainRef: getMainRef(),
        cellName,
      });
      const dt = Date.now() - t0;
      if (result.ok) {
        console.log(`[bridge] agent_response corr=${corrId.slice(0, 10)} dt=${dt}ms text=${result.text.slice(0, 100).replace(/\n/g, " ")}`);
        broadcastToClients(JSON.stringify({ type: "agent_response", in_reply_to: corrId, text: result.text }));
      } else {
        console.error(`[bridge] forkAndAsk failed corr=${corrId.slice(0, 10)} dt=${dt}ms: ${result.error}`);
        broadcastToClients(JSON.stringify({
          type: "agent_response",
          in_reply_to: corrId,
          text: `[error] ${result.error}`,
        }));
      }
    })();
    return;
  }

  // Signal busy at prompt-receive time — uniform across harnesses. pi also
  // emits agent_start through passthrough (no-op duplicate); claude and
  // codex don't have an analogue, so this is their only busy signal. Also
  // synthesize agent_start for non-pi so the cell Worker DO opens a turn
  // (DO gates message_update accumulation on currentTurn, which is only
  // created by agent_start). Without this, claude/codex text streams in
  // but the DO drops every event silently.
  if (cmd?.type === "prompt") {
    void signalLifecycle("busy");
    if (HARNESS !== "pi") {
      broadcastToClients(JSON.stringify({ type: "agent_start" }));
    }
  }

  // Buffer prompts that arrive before the harness is fully ready (pi setup
  // race; claude's first-output delay). Without this, a prompt can hit a
  // half-configured process and the response is silently lost.
  if (!harnessReady && cmd?.type === "prompt") {
    console.log(`[bridge] queuing prompt (harness not ready yet)`);
    pendingPrompts.push(cmd);
    broadcastToClients(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }));
    return;
  }

  // Per-turn (codex): every prompt spawns a fresh `codex exec`. Pi-only
  // commands (abort, set_model, …) have no per-turn equivalent — drop.
  if (ADAPTER.mode === "per-turn") {
    if (cmd?.type === "prompt" && typeof cmd.message === "string") {
      runTurn(cmd.message);
    }
    return;
  }

  // Persistent: translate inbound to the harness's wire format and write
  // to its stdin. translateInbound returns null for commands the harness
  // can't handle (e.g. abort on claude-code) — drop them.
  const translated = ADAPTER.translateInbound?.(cmd, hostState);
  if (translated === null || translated === undefined) return;
  if (!writeToHarness(translated)) {
    console.error(`[bridge] harness not running, dropping cmd ${cmd?.type}`);
  }
}

function scheduleBridgeReconnect() {
  if (bridgeReconnectTimer) return;
  const delay = bridgeReconnectMs;
  bridgeReconnectTimer = setTimeout(() => {
    bridgeReconnectTimer = null;
    connectBridge();
  }, delay);
  // Exponential backoff, capped. Reset to the floor on a clean connect.
  bridgeReconnectMs = Math.min(bridgeReconnectMs * 2, BRIDGE_RECONNECT_MAX_MS);
}

// Dial the cell Worker's /agent endpoint and hold the connection. On drop
// (well hibernated, Worker redeployed, transient network) reconnect with
// exponential backoff — when the cell is hibernating the dial fails fast
// and the doorbell is what actually brings us back.
function connectBridge() {
  if (bridgeWs || bridgeConnecting) return;
  if (!SECRET) {
    console.error("[bridge] no CELLS_PROXY_SECRET — cannot dial bridge");
    return;
  }
  bridgeConnecting = true;
  let ws: WebSocket;
  try {
    ws = new WebSocket(BRIDGE_URL, { headers: { authorization: `Bearer ${SECRET}` } } as any);
  } catch (e) {
    bridgeConnecting = false;
    console.error(`[bridge] dial failed: ${String(e).slice(0, 160)}`);
    scheduleBridgeReconnect();
    return;
  }
  console.log(`[bridge] dialing ${BRIDGE_URL}`);
  // One dial settles exactly once — via open, close, error, or the connect
  // timeout. `settled` keeps a slow event arriving after a timeout abort
  // (or the reverse) from resurrecting a dead socket or double-reconnecting.
  let settled = false;
  const connectTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    bridgeConnecting = false;
    console.error(`[bridge] dial stalled — no open in ${BRIDGE_CONNECT_TIMEOUT_MS}ms; aborting + retrying`);
    try { ws.close(); } catch {}
    scheduleBridgeReconnect();
  }, BRIDGE_CONNECT_TIMEOUT_MS);
  ws.addEventListener("open", () => {
    if (settled) { try { ws.close(); } catch {} return; }  // timed out — discard
    settled = true;
    clearTimeout(connectTimer);
    bridgeConnecting = false;
    bridgeWs = ws;
    bridgeReconnectMs = BRIDGE_RECONNECT_MIN_MS;
    bridgeSawFrame = true;
    bridgeMissedPings = 0;
    console.log(`[bridge] connected to ${BRIDGE_URL}`);
    // Greet, and if the harness is already ready (warm cell, fast dial)
    // send bridge_ready immediately so the DO doesn't wait.
    try { ws.send(JSON.stringify({ type: "bridge_hello", cell: NAME, harness: HARNESS })); } catch {}
    if (harnessReady) {
      try { ws.send(JSON.stringify({ type: "bridge_ready" })); } catch {}
    }
  });
  ws.addEventListener("message", (ev: any) => {
    bridgeSawFrame = true;
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as Uint8Array);
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      if (line) handleBridgeFrame(line);
    }
  });
  ws.addEventListener("close", () => {
    clearTimeout(connectTimer);
    const wasLive = bridgeWs === ws;
    if (wasLive) bridgeWs = null;
    // The connect timeout already abandoned this dial — don't double-reconnect.
    if (settled && !wasLive) return;
    settled = true;
    bridgeConnecting = false;
    console.log(`[bridge] disconnected from ${BRIDGE_URL}`);
    scheduleBridgeReconnect();
  });
  ws.addEventListener("error", (e: any) => {
    console.error(`[bridge] ws error: ${String((e as any)?.message ?? e).slice(0, 160)}`);
    if (settled) return;  // open succeeded, or already abandoned — `close` covers it
    // error before open with no `close` to follow — settle and retry here.
    settled = true;
    clearTimeout(connectTimer);
    bridgeConnecting = false;
    scheduleBridgeReconnect();
  });
}

// Bridge heartbeat, every BRIDGE_PING_MS:
//   - Bridge up: did a frame arrive since the last tick? Yes → healthy,
//     reset the miss counter. No → another miss. BRIDGE_MAX_MISSED misses
//     in a row means the socket is a zombie (typically a connection that
//     died while the well was hibernated and never surfaced a `close`) —
//     force it closed and reconnect. Then ping, so the next tick has a
//     pong to see.
//   - No bridge and nothing in flight: dial — belt-and-suspenders in case
//     a `close` event was missed entirely.
function bridgeHeartbeat() {
  const ws = bridgeWs;
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (bridgeSawFrame) bridgeMissedPings = 0;
    else bridgeMissedPings++;
    bridgeSawFrame = false;
    if (bridgeMissedPings >= BRIDGE_MAX_MISSED) {
      console.error(`[bridge] ${bridgeMissedPings} heartbeats unanswered — zombie socket, reconnecting`);
      bridgeWs = null;
      bridgeMissedPings = 0;
      try { ws.close(4000, "heartbeat-timeout"); } catch {}
      connectBridge();
      return;
    }
    // Pinging a dead socket also helps: the failed write surfaces the
    // drop and fires `close`, so we don't only depend on the miss count.
    try { ws.send(BRIDGE_PING_FRAME); } catch { /* close event will follow */ }
  } else if (ws) {
    // bridgeWs set but not OPEN — a half-dead socket whose `close` never
    // landed. Drop it and redial; without this branch the heartbeat would
    // neither ping nor reconnect and the bridge would stay wedged.
    console.error(`[bridge] socket stuck at readyState=${ws.readyState} — reconnecting`);
    bridgeWs = null;
    bridgeMissedPings = 0;
    try { ws.close(); } catch {}
    connectBridge();
  } else if (!bridgeConnecting && !bridgeReconnectTimer) {
    connectBridge();
  }
}

console.log(`${NAME} site listening on :${server.port} (harness=${HARNESS})`);
connectBridge();
setInterval(bridgeHeartbeat, BRIDGE_PING_MS);
spawnHarness();
startSitePublishing();
