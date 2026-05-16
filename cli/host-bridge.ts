#!/usr/bin/env bun
/**
 * host-bridge — single host-side daemon that owns all cell pi connections.
 *
 * Replaces the in-cell `well-site.service` bridge for the local-Mac talk
 * path. Talk-CLI connects here (ws://127.0.0.1:7880/agent?cell=<name>),
 * we look up the cell's well IP, SSH in, spawn `pi --mode rpc`, and
 * proxy WS frames ↔ pi's stdin/stdout.
 *
 * Architecture:
 *   cells talk → ws://127.0.0.1:7880/agent?cell=foo (Bearer auth)
 *                  ↓
 *                CellSession (per cell)
 *                  ↓ ssh -i ~/.wells/vms/<well>/ssh_key cell@<ip> pi --mode rpc
 *                  ↓ stdin/stdout/stderr piped
 *                pi process inside the cell VM
 *
 * Sessions are reused across reconnects (30s idle TTL). One pi process per
 * cell name, multiple WS clients can attach for shared streaming.
 */

import { spawn, type Subprocess } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, openSync, writeSync } from "node:fs";
import { getAdapter, type HarnessAdapter, type AdapterHost } from "../dna/cells/base/lib/harness-adapters";

const PORT = Number(process.env.HOST_BRIDGE_PORT ?? 7880);
const WELL_API = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
const LOG_DIR = join(homedir(), ".cells", "logs");
// Default 30min — long enough that "talk again after grabbing coffee" still
// hits a warm session. /prewarm is a no-op when the session is already warm,
// so birth's prewarm fires this timer too if no talk follows.
const IDLE_TTL_MS = Number(process.env.HOST_BRIDGE_IDLE_TTL_MS ?? 30 * 60_000);
const PREWARM_TIMEOUT_MS = Number(process.env.HOST_BRIDGE_PREWARM_TIMEOUT_MS ?? 30_000);

mkdirSync(LOG_DIR, { recursive: true });

// --- bootstrap secrets ----------------------------------------------------

function readSecret(name: string): string | null {
  try {
    const raw = readFileSync(join(homedir(), ".cells", "secrets.json"), "utf8");
    const obj = JSON.parse(raw);
    return typeof obj[name] === "string" ? obj[name] : null;
  } catch {
    return null;
  }
}

function wellsToken(): string {
  try {
    return readFileSync(join(homedir(), ".wells", "token"), "utf8").trim();
  } catch {
    return "";
  }
}

const CELLS_PROXY_SECRET = readSecret("CELLS_PROXY_SECRET");
if (!CELLS_PROXY_SECRET) {
  console.error("CELLS_PROXY_SECRET missing from ~/.cells/secrets.json");
  process.exit(1);
}

// --- cell → well resolution ----------------------------------------------

type CellTarget = {
  cellName: string;
  wellName: string;
  ip: string;
  sshKeyPath: string;
  // Which agent runtime the cell runs. Baked into the registry at birth;
  // defaults to "pi" for pre-harness cells. Phase 3c branches CellSession
  // on this.
  harness: string;
};

