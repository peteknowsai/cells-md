/**
 * harness-adapters — one HarnessAdapter per harness flavour.
 *
 * Three harnesses share one supervisor-shaped session. Two are "persistent"
 * — one long-lived process driven over stdio: `pi` (the full agent,
 * JSON-RPC) and `claude-code` (the `claude` CLI, stream-json). The third,
 * `codex`, is "per-turn" — `codex exec` is one-shot, so each prompt spawns
 * a fresh process and multi-turn rides on `codex exec resume <thread_id>`.
 * The adapter owns what differs — the remote command(s), the ready
 * handshake, and the protocol translation. Every consumer of an adapter
 * (host-bridge's CellSession on the Mac, site/server.ts's supervisor on the
 * cell) only ever speaks pi's event vocabulary; every adapter translates
 * into it, so wire-format-wise all three harnesses are identical.
 *
 * Adapters also own forkAndAsk — the cell-side fork-and-ask used by the
 * agent-comms primitive. Each adapter knows how to fork its harness's main
 * session into a read-only branch, run a one-shot prompt against it, and
 * discard the fork. Used by site/server.ts's /agent-message path.
 *
 * Both callers (Mac-side host-bridge for `cells talk`, cell-side site
 * server for Slack/email) implement AdapterHost. The adapter file imports
 * Bun's `spawn` for forkAndAsk — both callers run on Bun so this is safe.
 */

