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

// V1.9 picker output, written by cells.ts cmdCreateV1Fast into the cell's
// record in cells.json. Used here to override the hardcoded magical-cell
// defaults on session setup. Mirrors the PickerChoice type in cells.ts.
type PickerChoice = {
  provider: string;
  modelId: string;
  thinking: string;
  extensions: string[];
  channel: string;
};

type CellTarget = {
  cellName: string;
  wellName: string;
  ip: string;
  sshKeyPath: string;
  picker: PickerChoice | null;
};

async function resolveCellTarget(cellName: string): Promise<CellTarget | null> {
  // cells.json → hatched_from short id; eggs.json → well_name. For cells
  // without a hatched_from entry (cold-fork path), the well-name equals
  // the cell-name.
  let wellName = cellName;
  let picker: PickerChoice | null = null;
  try {
    const reg = JSON.parse(readFileSync(join(homedir(), ".cells", "cells.json"), "utf8"));
    const cell = reg?.cells?.find((c: any) => c.name === cellName);
    if (cell?.hatched_from) {
      const eggs = JSON.parse(readFileSync(join(homedir(), ".cells", "eggs.json"), "utf8"));
      const egg = eggs?.eggs?.find((e: any) => e.id === cell.hatched_from);
      if (egg?.well_name) wellName = egg.well_name;
    }
    if (cell?.picker?.provider && cell?.picker?.modelId && cell?.picker?.thinking) {
      picker = {
        provider: String(cell.picker.provider),
        modelId: String(cell.picker.modelId),
        thinking: String(cell.picker.thinking),
        extensions: Array.isArray(cell.picker.extensions) ? cell.picker.extensions.map(String) : [],
        channel: typeof cell.picker.channel === "string" ? cell.picker.channel : "auto",
      };
    }
  } catch {
    /* fall through with wellName = cellName + picker = null */
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

  return { cellName, wellName, ip: info.ip, sshKeyPath, picker };
}

// --- per-cell session ----------------------------------------------------

class CellSession {
  cellName: string;
  wellName: string;
  picker: PickerChoice | null;
  ssh: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  piReady = false;
  pendingPrompts: any[] = [];
  awaitingSwitchAck: string | null = null;
  stdoutBuffer = "";
  clients = new Set<any>(); // ServerWebSocket
  idleTimer: Timer | null = null;
  exiting = false;
  // Resolvers for whenReady() promises waiting on piReady to flip.
  readyResolvers: Array<(ok: boolean) => void> = [];

  constructor(cellName: string, wellName: string, picker: PickerChoice | null) {
    this.cellName = cellName;
    this.wellName = wellName;
    this.picker = picker;
  }

  log(msg: string) {
    console.log(`[${this.cellName}] ${msg}`);
  }
  err(msg: string) {
    console.error(`[${this.cellName}] ${msg}`);
  }

  async start(target: CellTarget): Promise<void> {
    // cellName already includes the "cell-" prefix; don't double it.
    const sessionDir = `/cell/.pi/agent/sessions/${this.cellName}`;
    // We SSH as `ubuntu` (lume's default) and sudo to `cell` to run pi.
    // Why: ubuntu has the substrate-provided ssh key in authorized_keys;
    // pi needs to run as cell (HOME=/cell, reads /cell/.pi/settings.json).
    // sudo -u with NOPASSWD is set up at bake time (host already configures
    // ubuntu→cell NOPASSWD sudoers per the bake recipe).
    // bash -lc inside the sudo so /etc/profile.d/cells-env.sh fires and
    // /home/well/.bun/bin lands on PATH.
    // pi lives at /usr/bin/pi (system-wide install per the bake recipe).
    // sudo -u cell with bash -lc picks up /etc/profile.d/cells-env.sh so
    // CELL_NAME + LLM keys flow into pi's environment from /etc/environment.
    // cd /cell so pi's cwd matches the agent root — the `use-max` extension's
    // before_agent_start hook composes SOUL+CELLS+TOOLS+CONTACTS+MEMORY into the
    // system prompt by reading from ctx.cwd. Without this, pi falls back to its
    // default "coding assistant" prompt and the cell speaks as Pi instead of
    // a cell (violates feedback_cell_vs_harness).
    const remoteCmd =
      `sudo -u cell mkdir -p ${sessionDir} 2>/dev/null; ` +
      `exec sudo -u cell -H bash -lc 'cd /cell && exec pi --mode rpc --session-dir ${sessionDir}'`;
    this.log(`spawning ssh+pi to ubuntu@${target.ip}`);
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
        "bash", "-lc", remoteCmd,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );

    void this.pumpStdout();
    void this.pumpStderr();
    void this.ssh.exited.then((code) => {
      this.err(`ssh+pi exited code=${code}`);
      this.ssh = null;
      this.piReady = false;
      // Notify clients so they can decide to disconnect or reconnect.
      this.broadcastJSON({ type: "bridge_closed", reason: `pi-exited-${code}` });
    });

    // Setup handshake: ack-driven, same shape as the in-cell version.
    const switchId = `bridge-init-${Date.now()}`;
    this.awaitingSwitchAck = switchId;
    setTimeout(() => {
      if (!this.sendToPi({ id: switchId, type: "switch_session", sessionPath: `${sessionDir}/main.jsonl` })) {
        this.err(`could not send initial switch_session`);
      } else {
        this.log(`pinned pi to ${sessionDir}/main.jsonl (awaiting ack)`);
      }
    }, 250);
  }

  sendToPi(cmd: object): boolean {
    if (!this.ssh || !this.ssh.stdin) return false;
    try {
      const sink = this.ssh.stdin as any;
      sink.write(JSON.stringify(cmd) + "\n");
      if (typeof sink.flush === "function") sink.flush();
      return true;
    } catch (e) {
      this.err(`pi stdin write failed: ${String(e).slice(0, 200)}`);
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
    // Magical-cell defaults: deepseek-v4-flash + thinking off (match
    // dna/cells/base/.pi/settings.json). When a V1.9 picker choice is
    // present in the cell record, apply that instead — host-bridge is
    // the only place these RPCs fire on session setup, so this is what
    // makes "the user picked opus" actually mean opus.
    if (this.picker) {
      this.log(`applying picker: ${this.picker.provider}/${this.picker.modelId}:${this.picker.thinking}`);
      this.sendToPi({ type: "set_model", provider: this.picker.provider, modelId: this.picker.modelId });
      this.sendToPi({ type: "set_thinking_level", level: this.picker.thinking });
    } else {
      this.sendToPi({ type: "set_model", provider: "deepseek", modelId: "deepseek-v4-flash" });
      this.sendToPi({ type: "set_thinking_level", level: "off" });
    }
    this.piReady = true;
    for (const r of this.readyResolvers) r(true);
    this.readyResolvers.length = 0;
    if (this.pendingPrompts.length > 0) {
      this.log(`flushing ${this.pendingPrompts.length} pending prompt(s)`);
      for (const cmd of this.pendingPrompts) this.sendToPi(cmd);
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

  onPiStdoutChunk(chunk: string) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed.trim()) continue;
      this.broadcastRaw(trimmed);
      // Sniff for switch_session ack
      try {
        const evt = JSON.parse(trimmed);
        if (
          evt?.type === "response" &&
          evt?.command === "switch_session" &&
          this.awaitingSwitchAck !== null &&
          evt?.id === this.awaitingSwitchAck
        ) {
          this.log(`switch_session acked`);
          this.awaitingSwitchAck = null;
          this.onPiSetupAcked();
        }
      } catch { /* not JSON, ignore */ }
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
        this.onPiStdoutChunk(decoder.decode(value, { stream: true }));
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
      if (cmd?.type === "ping") {
        try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
        continue;
      }
      if (!this.piReady && cmd?.type === "prompt") {
        this.log(`queuing prompt (pi not ready yet)`);
        this.pendingPrompts.push(cmd);
        try {
          ws.send(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }));
        } catch {}
        continue;
      }
      if (!this.sendToPi(cmd)) {
        this.err(`pi not running, dropping cmd ${cmd?.type}`);
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
    sessions.delete(this.cellName);
  }
}

const sessions = new Map<string, CellSession>();

async function getOrCreateSession(cellName: string): Promise<CellSession | null> {
  const existing = sessions.get(cellName);
  if (existing && existing.ssh) return existing;
  const target = await resolveCellTarget(cellName);
  if (!target) return null;
  const sess = new CellSession(cellName, target.wellName, target.picker);
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