async function resolveCellTarget(cellName: string): Promise<CellTarget | null> {
  // cells.json → hatched_from short id; pool.json → well_name. For cells
  // without a hatched_from entry (cold-fork path), the well-name equals
  // the cell-name.
  let wellName = cellName;
  let harness = "pi";
  try {
    const reg = JSON.parse(readFileSync(join(homedir(), ".cells", "cells.json"), "utf8"));
    const cell = reg?.cells?.find((c: any) => c.name === cellName);
    if (typeof cell?.harness === "string") harness = cell.harness;
    // Specials (mother, pulse) live in deterministic wells (cells-<name>) —
    // no hatched_from, so resolve directly.
    if (cell?.special) {
      wellName = `cells-${cellName}`;
    } else if (cell?.hatched_from) {
      // Prefer pool.json; fall back to legacy eggs.json (one-shot until cells.ts migrates).
      let poolRaw: any = null;
      try { poolRaw = JSON.parse(readFileSync(join(homedir(), ".cells", "pool.json"), "utf8")); }
      catch { try { poolRaw = JSON.parse(readFileSync(join(homedir(), ".cells", "eggs.json"), "utf8")); } catch { /* none */ } }
      const entries = poolRaw?.members ?? poolRaw?.eggs ?? [];
      const member = entries.find((e: any) => e.id === cell.hatched_from);
      if (member?.well_name) wellName = member.well_name;
    }
  } catch {
    /* fall through with wellName = cellName */
  }

  // Welld for live IP
  const tok = wellsToken();
  const info = await fetch(`${WELL_API}/v1/wells/${encodeURIComponent(wellName)}`, {
    headers: { Authorization: `Bearer ${tok}` },
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!info?.ip) {
    console.error(`[host-bridge] resolveCellTarget('${cellName}'): no IP for well ${wellName}`);
    return null;
  }

  const sshKeyPath = join(homedir(), ".wells", "vms", wellName, "ssh_key");
  if (!existsSync(sshKeyPath)) {
    console.error(`[host-bridge] missing ssh key at ${sshKeyPath}`);
    return null;
  }

  return { cellName, wellName, ip: info.ip, sshKeyPath, harness };
}

// Read a subprocess stream line-by-line, invoking `onLine` per complete
// line. Used by CellSession.runTurn for the transient per-turn process; the
// persistent path has its own buffered pump (pumpStdout / pumpStderr).
async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
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
      for (const line of lines) onLine(line);
    }
  } catch (e) {
    console.error(`pumpLines error: ${String(e).slice(0, 200)}`);
  } finally {
    reader.releaseLock();
  }
}

// --- per-cell session ----------------------------------------------------

class CellSession {
  cellName: string;
  wellName: string;
  // Agent runtime: "pi" | "claude-code" | "codex". Picks the adapter.
  harness: string;
  // The harness adapter — owns the remote command, the ready handshake, and
  // protocol translation in both directions.
  adapter: HarnessAdapter;
  ssh: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  // The harness process is up and listening on stdin. (Named for pi's
  // history; claude-code uses the same flag.)
  piReady = false;
  // Prompts received before the harness was ready, already translated to
  // the harness's stdin wire format — flushed in order once ready.
  pendingPrompts: string[] = [];
  awaitingSwitchAck: string | null = null;
  stdoutBuffer = "";
  clients = new Set<any>(); // ServerWebSocket
  idleTimer: Timer | null = null;
  exiting = false;
  // Resolvers for whenReady() promises waiting on piReady to flip.
  readyResolvers: Array<(ok: boolean) => void> = [];
  // The resolved cell target — saved at start() so a per-turn harness can
  // spawn turn processes on demand.
  target: CellTarget | null = null;
  // --- per-turn harness state (codex) ---
  // codex's thread id, captured from the first turn's thread.started event;
  // every later turn resumes it, so the conversation persists across spawns.
  codexThreadId: string | null = null;
  // The in-flight per-turn process (one `codex exec`), whether a turn is
  // running, and prompts that arrived mid-turn (drained in order on exit).
  turnProc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  turnInFlight = false;
  pendingTurns: string[] = [];

  constructor(cellName: string, wellName: string, harness = "pi") {
    this.cellName = cellName;
    this.wellName = wellName;
    this.harness = harness;
    this.adapter = getAdapter(harness);
  }

  log(msg: string) {
    console.log(`[${this.cellName}] ${msg}`);
  }
  err(msg: string) {
    console.error(`[${this.cellName}] ${msg}`);
  }