import { spawn } from "bun";
import { copyFile, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// What an adapter needs from its host. Mac-side CellSession satisfies this;
// the cell-side supervisor in site/server.ts will too.
export interface AdapterHost {
  // codex's thread id, captured from the first turn's thread.started event;
  // every later turn resumes it, so the conversation persists across spawns.
  codexThreadId: string | null;
  // The id of an outstanding switch_session RPC (pi only); the adapter sets
  // it in startHandshake and clears it when the matching ack arrives.
  awaitingSwitchAck: string | null;
  // Write one already-serialized line to the harness process's stdin.
  writeLine(line: string): boolean;
  log(msg: string): void;
  err(msg: string): void;
  // Called when the harness has emitted its "ready" signal (or for
  // claude-code, immediately — claude has no pre-input ready event).
  onPiSetupAcked(): void;
}

export interface HarnessAdapter {
  // "persistent": one long-lived ssh+harness process driven over stdin
  // (pi, claude-code). "per-turn": a fresh ssh+harness process per prompt
  // (codex — `codex exec` is one-shot, resumed by thread id).
  mode: "persistent" | "per-turn";
  // persistent only: the remote command, passed as ssh's single command
  // arg (ssh runs it through the remote login shell — do NOT wrap it).
  buildRemoteCmd?(sessionDir: string): string;
  // persistent only: called once ~250ms after spawn. pi pins its session
  // file with a switch_session RPC; claude-code sends nothing (it emits
  // system/init unprompted). Uses sess.writeLine() / sess.awaitingSwitchAck.
  startHandshake?(sess: AdapterHost, sessionDir: string): void;
  // both: inspect one harness stdout line. `ready` flags the harness's
  // "I'm up" signal (pi: the switch_session ack; claude-code: system/init;
  // per-turn: unused). `lines` are the WS frames to broadcast — pi passes
  // its line through unchanged; claude-code and codex emit zero or more
  // translated pi-shaped events.
  translateOutbound(sess: AdapterHost, line: string): { lines: string[]; ready: boolean };
  // persistent only: translate one inbound client command (pi-RPC-shaped,
  // e.g. {type:"prompt",message}) into the line to write on the process's
  // stdin. Return null to drop the command.
  translateInbound?(cmd: any): string | null;
  // per-turn only: the remote command for one prompt. Resumes
  // sess.codexThreadId when set; the prompt arrives as argv, stdin closed.
  buildTurnCmd?(sess: AdapterHost, prompt: string): string;

  // Fork the harness's main session into a transient branch, run one
  // prompt against it, return the response, discard the fork. The main
  // session must be bit-identical before/after. Used by the agent-comms
  // primitive (cells-to-cells RPC + Pete's `cells talk`). mainRef is
  // harness-specific:
  //   pi          — absolute path to main.jsonl
  //   claude-code — main session UUID (the on-cell cache file content)
  //   codex       — main thread UUID
  forkAndAsk(opts: ForkAndAskOpts): Promise<ForkAndAskResult>;
}

export interface ForkAndAskOpts {
  prompt: string;
  // Reference to main session, harness-specific format. See HarnessAdapter
  // .forkAndAsk doc. Empty string = no main exists yet; the adapter should
  // run a fresh session (no fork) for context-free answers.
  mainRef: string;
  // Cell name — used in log lines so concurrent forks across cells are
  // distinguishable.
  cellName: string;
  timeoutMs?: number;
}

export type ForkAndAskResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

// Random hex used in fork artifact paths so concurrent forks don't collide.
function forkSlug(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Run a process with timeout, return { stdout, stderr, exitCode } or throw.
async function runProcess(opts: {
  cmd: string[];
  stdin?: string;
  timeoutMs: number;
  cwd?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(opts.cmd, {
    stdin: opts.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
  });
  if (opts.stdin !== undefined && proc.stdin) {
    try {
      const sink = proc.stdin as any;
      sink.write(opts.stdin);
      if (typeof sink.end === "function") sink.end();
      else if (typeof sink.flush === "function") sink.flush();
    } catch { /* best-effort */ }
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error(`process timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
  });
  try {
    const exitCode = await Promise.race([proc.exited, timeout]);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, exitCode: exitCode as number };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const piAdapter: HarnessAdapter = {
  mode: "persistent",
  buildRemoteCmd(sessionDir) {
    // SSH as ubuntu, sudo to root. bash -lc so /etc/profile.d/cells-env.sh
    // fires (PATH + CELL_NAME + LLM keys). cd /root so use-max composes the
    // cell's system prompt from ctx.cwd — without it the cell speaks as Pi.
    // HOME=/root so pi finds /root/.pi/. As of the root-cell migration
    // (2026-05-15), the agent runs as root inside the VM — the VM is the
    // sandbox, so the cell vs root user distinction was theatrical and
    // blocked claude/codex/pi auto-updaters (root-owned npm globals).
    return (
      `sudo mkdir -p ${sessionDir} 2>/dev/null; ` +
      `exec sudo bash -lc 'export HOME=/root; cd /root && exec pi --mode rpc --session-dir ${sessionDir}'`
    );
  },
  startHandshake(sess, sessionDir) {
    // Pin pi to the cell's main session file; piReady flips when the
    // matching response acks (see translateOutbound).
    const switchId = `bridge-init-${Date.now()}`;
    sess.awaitingSwitchAck = switchId;
    setTimeout(() => {
      const line = JSON.stringify({ id: switchId, type: "switch_session", sessionPath: `${sessionDir}/main.jsonl` });
      if (!sess.writeLine(line)) sess.err(`could not send initial switch_session`);
      else sess.log(`pinned pi to ${sessionDir}/main.jsonl (awaiting ack)`);
    }, 250);
  },
  translateOutbound(sess, line) {
    // pi's RPC stream is already the talk CLI's vocabulary — pass through.
    // Sniff only for the switch_session ack that flips piReady.
    let ready = false;
    try {
      const evt = JSON.parse(line);
      if (
        evt?.type === "response" &&
        evt?.command === "switch_session" &&
        sess.awaitingSwitchAck !== null &&
        evt?.id === sess.awaitingSwitchAck
      ) {
        sess.log(`switch_session acked`);
        sess.awaitingSwitchAck = null;
        ready = true;
      }
    } catch { /* not JSON — still broadcast the line */ }
    return { lines: [line], ready };
  },
  translateInbound(cmd) {
    // The talk CLI already speaks pi RPC — forward verbatim.
    return JSON.stringify(cmd);
  },
  // Pi has native --fork. Point it at the main session file, give it a
  // fresh --session-dir for the fork's writes, and the original main.jsonl
  // stays bit-identical. Prompt is passed as argv (pi's standard one-shot
  // shape with --print).
  async forkAndAsk({ prompt, mainRef, cellName, timeoutMs = 90_000 }) {
    if (!mainRef) {
      return { ok: false, error: "pi forkAndAsk: empty mainRef" };
    }
    if (!existsSync(mainRef)) {
      return { ok: false, error: `pi forkAndAsk: main session not found at ${mainRef}` };
    }
    const slug = forkSlug();
    const forkDir = `/tmp/agent-fork-${cellName}-${slug}`;
    try {
      await mkdir(forkDir, { recursive: true });
      const r = await runProcess({
        cmd: [
          "pi",
          "--print",
          "--fork", mainRef,
          "--session-dir", forkDir,
          "--thinking", "off",
          prompt,
        ],
        timeoutMs,
      });
      if (r.exitCode !== 0) {
        return { ok: false, error: `pi exit ${r.exitCode}: ${r.stderr.slice(0, 200)}` };
      }
      return { ok: true, text: r.stdout.trim() };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    } finally {
      try { await rm(forkDir, { recursive: true, force: true }); } catch {}
    }
  },
};

export const claudeCodeAdapter: HarnessAdapter = {
  mode: "persistent",
  buildRemoteCmd() {
    // claude reads model + effortLevel from /root/.claude/settings.json and
    // the proxy env (ANTHROPIC_BASE_URL/AUTH_TOKEN) from the env shim that
    // bash -lc sources. --print with stream-json in/out makes it a
    // persistent multi-turn process driven over stdin/stdout — the same
    // shape host-bridge gives pi. bypassPermissions: a cell runs headless
    // on its own VM, there's no human at the tty to answer prompts, and the
    // VM is the isolation boundary. HOME=/root so claude finds /root/.claude/.
    // IS_SANDBOX=1 satisfies claude's root+bypassPermissions guard ("cannot
    // be used with root/sudo privileges for security reasons" — designed for
    // shared boxes; the VM is exactly the case where it's safe).
    //
    // --resume binds talk to the cell's MAIN session id (formerly the
    // talk-only scratch id; retired 2026-05-19 since the agent-comms
    // primitive forks main read-only for one-shot RPC, while interactive
    // `cells talk` is a persistent channel that should write to main —
    // same target as Slack/email/TUI). Falls through to a fresh session if
    // the cache file is missing (pre-fix cells get a one-time main capture
    // and then track main thereafter).
    return (
      `exec sudo bash -lc 'export HOME=/root IS_SANDBOX=1; cd /root && ` +
      `RESUME=""; [ -s /root/.cell/claude-main-session ] && RESUME="--resume $(cat /root/.cell/claude-main-session)"; ` +
      `exec claude --print --input-format stream-json --output-format stream-json ` +
      `--verbose --include-partial-messages --permission-mode bypassPermissions $RESUME'`
    );
  },
  startHandshake(sess) {
    // claude --print has no pre-input "ready" signal — it does nothing until
    // it receives a user message on stdin. Waiting for system/init before
    // sending the prompt deadlocks (claude needs input to emit anything).
    // Mark the session ready immediately so the queued prompt flushes.
    sess.onPiSetupAcked();
  },
  translateOutbound(_sess, line) {
    let evt: any;
    try { evt = JSON.parse(line); }
    catch { return { lines: [], ready: false }; }

    // system/init → claude is up and listening on stdin.
    if (evt?.type === "system" && evt?.subtype === "init") {
      return { lines: [], ready: true };
    }
    // assistant message → translate each content block into the pi-shaped
    // events the talk CLI renders.
    if (evt?.type === "assistant" && Array.isArray(evt?.message?.content)) {
      const out: string[] = [];
      for (const block of evt.message.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          out.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: block.text } }));
        } else if (block?.type === "thinking") {
          out.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } }));
          out.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } }));
        }
      }
      return { lines: out, ready: false };
    }
    // result → the turn finished (or errored).
    if (evt?.type === "result") {
      if (evt?.is_error || evt?.subtype !== "success") {
        const error = String(evt?.result ?? evt?.subtype ?? "claude error").slice(0, 300);
        return { lines: [JSON.stringify({ type: "response", success: false, error })], ready: false };
      }
      return { lines: [JSON.stringify({ type: "agent_end" })], ready: false };
    }
    // user-message replays, rate-limit events, partial-message envelopes —
    // nothing the talk CLI needs to render.
    return { lines: [], ready: false };
  },
  translateInbound(cmd) {
    // The talk CLI sends {type:"prompt",message,streamingBehavior}; claude's
    // stream-json input wants a user-message envelope. abort/ping and any
    // other pi-only commands have no claude equivalent — drop them.
    if (cmd?.type === "prompt" && typeof cmd.message === "string") {
      return JSON.stringify({ type: "user", message: { role: "user", content: cmd.message } });
    }
    return null;
  },
  // Claude resumes by uuid embedded in the filename. Clone main's JSONL to
  // a new uuid filename, --resume that, capture stdout, delete the clone.
  // bash -lc to source /etc/profile.d/cells-env.sh for proxy auth.
  async forkAndAsk({ prompt, mainRef, cellName, timeoutMs = 90_000 }) {
    if (!mainRef) {
      // No main exists — run a fresh session. The cell has no context to
      // draw on, so the answer is generic. Better than failing.
      try {
        const r = await runProcess({
          cmd: [
            "bash", "-lc",
            `export HOME=/root IS_SANDBOX=1; cd /root && exec claude --print --permission-mode bypassPermissions`,
          ],
          stdin: prompt,
          timeoutMs,
        });
        if (r.exitCode !== 0) {
          return { ok: false, error: `claude (no-fork) exit ${r.exitCode}: ${r.stderr.slice(0, 200)}` };
        }
        return { ok: true, text: r.stdout.trim() };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 200) };
      }
    }
    const slug = forkSlug();
    // Claude session uuids are uuid4-shaped. Use crypto.randomUUID() so the
    // filename matches what claude expects for resume.
    const forkId = crypto.randomUUID();
    const srcPath = `/root/.claude/projects/-root/${mainRef}.jsonl`;
    const dstPath = `/root/.claude/projects/-root/${forkId}.jsonl`;
    if (!existsSync(srcPath)) {
      return { ok: false, error: `claude main session file not found: ${srcPath}` };
    }
    try {
      await copyFile(srcPath, dstPath);
      const r = await runProcess({
        cmd: [
          "bash", "-lc",
          `export HOME=/root IS_SANDBOX=1; cd /root && exec claude --print --resume '${forkId}' --permission-mode bypassPermissions`,
        ],
        stdin: prompt,
        timeoutMs,
      });
      if (r.exitCode !== 0) {
        return { ok: false, error: `claude exit ${r.exitCode}: ${r.stderr.slice(0, 200)}` };
      }
      // claude --print prints just the assistant text on stdout.
      const text = r.stdout.trim();
      // Sanity: claude prints "Not logged in" on auth failure (Phase 0 ran into this)
      if (text.includes("Not logged in")) {
        return { ok: false, error: `claude not authenticated (bash -lc env miss?): ${text.slice(0, 200)}` };
      }
      // Suppress slug in debug logs; cellName already identifies the cell.
      void slug;
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    } finally {
      try { await rm(dstPath, { force: true }); } catch {}
    }
  },
};

