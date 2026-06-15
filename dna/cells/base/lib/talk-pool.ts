/**
 * Talk session pool — the warm, interactive replacement for the cell's single
 * always-on `claude --print` talk process. The IO half (tmux launch, the
 * transcript-tail loop, timers); every pure decision lives in session-pool.ts
 * and is unit-tested without a VM. Lives in lib/ (not site/) because refresh's
 * SYNC_ROOTS ship all of lib/ but only site/server.ts — and harness-adapters.ts
 * is the precedent for IO-bearing modules here.
 *
 * Each LiveSession is one genuinely interactive `claude` (no --print →
 * cc_entrypoint=cli, the interactive subscription pool) in a dedicated
 * `tmux -L cell-talk-<name>` socket, resuming its own durable per-name id. A
 * cell can hold several at once (main, buyer↔WhatsApp, staff↔Slack), each its
 * own durable conversation with its own queue. Output streams live by tailing
 * the transcript JSONL — which claude writes per COMPLETED block, not per
 * token, so this is message-chunk streaming, not the per-token typewriter the
 * --print path gave (an accepted, intrinsic tradeoff of dropping --print).
 *
 * The supervisor (site/server.ts) constructs ONE pool and wires it to the
 * bridge: deps.broadcast sends a pi-shaped line up to the DO exactly as
 * onTranslatedLine did, so Slack/email/CLI/agent-comms are unchanged.
 *
 * Design: docs/proposals/named-sessions.html.
 */

import { spawn, spawnSync } from "bun";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  IDLE_TTL_MS, SESSIONSTART_TIMEOUT_MS, WARM_CAP,
  idleEvictDue, isTerminalAnswer, lastTurnFinal, lruEvictTarget, parseJsonl,
  parseTranscriptDelta, sessionFlags, sessionIdPath, transcriptPathForId,
  type LiveSessionState, type PendingTurn, type SessionName,
} from "./session-pool";

const TALK_STATE_DIR = "/root/state/talk";
const BOOTSTRAP = "/root/bin/interactive-claude-talk.sh";
const TAIL_POLL_MS = 200;
// After the Stop marker, poll a little for the terminal text row to flush
// (Stop can fire microseconds before claude writes the final block).
const FINISH_POLL_TRIES = 12;
const FINISH_POLL_MS = 300;
// Small settle between tmux paste steps. The bootstrap leaves a warm pane at
// the prompt, so this is far shorter than the job runner's per-launch 1s.
const INJECT_SETTLE_MS = 300;

export type TalkPoolDeps = {
  // Send one pi-shaped event line up the bridge (server.ts → broadcastToClients).
  broadcast: (line: string) => void;
  // Called after any transition that changes whether ANY session is busy, so
  // the supervisor can drive welld's busy/idle lifecycle (idle only when no
  // session is busy AND no jobs are running).
  onBusyChange: (anyBusy: boolean) => void;
  log: (m: string) => void;
  err: (m: string) => void;
};