  async start(target: CellTarget): Promise<void> {
    this.target = target;
    // Per-turn harnesses (codex) have no persistent process — each prompt
    // spawns its own `codex exec` (see runTurn). Nothing to spawn here;
    // mark ready so prompts flow straight into runTurn().
    if (this.adapter.mode === "per-turn") {
      this.log(`per-turn harness (${this.harness}) — ready`);
      this.piReady = true;
      for (const r of this.readyResolvers) r(true);
      this.readyResolvers.length = 0;
      this.broadcastJSON({ type: "bridge_ready" });
      return;
    }
    // pi talk uses a clearly-named scratch dir — separate from the main
    // session (root-<name>) that site/server.ts drives for Slack/email.
    // claude-code / codex ignore sessionDir (their resume id comes from a
    // birth-time cache file the adapter reads at the cell — see their
    // buildRemoteCmd / buildTurnCmd in harness-adapters.ts).
    const sessionDir = `/root/.pi/agent/sessions/talk-${this.cellName}`;
    // The remote command is harness-specific (pi --mode rpc vs the claude
    // CLI in stream-json mode) — the adapter builds it. We SSH as `ubuntu`
    // (lume's default; it has the substrate ssh key) and the adapter's
    // command sudo's to `cell` with NOPASSWD, set up at bake time.
    const remoteCmd = this.adapter.buildRemoteCmd!(sessionDir);
    this.log(`spawning ssh+${this.harness} to ubuntu@${target.ip}`);
    this.ssh = spawn(
      [
        "ssh",
        "-i", target.sshKeyPath,
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=15",
        `ubuntu@${target.ip}`,
        // remoteCmd is ssh's single command arg — ssh runs it through the
        // remote login shell itself. Do NOT wrap it in `bash -lc`: ssh
        // re-joins argv with spaces and the remote shell re-parses, so
        // `bash -lc <remoteCmd>` collapses to `bash -lc <first-word>` and
        // silently drops the rest. pi's remoteCmd survived that by luck (a
        // `;` split the statement); claude's `exec sudo …` degraded to a
        // bare no-op `exec` — claude never launched, stdin EOF'd, exit 0.
        remoteCmd,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );

    void this.pumpStdout();
    void this.pumpStderr();
    void this.ssh.exited.then((code) => {
      this.err(`ssh+${this.harness} exited code=${code}`);
      this.ssh = null;
      this.piReady = false;
      // Notify clients so they can decide to disconnect or reconnect.
      this.broadcastJSON({ type: "bridge_closed", reason: `harness-exited-${code}` });
    });

    // Harness-specific ready handshake (pi sends switch_session; claude-code
    // sends nothing — it greets with system/init). ~250ms after spawn so the
    // ssh pipe is live.
    setTimeout(() => this.adapter.startHandshake!(this, sessionDir), 250);
  }

  // Per-turn harness driver (codex). `codex exec` is one-shot, so each
  // prompt spawns its own ssh+codex process; the first turn's thread id is
  // captured (codexAdapter.translateOutbound) and replayed via `resume` on
  // every later turn, so the conversation persists across spawns. Concurrent
  // prompts queue and drain in order — the talk CLI guards client-side too.
  runTurn(prompt: string) {
    if (!this.target) { this.err(`runTurn: no target`); return; }
    if (this.turnInFlight) { this.pendingTurns.push(prompt); return; }
    this.turnInFlight = true;
    const remoteCmd = this.adapter.buildTurnCmd!(this, prompt);
    const label = this.codexThreadId ? `resume ${this.codexThreadId.slice(0, 8)}` : "new thread";
    this.log(`spawning ssh+${this.harness} turn (${label})`);
    const proc = spawn(
      [
        "ssh",
        "-i", this.target.sshKeyPath,
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=15",
        `ubuntu@${this.target.ip}`,
        remoteCmd,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    this.turnProc = proc;
    // Pump this turn's stdout through the adapter (turn-local line buffer).
    void pumpLines(proc.stdout, (line) => {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed.trim()) return;
      const { lines: outLines } = this.adapter.translateOutbound(this, trimmed);
      for (const out of outLines) this.broadcastRaw(out);
    });
    void pumpLines(proc.stderr, (line) => {
      if (line.trim()) console.error(`[${this.cellName}] [codex-err] ${line}`);
    });
    void proc.exited.then((code) => {
      this.log(`ssh+${this.harness} turn exited code=${code}`);
      this.turnProc = null;
      this.turnInFlight = false;
      // `codex exec` exits 0 even on turn.failed (the failure rides the event
      // stream). A non-zero code is an ssh / spawn failure — surface it so
      // the client isn't left hanging on a turn that never reported back.
      if (code !== 0) {
        this.broadcastJSON({ type: "response", success: false, error: `codex turn process exited ${code}` });
      }
      const next = this.pendingTurns.shift();
      if (next !== undefined) this.runTurn(next);
    });
  }

  // Write one already-serialized line to the harness process's stdin.
  writeLine(line: string): boolean {
    if (!this.ssh || !this.ssh.stdin) return false;
    try {
      const sink = this.ssh.stdin as any;
      sink.write(line + "\n");
      if (typeof sink.flush === "function") sink.flush();
      return true;
    } catch (e) {
      this.err(`harness stdin write failed: ${String(e).slice(0, 200)}`);
      return false;
    }
  }

  broadcastRaw(line: string) {
    for (const c of this.clients) {
      try { c.send(line); } catch {}
    }
  }
  broadcastJSON(obj: object) {
    this.broadcastRaw(JSON.stringify(obj));
  }

  onPiSetupAcked() {
    // The cell's model + thinking are baked into its own config by the
    // birthing ritual (.pi/settings.json for pi, .claude/settings.json for
    // claude-code) — the harness loads them on startup, so host-bridge
    // doesn't re-assert them here. Clients can still change model
    // mid-session via a set_model RPC (pi only).
    this.piReady = true;
    for (const r of this.readyResolvers) r(true);
    this.readyResolvers.length = 0;
    if (this.pendingPrompts.length > 0) {
      this.log(`flushing ${this.pendingPrompts.length} pending prompt(s)`);
      for (const line of this.pendingPrompts) this.writeLine(line);
      this.pendingPrompts.length = 0;
    }
    this.broadcastJSON({ type: "bridge_ready" });
  }

  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.piReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.readyResolvers.push((ok) => { clearTimeout(t); resolve(ok); });
    });
  }

  ensureIdleTimer() {
    if (this.exiting) return;
    if (this.idleTimer) return;
    if (this.clients.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.log(`idle TTL elapsed, shutting down ssh+pi`);
      this.shutdown();
    }, IDLE_TTL_MS);
  }

  onStdoutChunk(chunk: string) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed.trim()) continue;
      // The adapter translates one harness stdout line into zero or more
      // pi-shaped WS frames, and flags the harness's "ready" signal.
      const { lines: outLines, ready } = this.adapter.translateOutbound(this, trimmed);
      for (const out of outLines) this.broadcastRaw(out);
      if (ready && !this.piReady) this.onPiSetupAcked();
    }
  }

  async pumpStdout() {
    if (!this.ssh?.stdout) return;
    const reader = this.ssh.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        this.onStdoutChunk(decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      this.err(`stdout reader error: ${String(e).slice(0, 200)}`);
    } finally {
      reader.releaseLock();
    }
  }
  async pumpStderr() {
    if (!this.ssh?.stderr) return;
    const reader = this.ssh.stderr.getReader();
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
          if (line.trim()) console.error(`[${this.cellName}] [pi-err] ${line}`);
        }
      }
    } catch (e) {
      this.err(`stderr reader error: ${String(e).slice(0, 200)}`);
    } finally {
      reader.releaseLock();
    }
  }

  addClient(ws: any) {
    this.clients.add(ws);
    this.log(`ws client connected (total=${this.clients.size})`);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Greet
    try { ws.send(JSON.stringify({ type: "bridge_hello", cell: this.cellName })); } catch {}
    if (this.piReady) {
      try { ws.send(JSON.stringify({ type: "bridge_ready" })); } catch {}
    }
  }

  removeClient(ws: any) {
    this.clients.delete(ws);
    this.log(`ws client disconnected (total=${this.clients.size})`);
    this.ensureIdleTimer();
  }

  handleClientMessage(ws: any, text: string) {
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      if (!line) continue;
      let cmd: any;
      try { cmd = JSON.parse(line); }
      catch (e) {
        this.err(`bad ws json: ${String(e).slice(0, 120)}`);
        continue;
      }
      // ping is a host-bridge concern, not the harness's — answer directly.
      if (cmd?.type === "ping") {
        try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
        continue;
      }
      // Per-turn harnesses (codex): a prompt spawns a fresh turn process —
      // there's no persistent stdin to translate onto. abort/set_model and
      // other pi-only commands have no per-turn equivalent — drop them.
      if (this.adapter.mode === "per-turn") {
        if (cmd?.type === "prompt" && typeof cmd.message === "string") {
          this.runTurn(cmd.message);
        }
        continue;
      }
      // The adapter translates the pi-RPC-shaped client command into the
      // harness's stdin wire format (identity for pi). null = no harness
      // equivalent (e.g. `abort` on claude-code) — drop it.
      const translated = this.adapter.translateInbound!(cmd);
      if (translated === null) continue;
      if (!this.piReady && cmd?.type === "prompt") {
        this.log(`queuing prompt (harness not ready yet)`);
        this.pendingPrompts.push(translated);
        try {
          ws.send(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }));
        } catch {}
        continue;
      }
      if (!this.writeLine(translated)) {
        this.err(`harness not running, dropping cmd ${cmd?.type}`);
      }
    }
  }

  shutdown() {
    this.exiting = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const r of this.readyResolvers) r(false);
    this.readyResolvers.length = 0;
    if (this.ssh) {
      try { this.ssh.kill(); } catch {}
      this.ssh = null;
    }
    if (this.turnProc) {
      try { this.turnProc.kill(); } catch {}
      this.turnProc = null;
    }
    sessions.delete(this.cellName);
  }
}

