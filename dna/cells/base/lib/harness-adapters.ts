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
 * Both callers (Mac-side host-bridge for `cells talk`, cell-side site
 * server for Slack/email) implement AdapterHost. The adapter file imports
 * nothing concrete — it's a pure shapes/string module.
 */

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
    // --resume binds talk to the birth-time scratch session id. The shell
    // builds an ARGS array so an empty/missing cache file doesn't inject a
    // dangling `--resume` argv. Falls through to a fresh session if missing.
    return (
      `exec sudo bash -lc 'export HOME=/root IS_SANDBOX=1; cd /root && ` +
      `RESUME=""; [ -s /root/.cell/claude-talk-session ] && RESUME="--resume $(cat /root/.cell/claude-talk-session)"; ` +
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
    // birth-time scratch cache (/root/.cell/codex-talk-thread) → fresh
    // thread. Reading the cache in the remote shell avoids a separate SSH.
    const run = sess.codexThreadId
      ? `exec codex exec resume ${sess.codexThreadId} ${flags} "$1" </dev/null`
      : `if [ -s /root/.cell/codex-talk-thread ]; then exec codex exec resume "$(cat /root/.cell/codex-talk-thread)" ${flags} "$1" </dev/null; else exec codex exec ${flags} "$1" </dev/null; fi`;
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
};

export function getAdapter(harness: string): HarnessAdapter {
  if (harness === "claude-code") return claudeCodeAdapter;
  if (harness === "codex") return codexAdapter;
  return piAdapter;
}