export const codexAdapter: HarnessAdapter = {
  mode: "per-turn",
  // codex has no persistent process — `codex exec` is one-shot. Each prompt
  // spawns a fresh ssh+codex (CellSession.runTurn); multi-turn rides on
  // `codex exec resume <thread_id>`, the id captured from thread.started.
  // bash -lc sources /etc/profile.d/cells-env.sh (OPENAI_CODEX_API_KEY +
  // PATH); HOME=/root so CODEX_HOME → /root/.codex/.
  // --json: JSONL events on stdout. --skip-git-repo-check: /root isn't a
  // git repo. --dangerously-bypass-approvals-and-sandbox: the cell's VM is
  // the isolation boundary (same rationale as claude-code's bypassPermissions).
  // The prompt rides as bash's $1 (a positional arg — one layer of shell
  // quoting, no nested-quote hell); stdin is closed so codex doesn't block
  // reading it.
  buildTurnCmd(sess, prompt) {
    const promptArg = `'${prompt.replace(/'/g, "'\\''")}'`;
    const flags = "--json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox";
    // Priority: in-memory id (set after first turn in this CellSession) →
    // birth-time MAIN cache (/root/.cell/codex-main-thread) → fresh thread.
    // Was the talk-only scratch thread; retired 2026-05-19 — interactive
    // `cells talk` is now a persistent write channel like Slack, so it
    // tracks main. Reading the cache in the remote shell avoids a separate SSH.
    const run = sess.codexThreadId
      ? `exec codex exec resume ${sess.codexThreadId} ${flags} "$1" </dev/null`
      : `if [ -s /root/.cell/codex-main-thread ]; then exec codex exec resume "$(cat /root/.cell/codex-main-thread)" ${flags} "$1" </dev/null; else exec codex exec ${flags} "$1" </dev/null; fi`;
    return `exec sudo bash -lc 'export HOME=/root; cd /root && ${run}' codex-turn ${promptArg}`;
  },
  translateOutbound(sess, line) {
    let evt: any;
    try { evt = JSON.parse(line); }
    catch { return { lines: [], ready: false }; }

    // thread.started → capture the thread id; the next turn resumes it.
    if (evt?.type === "thread.started" && typeof evt?.thread_id === "string") {
      sess.codexThreadId = evt.thread_id;
      return { lines: [], ready: false };
    }
    // item.completed / agent_message → the response. codex emits the whole
    // message at once (not token-streamed) — one text_delta with all of it.
    if (
      evt?.type === "item.completed" &&
      evt?.item?.type === "agent_message" &&
      typeof evt?.item?.text === "string"
    ) {
      return {
        lines: [JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: evt.item.text } })],
        ready: false,
      };
    }
    // turn.completed → the turn finished cleanly.
    if (evt?.type === "turn.completed") {
      return { lines: [JSON.stringify({ type: "agent_end" })], ready: false };
    }
    // turn.failed → the turn errored out (terminal).
    if (evt?.type === "turn.failed") {
      const error = String(evt?.error?.message ?? "codex error").slice(0, 300);
      return { lines: [JSON.stringify({ type: "response", success: false, error })], ready: false };
    }
    // error events are transient — codex retries internally, and a real
    // failure still arrives as turn.failed. Log, don't surface. turn.started,
    // reasoning/command items, and usage carry nothing the talk CLI renders.
    if (evt?.type === "error") {
      sess.log(`codex transient: ${String(evt?.message ?? "").slice(0, 160)}`);
    }
    return { lines: [], ready: false };
  },
  // Codex resumes by uuid embedded in filename, just like claude.
  // The rollouts live under /root/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
  // Glob to find main's file, copy with a new uuid in the filename, exec
  // resume the new uuid, capture stdout, delete the clone.
  async forkAndAsk({ prompt, mainRef, cellName, timeoutMs = 90_000 }) {
    const flags = "--json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox";
    if (!mainRef) {
      // No main thread cached — start a fresh codex exec. No context.
      try {
        const r = await runProcess({
          cmd: [
            "bash", "-lc",
            `export HOME=/root; cd /root && exec codex exec ${flags} "$1"`,
            "codex-fork",
            prompt,
          ],
          timeoutMs,
        });
        if (r.exitCode !== 0) {
          return { ok: false, error: `codex (no-fork) exit ${r.exitCode}: ${r.stderr.slice(0, 200)}` };
        }
        const text = extractCodexJsonText(r.stdout);
        return text !== null
          ? { ok: true, text }
          : { ok: false, error: `codex emitted no agent_message; stderr: ${r.stderr.slice(0, 200)}` };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 200) };
      }
    }
    // Find the rollout file containing main's uuid suffix.
    const sessionsRoot = "/root/.codex/sessions";
    const srcPath = await findCodexRollout(sessionsRoot, mainRef);
    if (!srcPath) {
      return { ok: false, error: `codex rollout not found for thread ${mainRef}` };
    }
    void cellName;
    const forkId = crypto.randomUUID();
    // Same dir as the source for cache locality; codex picks up the file
    // by glob across the whole sessions tree.
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dstPath = join(srcPath.replace(/[^/]+$/, ""), `rollout-${ts}-${forkId}.jsonl`);
    try {
      await copyFile(srcPath, dstPath);
      const r = await runProcess({
        cmd: [
          "bash", "-lc",
          `export HOME=/root; cd /root && exec codex exec ${flags} resume "$1" "$2"`,
          "codex-fork",
          forkId,
          prompt,
        ],
        timeoutMs,
      });
      if (r.exitCode !== 0) {
        return { ok: false, error: `codex exit ${r.exitCode}: ${r.stderr.slice(0, 200)}` };
      }
      const text = extractCodexJsonText(r.stdout);
      return text !== null
        ? { ok: true, text }
        : { ok: false, error: `codex emitted no agent_message; stderr: ${r.stderr.slice(0, 200)}` };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    } finally {
      try { await rm(dstPath, { force: true }); } catch {}
    }
  },
};