const sessions = new Map<string, CellSession>();

async function getOrCreateSession(cellName: string): Promise<CellSession | null> {
  const existing = sessions.get(cellName);
  if (existing && existing.ssh) return existing;
  const target = await resolveCellTarget(cellName);
  if (!target) return null;
  const sess = new CellSession(cellName, target.wellName, target.harness);
  sessions.set(cellName, sess);
  await sess.start(target);
  return sess;
}

// --- HTTP + WS server ----------------------------------------------------

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        port: PORT,
        sessions: [...sessions.keys()],
      });
    }

    if (url.pathname === "/prewarm") {
      if (req.method !== "POST") return new Response("method", { status: 405 });
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${CELLS_PROXY_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const cellName = url.searchParams.get("cell");
      if (!cellName) return new Response("missing ?cell=", { status: 400 });
      const sess = await getOrCreateSession(cellName);
      if (!sess) return new Response(`cell '${cellName}' not found or unreachable`, { status: 404 });
      // Returns true if piReady flips within PREWARM_TIMEOUT_MS; false on timeout
      // or session shutdown. piReady can already be true (no-op fast path).
      const ready = await sess.whenReady(PREWARM_TIMEOUT_MS);
      if (!ready) return new Response("pi not ready in time", { status: 504 });
      // Prewarm leaves no ws client behind, so kick off the idle timer ourselves
      // — otherwise the session would sit warm forever even with nobody talking.
      sess.ensureIdleTimer();
      return Response.json({ ready: true, cell: cellName });
    }

    if (url.pathname === "/agent") {
      // Auth
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${CELLS_PROXY_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      // Cell name
      const cellName = url.searchParams.get("cell");
      if (!cellName) return new Response("missing ?cell=", { status: 400 });

      // Get/create session before upgrade so we can fail-fast if cell unknown
      const sess = await getOrCreateSession(cellName);
      if (!sess) return new Response(`cell '${cellName}' not found or unreachable`, { status: 404 });

      const ok = srv.upgrade(req, { data: { cellName } });
      if (ok) return undefined;
      return new Response("upgrade failed", { status: 500 });
    }

    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const { cellName } = ws.data as { cellName: string };
      const sess = sessions.get(cellName);
      if (!sess) {
        try { ws.close(1011, "no session"); } catch {}
        return;
      }
      sess.addClient(ws);
    },
    message(ws, message) {
      const { cellName } = ws.data as { cellName: string };
      const sess = sessions.get(cellName);
      if (!sess) return;
      const text = typeof message === "string"
        ? message
        : new TextDecoder().decode(message as Uint8Array);
      sess.handleClientMessage(ws, text);
    },
    close(ws) {
      const { cellName } = ws.data as { cellName: string };
      const sess = sessions.get(cellName);
      if (sess) sess.removeClient(ws);
    },
  },
});

console.log(`host-bridge listening on http://127.0.0.1:${server.port}`);
console.log(`  idle TTL: ${Math.round(IDLE_TTL_MS / 1000)}s`);
console.log(`  GET  /healthz`);
console.log(`  POST /prewarm?cell=<name> (Bearer)`);
console.log(`  WS   /agent?cell=<name>   (Bearer ${(CELLS_PROXY_SECRET as string).slice(0, 10)}...)`);