type LiveSession = {
  name: SessionName;
  state: LiveSessionState;
  sock: string;
  claudeSessionId: string | null;
  transcriptPath: string | null;
  queue: PendingTurn[];
  active: PendingTurn | null;
  cursor: number; // byte offset into the transcript for THIS turn
  compacted: boolean; // transcript shrank mid-turn → live-emit abandoned, fall back
  lastTurnAt: number;
  tailing: boolean;
  tailTimer: ReturnType<typeof setTimeout> | null;
  leashTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nowMs(): number {
  return Date.now();
}

// Read [start, start+len) of a file as bytes. Sync + precise (the tail needs
// the exact byte cursor); transcript growth per turn is small (KBs).
function readRange(path: string, start: number, len: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

async function tmux(sock: string, args: string[], stdin?: Buffer): Promise<number> {
  const p = spawn(["tmux", "-L", sock, ...args], {
    stdin: stdin ?? "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return await p.exited;
}

function tmuxHasSession(sock: string): boolean {
  try {
    return spawnSync(["tmux", "-L", sock, "has-session", "-t", "talk"], {
      stdout: "ignore", stderr: "ignore",
    }).exitCode === 0;
  } catch { return false; }
}

function killTmux(sock: string) {
  try { spawnSync(["tmux", "-L", sock, "kill-server"], { stdout: "ignore", stderr: "ignore" }); } catch {}
  // kill-server leaves the socket file; sweep it (sock is cell-talk-<validated-name>).
  try { spawnSync(["bash", "-lc", `rm -f /tmp/tmux-*/${sock}`], { stdout: "ignore", stderr: "ignore" }); } catch {}
}

export class TalkPool {
  private sessions = new Map<SessionName, LiveSession>();
  constructor(private deps: TalkPoolDeps) {
    mkdirSync(TALK_STATE_DIR, { recursive: true });
  }

  // ---- public API --------------------------------------------------------

  // Queue a turn for a named session, spawning/resuming it as needed. The
  // session is created cold on first reference.
  enqueue(name: SessionName, turn: PendingTurn): void {
    const s = this.ensure(name);
    s.queue.push(turn);
    void this.pump(s);
  }

  // Spawn a session to idle without a turn (boot: hide the cold-start for the
  // common "main" path).
  prewarm(name: SessionName): void {
    const s = this.ensure(name);
    if (s.state === "cold") void this.spawn(s);
  }

  anyBusy(): boolean {
    for (const s of this.sessions.values()) if (s.state === "busy" || s.state === "spawning") return true;
    return false;
  }

  // Boot/thaw: a prior well-site may have left warm tmux servers behind; their
  // cursors/timers are stale and a frozen-busy one would pin the cell awake.
  // Kill every cell-talk-* server and forget all sessions — the durable per-name
  // id means the next turn cold-starts and --resumes the conversation intact.
  sweepStale(): void {
    try { spawnSync(["bash", "-lc", "tmux -L cell-talk-_ kill-server 2>/dev/null; for s in /tmp/tmux-*/cell-talk-*; do n=$(basename \"$s\"); tmux -L \"$n\" kill-server 2>/dev/null; rm -f \"$s\"; done"], { stdout: "ignore", stderr: "ignore" }); } catch {}
    this.sessions.clear();
  }

  // ---- internals ---------------------------------------------------------

  private ensure(name: SessionName): LiveSession {
    let s = this.sessions.get(name);
    if (!s) {
      s = {
        name, state: "cold", sock: `cell-talk-${name}`,
        claudeSessionId: null, transcriptPath: null,
        queue: [], active: null, cursor: 0, compacted: false,
        lastTurnAt: nowMs(), tailing: false,
        tailTimer: null, leashTimer: null, idleTimer: null,
      };
      this.sessions.set(name, s);
    }
    return s;
  }

  private notifyBusy(): void {
    this.deps.onBusyChange(this.anyBusy());
  }

  // Drive a session forward: spawn if cold, start the next queued turn if idle.
  private async pump(s: LiveSession): Promise<void> {
    if (s.state === "busy" || s.state === "spawning" || s.state === "evicting") return;
    if (s.queue.length === 0) return;
    if (s.state === "cold" || s.state === "crashed") {
      await this.spawn(s);
      // spawn() pumps again on success; on failure it drains the queue with errors.
      return;
    }
    if (s.state === "idle") this.startTurn(s);
  }

  // Cold → spawning → idle. Resolves the durable id (create-on-first-use),
  // runs the bash bootstrap, and waits for SessionStart (the bootstrap exits 0
  // when ready). LRU-evicts an idle session first if we're at the warm cap.
  private async spawn(s: LiveSession): Promise<void> {
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    // Make room under the warm cap (the fleet RAM ceiling).
    const evict = lruEvictTarget(
      [...this.sessions.values()].map((x) => ({ name: x.name, state: x.state, lastTurnAt: x.lastTurnAt })),
      WARM_CAP,
    );
    if (evict && evict !== s.name) {
      const victim = this.sessions.get(evict);
      if (victim) this.evict(victim, "LRU (warm cap)");
    }

    // Resolve the durable claude session id: resume an existing one, or mint a
    // new uuid (asserted via --session-id) and persist it before launch.
    const idFile = sessionIdPath(s.name);
    if (!idFile) { this.drainQueueWithError(s, `invalid session name: ${s.name}`); return; }
    let resumedId: string | null = null;
    try { const v = readFileSync(idFile, "utf8").trim(); if (v) resumedId = v; } catch {}
    const freshId = randomUUID();
    const { args, created } = sessionFlags(resumedId, freshId);
    const sid = resumedId ?? freshId;
    const mode = created ? "create" : "resume";
    if (created) {
      try {
        mkdirSync(idFile.slice(0, idFile.lastIndexOf("/")), { recursive: true });
        writeFileSync(idFile, sid);
      } catch (e) { this.drainQueueWithError(s, `could not persist session id: ${String(e).slice(0, 120)}`); return; }
    }

    s.state = "spawning";
    s.claudeSessionId = sid;
    s.transcriptPath = transcriptPathForId(sid);
    this.notifyBusy(); // spawning counts as busy (holds the cell awake during boot)
    this.deps.log(`talk-pool: ${s.name} ${mode} ${sid.slice(0, 8)} (${args.join(" ")})`);

    let code = 1;
    try {
      const p = spawn([
        "bash", BOOTSTRAP,
        "--name", s.name, "--sock", s.sock, "--statedir", TALK_STATE_DIR,
        "--mode", mode, "--sid", sid, "--timeout-ms", String(SESSIONSTART_TIMEOUT_MS),
      ], { cwd: "/root", stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { ...process.env, HOME: "/root" } });
      code = await p.exited;
      if (code !== 0) {
        const err = await new Response(p.stderr).text();
        this.deps.err(`talk-pool: ${s.name} bootstrap exit ${code}: ${err.slice(0, 200)}`);
      }
    } catch (e) {
      this.deps.err(`talk-pool: ${s.name} bootstrap threw: ${String(e).slice(0, 160)}`);
    }

    if (code !== 0) {
      s.state = "cold";
      this.drainQueueWithError(s, "the cell could not start an interactive session (see supervisor log)");
      this.notifyBusy();
      return;
    }
    s.state = "idle";
    s.lastTurnAt = nowMs();
    this.deps.log(`talk-pool: ${s.name} warm`);
    void this.pump(s);
    if (s.state === "idle") this.armIdle(s);
  }

  // Idle → busy. Pin the cursor at the current transcript size (everything
  // appended after = this turn), inject the prompt, start the tail.
  private startTurn(s: LiveSession): void {
    const turn = s.queue.shift()!;
    s.active = turn;
    s.state = "busy";
    s.lastTurnAt = nowMs();
    s.compacted = false;
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    this.notifyBusy();
    // agent_start opens a turn at the DO (it gates message_update accumulation
    // on a current turn) — the same contract the --print path met via the
    // synthesized agent_start.
    this.deps.broadcast(JSON.stringify({ type: "agent_start" }));
    // Clear THIS turn's done marker; the Stop hook re-creates it at turn end.
    try { rmSync(`${TALK_STATE_DIR}/${s.name}.done`, { force: true }); } catch {}
    s.cursor = fileSize(s.transcriptPath!);
    s.leashTimer = setTimeout(() => this.failTurn(s, "turn timed out"), turn.leashMs);
    void this.inject(s, turn.text).then(() => this.scheduleTail(s));
  }

  // Inject the prompt into the warm pane via bracketed paste (robust for any
  // content). A leading `/` or `!` is a TUI command — neutralize with a space.
  private async inject(s: LiveSession, text: string): Promise<void> {
    const body = /^[/!]/.test(text) ? " " + text : text;
    await tmux(s.sock, ["load-buffer", "-b", "talkp", "-"], Buffer.from(body));
    await sleep(INJECT_SETTLE_MS);
    await tmux(s.sock, ["paste-buffer", "-t", "talk", "-b", "talkp", "-d", "-p"]);
    await sleep(INJECT_SETTLE_MS);
    await tmux(s.sock, ["send-keys", "-t", "talk", "Enter"]);
  }

  private scheduleTail(s: LiveSession): void {
    s.tailing = true;
    const tick = async () => {
      if (!s.tailing) return;
      await this.tailTick(s);
      if (s.tailing) s.tailTimer = setTimeout(tick, TAIL_POLL_MS);
    };
    s.tailTimer = setTimeout(tick, TAIL_POLL_MS);
  }

  // One tail pass: emit newly-completed assistant text blocks; close on the
  // Stop marker; error the turn if the pane vanished.
  private async tailTick(s: LiveSession): Promise<void> {
    const path = s.transcriptPath!;
    const size = fileSize(path);
    if (size < s.cursor) {
      // The transcript shrank — claude compacted it mid-turn. Abandon live-emit;
      // finishTurn reconstructs from the fresh file.
      s.compacted = true;
    } else if (size > s.cursor) {
      this.emitRange(s, size);
    }
    if (existsSync(`${TALK_STATE_DIR}/${s.name}.done`)) { await this.finishTurn(s); return; }
    if (!tmuxHasSession(s.sock)) { this.crashTurn(s); return; }
  }

  // Read [cursor, size), advance only over COMPLETE lines (the byte cursor
  // never crosses an unterminated line, which keeps decoding codepoint-safe),
  // and emit each new assistant text block as a text_delta.
  private emitRange(s: LiveSession, size: number): void {
    if (s.compacted) return;
    const buf = readRange(s.transcriptPath!, s.cursor, size - s.cursor);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return; // no complete line yet
    const text = buf.subarray(0, lastNl + 1).toString("utf8");
    s.cursor += lastNl + 1;
    const deltas = parseTranscriptDelta(parseJsonl(text));
    for (const d of deltas) {
      this.deps.broadcast(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: d } }));
      if (s.active?.corrId) s.active.acc += d;
    }
  }

  // Stop fired. Final drain + poll for the terminal text row (Stop can beat the
  // last block's flush), then agent_end and (for a corrId turn) agent_response.
  private async finishTurn(s: LiveSession): Promise<void> {
    s.tailing = false;
    if (s.tailTimer) { clearTimeout(s.tailTimer); s.tailTimer = null; }
    if (s.leashTimer) { clearTimeout(s.leashTimer); s.leashTimer = null; }

    let fallback = "";
    for (let i = 0; i < FINISH_POLL_TRIES; i++) {
      const size = fileSize(s.transcriptPath!);
      if (!s.compacted && size > s.cursor) this.emitRange(s, size);
      const final = this.readFinal(s);
      if (isTerminalAnswer(final.text, final.stopReason)) { fallback = final.text; break; }
      await sleep(FINISH_POLL_MS);
    }

    const turn = s.active;
    this.deps.broadcast(JSON.stringify({ type: "agent_end" }));
    if (turn?.corrId) {
      const text = turn.acc.trim() || fallback.trim() || "(empty reply)";
      this.deps.broadcast(JSON.stringify({ type: "agent_response", in_reply_to: turn.corrId, text }));
    }
    s.active = null;
    s.state = "idle";
    s.lastTurnAt = nowMs();
    s.cursor = 0;
    s.compacted = false;
    this.notifyBusy();
    this.armIdle(s);
    void this.pump(s);
  }

  // Full-transcript reconstruction (the finishTurn fallback) — same harvester
  // as the job runner: last assistant after the last user row.
  private readFinal(s: LiveSession): { text: string; stopReason: string } {
    try {
      const rows = parseJsonl(readFileSync(s.transcriptPath!, "utf8"));
      return lastTurnFinal(rows);
    } catch { return { text: "", stopReason: "" }; }
  }

  private crashTurn(s: LiveSession): void {
    s.tailing = false;
    if (s.tailTimer) { clearTimeout(s.tailTimer); s.tailTimer = null; }
    if (s.leashTimer) { clearTimeout(s.leashTimer); s.leashTimer = null; }
    this.deps.err(`talk-pool: ${s.name} pane vanished mid-turn`);
    this.errorActive(s, "the interactive session ended mid-turn (likely an API/auth/rate error)");
    killTmux(s.sock);
    s.state = "cold";
    s.active = null;
    this.notifyBusy();
    void this.pump(s);
  }

  private failTurn(s: LiveSession, why: string): void {
    s.tailing = false;
    if (s.tailTimer) { clearTimeout(s.tailTimer); s.tailTimer = null; }
    s.leashTimer = null;
    this.deps.err(`talk-pool: ${s.name} ${why}`);
    this.errorActive(s, `[error] ${why}`);
    // A wedged session must die so the next turn cold-starts cleanly.
    killTmux(s.sock);
    s.state = "cold";
    s.active = null;
    this.notifyBusy();
    void this.pump(s);
  }

  // Emit a turn-ending error to the right consumer (agent_response for a corrId
  // turn so the sender's long-poll fails loudly; a response error for a raw
  // interactive prompt; always agent_end so the DO closes the turn).
  private errorActive(s: LiveSession, msg: string): void {
    const turn = s.active;
    if (turn?.corrId) {
      this.deps.broadcast(JSON.stringify({ type: "agent_response", in_reply_to: turn.corrId, text: msg }));
    } else {
      this.deps.broadcast(JSON.stringify({ type: "response", success: false, error: msg }));
    }
    this.deps.broadcast(JSON.stringify({ type: "agent_end" }));
  }

  private drainQueueWithError(s: LiveSession, msg: string): void {
    const turns = s.queue.splice(0);
    for (const t of turns) {
      if (t.corrId) {
        this.deps.broadcast(JSON.stringify({ type: "agent_response", in_reply_to: t.corrId, text: `[error] ${msg}` }));
      } else {
        this.deps.broadcast(JSON.stringify({ type: "response", success: false, error: `[error] ${msg}` }));
        this.deps.broadcast(JSON.stringify({ type: "agent_end" }));
      }
    }
  }

  private armIdle(s: LiveSession): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (s.state === "idle" && idleEvictDue(nowMs(), s.lastTurnAt, IDLE_TTL_MS)) {
        this.evict(s, `idle ${Math.round(IDLE_TTL_MS / 60000)}m`);
      }
    }, IDLE_TTL_MS);
  }

  private evict(s: LiveSession, reason: string): void {
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    if (s.state !== "idle") return;
    s.state = "evicting";
    killTmux(s.sock);
    s.state = "cold";
    s.claudeSessionId = null;
    s.transcriptPath = null;
    this.deps.log(`talk-pool: ${s.name} evicted (${reason})`);
  }
}