// Locate the codex rollout file whose filename ends in <threadUuid>.jsonl.
// Scans /root/.codex/sessions/YYYY/MM/DD/ for the latest match.
async function findCodexRollout(root: string, threadUuid: string): Promise<string | null> {
  if (!existsSync(root)) return null;
  // Walk year/month/day depths. Bounded depth so this stays cheap.
  for (const year of (await readdir(root)).sort().reverse()) {
    const yDir = join(root, year);
    for (const month of (await readdir(yDir)).sort().reverse()) {
      const mDir = join(yDir, month);
      for (const day of (await readdir(mDir)).sort().reverse()) {
        const dDir = join(mDir, day);
        for (const file of await readdir(dDir)) {
          if (file.endsWith(`${threadUuid}.jsonl`)) return join(dDir, file);
        }
      }
    }
  }
  return null;
}

// `codex exec --json` emits JSONL on stdout. Find the latest
// item.completed event with item.type === "agent_message" and return its
// text. Returns null if no agent_message was emitted.
function extractCodexJsonText(stdout: string): string | null {
  let text: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    try {
      const evt = JSON.parse(line);
      if (
        evt?.type === "item.completed" &&
        evt?.item?.type === "agent_message" &&
        typeof evt?.item?.text === "string"
      ) {
        text = evt.item.text;
      }
    } catch { /* not JSON — skip */ }
  }
  return text;
}

export function getAdapter(harness: string): HarnessAdapter {
  if (harness === "claude-code") return claudeCodeAdapter;
  if (harness === "codex") return codexAdapter;
  return piAdapter;
}
