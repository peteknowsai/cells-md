/**
 * CellAgent — per-cell Durable Object.
 *
 * Holds a persistent outbound WebSocket to the sprite's site server at
 * wss://${SPRITE_HOST}/agent. That inbound TCP keeps the sprite warm
 * continuously. Same connection serves as the bidirectional bridge:
 *
 *   - DO → sprite:  pi RPC commands ({type:"prompt"}, {type:"switch_session"})
 *   - sprite → DO:  pi RPC events (agent_start, message_update, agent_end, …)
 *
 * For each pi turn, the DO maintains one Slack message that it edits
 * as events arrive. agent_start posts the initial message; deltas are
 * accumulated and flushed at ~1Hz via chat.update; agent_end finalizes.
 *
 * No tool calls required of pi. The DO renders whatever pi emits into
 * Slack-mrkdwn and ships it.
 *
 * Liveness: a 25s alarm checks the WS, reconnects if dead, and pings
 * the sprite. Each reconnect is also activity that keeps the sprite
 * warm if it had drifted.
 */

interface Env {
  CELL_NAME: string;
  SPRITE_HOST: string;
  CELLS_PROXY_SECRET: string;
  CELL_AGENT: DurableObjectNamespace;
}

const SLACK_SEND_URL = "https://slack.cells.md/send";
const SLACK_EDIT_URL = "https://slack.cells.md/edit";
const SLACK_REPLY_URL = "https://slack.cells.md/reply";
const ALARM_INTERVAL_MS = 25_000;
// Default flush cadence. Slack documents 1/sec/message but tolerates
// faster bursts; we honor 429 + Retry-After dynamically below to back
// off without hard-capping at 1Hz.
const FLUSH_INTERVAL_MS = 400;
const FLUSH_BACKOFF_DECAY_MS = 60_000; // decay 429 backoff after 60s clean
const FLUSH_BACKOFF_CAP_MS = 5_000;
const IDLE_WINDOW_MS = 60_000;         // close WS and let sprite hibernate after 60s idle
// Slack enforces 40,000 chars on chat.postMessage and chat.update; we
// cap our rendered chunks at 35k to leave headroom for the
// "…continued ↓" footer + a small streaming delta between flushes.
const SLACK_MSG_CAP = 35_000;
const SLACK_CONTINUE_FOOTER = "\n\n_…continued ↓_";
// Tool results above this length get a thread reply with the full text;
// the inline tool line shows the first TOOL_PREVIEW_CAP chars + a
// "see thread" pointer.
const TOOL_PREVIEW_CAP = 1000;

type ToolCall = {
  id: string;
  name: string;
  arguments: any;
  result?: string;
  isError?: boolean;
  // ts of the thread reply holding the full result, set once on
  // tool_execution_end if the unwrapped result exceeds TOOL_PREVIEW_CAP.
  threadTs?: string;
};

type TurnState = {
  channel: string;
  threadTs: string;
  slackTs: string | null;        // ts of the live Slack message we're editing
  thinking: string;
  thinkingActive: boolean;       // true between thinking_start and thinking_end
  thinkingObserved: boolean;     // true if any thinking event fired this turn
  text: string;
  tools: ToolCall[];
  flushTimer: number | null;
  lastFlushAt: number;
  ended: boolean;
  disconnected: boolean;         // bridge WS dropped mid-turn — append a footer on final flush
  // Continuation thread replies in order, posted under slackTs when the
  // rendered text exceeds SLACK_MSG_CAP. Each entry holds the ts of the
  // continuation message and the chunk we last wrote to it (used so we
  // can chat.update it as more text streams in).
  overflow: { ts: string; text: string }[];
};

export class CellAgent {
  private state: DurableObjectState;
  private env: Env;
  private ws: WebSocket | null = null;
  private wsConnecting = false;
  private currentTurn: TurnState | null = null;
  // Pending prompt sent before agent_start arrives — used to seed turn channel
  private pendingChannel = "";
  private pendingThreadTs = "";
  // Last in-memory activity timestamp. Persisted via storage on every bump
  // so the alarm (which may run in a separate invocation) can read it.
  private lastActivity = 0;
  // Slack 429 self-heal. flushBackoffMs replaces FLUSH_INTERVAL_MS while
  // active; decays back when no 429 has been seen for FLUSH_BACKOFF_DECAY_MS.
  private flushBackoffMs = FLUSH_INTERVAL_MS;
  private last429At = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async bumpActivity() {
    this.lastActivity = Date.now();
    await this.state.storage.put("lastActivity", this.lastActivity);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/append") return this.handleAppend(req);
    if (req.method === "GET" && url.pathname === "/debug") return this.handleDebug();
    return new Response("not found", { status: 404 });
  }

  // ---- alarm-driven liveness ----

  async alarm() {
    const last = (await this.state.storage.get<number>("lastActivity")) ?? 0;
    const idleFor = Date.now() - last;
    const midTurn = this.currentTurn !== null && !this.currentTurn.ended;
    if (idleFor > IDLE_WINDOW_MS && !midTurn) {
      // Idle long enough AND no turn in flight — close the WS and stop
      // the alarm chain so the sprite is allowed to hibernate. The next
      // /append will reopen.
      console.log(`[${this.env.CELL_NAME}] idle ${Math.round(idleFor / 1000)}s, closing ws so sprite can hibernate`);
      try { this.ws?.close(1000, "idle"); } catch {}
      this.ws = null;
      return;
    }
    try {
      await this.ensureConnection();
    } catch (e) {
      console.error(`[${this.env.CELL_NAME}] alarm reconnect error: ${String(e).slice(0, 200)}`);
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: "ping" })); } catch {}
    }
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  // ---- inbound from cell Worker /inbox/append ----

  private async handleAppend(req: Request): Promise<Response> {
    let body: any;
    try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

    const event = body?.event ?? {};
    const channel = String(event.channel ?? "");
    const user = String(event.user ?? "");
    const threadTs = String(event.thread_ts ?? "");
    const text = String(event.text ?? "").replace(/[\r\n]+/g, " ");
    const message = `from-slack channel=${channel}${user ? ` user=${user}` : ""}${threadTs ? ` thread=${threadTs}` : ""} text=${text}`;

    this.pendingChannel = channel;
    this.pendingThreadTs = threadTs;
    await this.bumpActivity();

    await this.ensureConnection();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error(`[${this.env.CELL_NAME}] ws not connected, dropping prompt`);
      return new Response("ws not connected", { status: 503 });
    }
    this.ws.send(JSON.stringify({
      type: "prompt",
      message,
      streamingBehavior: "steer",
    }));

    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }

    return new Response(null, { status: 202 });
  }

  private handleDebug(): Response {
    return Response.json({
      cell: this.env.CELL_NAME,
      sprite: this.env.SPRITE_HOST,
      wsState: this.ws ? this.ws.readyState : null,
      turn: this.currentTurn ? {
        channel: this.currentTurn.channel,
        slackTs: this.currentTurn.slackTs,
        textLen: this.currentTurn.text.length,
        thinkingLen: this.currentTurn.thinking.length,
        tools: this.currentTurn.tools.length,
        ended: this.currentTurn.ended,
      } : null,
    });
  }

  // ---- WebSocket to sprite ----

  private async ensureConnection(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.wsConnecting) return;
    this.wsConnecting = true;
    try {
      const url = `https://${this.env.SPRITE_HOST}/agent`;
      const resp = await fetch(url, {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${this.env.CELLS_PROXY_SECRET}`,
        },
      });
      if (resp.status !== 101 || !resp.webSocket) {
        console.error(`[${this.env.CELL_NAME}] ws upgrade failed: ${resp.status}`);
        return;
      }
      const ws = resp.webSocket;
      ws.accept();
      ws.addEventListener("message", (ev: any) => {
        const data = typeof ev.data === "string" ? ev.data : "";
        if (!data) return;
        for (const raw of data.split("\n")) {
          const line = raw.trim();
          if (!line) continue;
          this.onPiEvent(line);
        }
      });
      ws.addEventListener("close", () => {
        console.log(`[${this.env.CELL_NAME}] ws closed`);
        if (this.ws === ws) this.ws = null;
        // If a turn was streaming when the WS dropped, the user sees a
        // frozen Slack message with no clue why. Finalize it with a
        // footer so they know to retry. Pi's session continuity is
        // preserved on the sprite — the next /append starts a clean
        // new turn.
        const t = this.currentTurn;
        if (t && !t.ended) {
          t.disconnected = true;
          t.ended = true;
          if (t.flushTimer != null) {
            clearTimeout(t.flushTimer);
            t.flushTimer = null;
          }
          void this.flushSlack(true);
        }
      });
      ws.addEventListener("error", (e: any) => {
        console.error(`[${this.env.CELL_NAME}] ws error: ${String(e).slice(0, 120)}`);
      });
      this.ws = ws;
      console.log(`[${this.env.CELL_NAME}] ws connected to ${this.env.SPRITE_HOST}`);
    } finally {
      this.wsConnecting = false;
    }
  }

  // ---- pi RPC event handling ----

  private onPiEvent(line: string) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    const type = ev?.type;

    if (type === "bridge_hello" || type === "pong" || type === "response") return;

    // Any pi event counts as activity — extends the idle window so a long
    // turn doesn't get cut off mid-flight.
    void this.bumpActivity();

    if (type === "agent_start") {
      this.startTurn();
      return;
    }
    if (type === "agent_end") {
      this.endTurn();
      return;
    }
    if (!this.currentTurn) return;

    if (type === "message_update") {
      const ame = ev.assistantMessageEvent;
      if (!ame) return;
      if (ame.type === "text_delta" && typeof ame.delta === "string") {
        this.currentTurn.text += ame.delta;
        this.scheduleFlush();
      } else if (ame.type === "thinking_start") {
        this.currentTurn.thinkingActive = true;
        this.currentTurn.thinkingObserved = true;
        this.scheduleFlush();
      } else if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
        this.currentTurn.thinking += ame.delta;
        this.scheduleFlush();
      } else if (ame.type === "thinking_end") {
        // Anthropic streams thinking_delta tokens; OpenAI-codex-style reasoning
        // skips deltas and only provides the full content on thinking_end.
        // If we never accumulated any deltas, take the final content here.
        if (typeof ame.content === "string" && !this.currentTurn.thinking.trim()) {
          this.currentTurn.thinking = ame.content;
        }
        this.currentTurn.thinkingActive = false;
        this.scheduleFlush();
      } else if (ame.type === "toolcall_end" && ame.toolCall) {
        const tc = ame.toolCall;
        this.currentTurn.tools.push({
          id: String(tc.id ?? ""),
          name: String(tc.name ?? "?"),
          arguments: tc.arguments,
        });
        this.scheduleFlush();
      }
      return;
    }
    if (type === "tool_execution_end") {
      const tc = this.currentTurn.tools.find(t => t.id === String(ev.toolCallId ?? ""));
      if (tc) {
        tc.result = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result ?? "");
        tc.isError = !!ev.isError;
        // The full-result thread post happens inside flushSlack, after
        // the parent message exists — that way we don't post a thread
        // reply with no parent to attach to.
        this.scheduleFlush();
      }
      return;
    }
    if (type === "auto_retry_start") {
      this.currentTurn.text += `\n_(retrying after error: ${String(ev.error ?? "").slice(0, 100)})_\n`;
      this.scheduleFlush();
      return;
    }
  }

  private startTurn() {
    if (this.currentTurn && !this.currentTurn.ended) this.endTurn();

    this.currentTurn = {
      channel: this.pendingChannel,
      threadTs: this.pendingThreadTs,
      slackTs: null,
      thinking: "",
      thinkingActive: false,
      thinkingObserved: false,
      text: "",
      tools: [],
      flushTimer: null,
      lastFlushAt: 0,
      ended: false,
      disconnected: false,
      overflow: [],
    };
    void this.flushSlack(false);
  }

  private endTurn() {
    if (!this.currentTurn) return;
    this.currentTurn.ended = true;
    if (this.currentTurn.flushTimer != null) {
      clearTimeout(this.currentTurn.flushTimer);
      this.currentTurn.flushTimer = null;
    }
    void this.flushSlack(true);
  }

  // ---- Slack rendering & emission ----

  private currentFlushInterval(): number {
    // Decay backoff after a clean window with no 429s.
    if (this.flushBackoffMs > FLUSH_INTERVAL_MS &&
        Date.now() - this.last429At > FLUSH_BACKOFF_DECAY_MS) {
      this.flushBackoffMs = FLUSH_INTERVAL_MS;
    }
    return this.flushBackoffMs;
  }

  private scheduleFlush() {
    if (!this.currentTurn || this.currentTurn.ended) return;
    if (this.currentTurn.flushTimer != null) return;
    const now = Date.now();
    const delay = Math.max(0, this.currentTurn.lastFlushAt + this.currentFlushInterval() - now);
    this.currentTurn.flushTimer = setTimeout(() => {
      if (this.currentTurn) this.currentTurn.flushTimer = null;
      void this.flushSlack(false);
    }, delay) as unknown as number;
  }

  // Read Slack's Retry-After (seconds) and arm an in-memory backoff so
  // scheduleFlush stretches subsequent edits. Caps at FLUSH_BACKOFF_CAP_MS
  // — any longer and we'd visibly stall the user, better to risk a few
  // more 429s while pi is still mid-turn.
  private noteRateLimit(retryAfterHeader: string | null) {
    const seconds = Number(retryAfterHeader ?? "1");
    const ms = Math.min(
      Math.max(Number.isFinite(seconds) ? seconds * 1000 : 1000, 1000),
      FLUSH_BACKOFF_CAP_MS,
    );
    this.flushBackoffMs = Math.max(this.flushBackoffMs, ms);
    this.last429At = Date.now();
  }

  private async flushSlack(final: boolean): Promise<void> {
    const t = this.currentTurn;
    if (!t) return;
    t.lastFlushAt = Date.now();

    const fullText = renderTurn(t, final);
    // Split into chunks each <= SLACK_MSG_CAP. Index 0 is the parent
    // message body; indexes 1+ map onto t.overflow[0..]. All chunks
    // except the last get a "_…continued ↓_" footer.
    const chunks = splitForCap(fullText, SLACK_MSG_CAP);

    try {
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const chunkText = isLast ? chunks[i] : chunks[i] + SLACK_CONTINUE_FOOTER;

        if (i === 0) {
          if (await this.postOrEditParent(t, chunkText)) continue;
          return; // 429 or upstream failure — abort this flush
        }

        const overflowIdx = i - 1;
        if (overflowIdx < t.overflow.length) {
          // Existing continuation — edit it.
          if (chunkText === t.overflow[overflowIdx].text) continue; // unchanged, skip
          const ok = await this.postSlackEdit(t.channel, t.overflow[overflowIdx].ts, chunkText);
          if (!ok) return;
          t.overflow[overflowIdx].text = chunkText;
        } else {
          // New continuation — post into the thread under the parent.
          if (!t.slackTs) return; // shouldn't happen: parent posted above
          const ts = await this.postSlackReply(t.channel, t.slackTs, chunkText);
          if (!ts) return;
          t.overflow.push({ ts, text: chunkText });
        }
      }

      // Post full-result thread replies for tools whose unwrapped result
      // exceeds TOOL_PREVIEW_CAP. Idempotent via tc.threadTs guard. Done
      // after parent/overflow so we know slackTs exists.
      if (t.slackTs) {
        for (const tc of t.tools) {
          if (tc.threadTs || !tc.result) continue;
          const full = unwrapResult(tc.result);
          if (full.length <= TOOL_PREVIEW_CAP) continue;
          const body = "```\n" + full + "\n```";
          // Bodies bigger than the per-message cap get split too — same
          // chunker as the main render path. The first chunk seeds
          // tc.threadTs; further chunks ride along under the same parent.
          const chunks = splitForCap(body, SLACK_MSG_CAP);
          let firstTs: string | null = null;
          for (const chunk of chunks) {
            const ts = await this.postSlackReply(t.channel, t.slackTs, chunk);
            if (!ts) break;
            if (!firstTs) firstTs = ts;
          }
          if (firstTs) tc.threadTs = firstTs;
        }
      }
    } catch (e) {
      console.error(`[${this.env.CELL_NAME}] flush error: ${String(e).slice(0, 200)}`);
    }
  }

  // Post the parent message (first time) or chat.update it. Returns true
  // on success, false on 429 or upstream failure (caller bails).
  private async postOrEditParent(t: TurnState, text: string): Promise<boolean> {
    if (!t.slackTs) {
      const res = await fetch(SLACK_SEND_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.env.CELLS_PROXY_SECRET}` },
        body: JSON.stringify({ cell: this.env.CELL_NAME, text, channel: t.channel, thread_ts: t.threadTs || undefined }),
      });
      if (res.status === 429) { this.noteRateLimit(res.headers.get("retry-after")); return false; }
      if (!res.ok) { console.error(`[${this.env.CELL_NAME}] slack post failed ${res.status}: ${(await res.text()).slice(0, 200)}`); return false; }
      const j: any = await res.json();
      t.slackTs = String(j?.ts ?? "");
      return true;
    }
    return this.postSlackEdit(t.channel, t.slackTs, text);
  }

  private async postSlackEdit(channel: string, ts: string, text: string): Promise<boolean> {
    const res = await fetch(SLACK_EDIT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.env.CELLS_PROXY_SECRET}` },
      body: JSON.stringify({ cell: this.env.CELL_NAME, text, channel, ts }),
    });
    if (res.status === 429) { this.noteRateLimit(res.headers.get("retry-after")); return false; }
    if (!res.ok) {
      console.error(`[${this.env.CELL_NAME}] slack edit failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  }

  // Post a thread reply under the parent message. Returns the new ts on
  // success, null on 429 or upstream failure.
  private async postSlackReply(channel: string, parentTs: string, text: string): Promise<string | null> {
    const res = await fetch(SLACK_REPLY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.env.CELLS_PROXY_SECRET}` },
      body: JSON.stringify({ cell: this.env.CELL_NAME, text, channel, thread_ts: parentTs }),
    });
    if (res.status === 429) { this.noteRateLimit(res.headers.get("retry-after")); return null; }
    if (!res.ok) {
      console.error(`[${this.env.CELL_NAME}] slack reply failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const j: any = await res.json();
    const ts = String(j?.ts ?? "");
    return ts || null;
  }
}

// Split text into chunks each <= cap. Prefer to break on the last
// "\n\n" boundary at or before cap; if no boundary in the last 5k of
// the cap window, hard-slice at cap to avoid pathological spillover.
function splitForCap(text: string, cap: number): string[] {
  if (text.length <= cap) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > cap) {
    const window = remaining.slice(0, cap);
    const boundary = window.lastIndexOf("\n\n");
    const cut = boundary >= cap - 5000 ? boundary : cap;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function renderTurn(t: TurnState, final: boolean): string {
  const parts: string[] = [];
  if (t.thinking.trim()) {
    parts.push("🧠 *thinking*");
    parts.push("> " + t.thinking.split("\n").join("\n> "));
  } else if (t.thinkingActive) {
    parts.push("🧠 *thinking…*");
  } else if (t.thinkingObserved) {
    parts.push("🧠 *reasoned silently*");
  }
  if (t.tools.length > 0) {
    parts.push(t.tools.map(formatToolLine).join("\n"));
  }
  if (t.text.trim()) {
    parts.push(t.text);
  }
  if (parts.length === 0) {
    if (t.disconnected) return "_⚠ connection lost — pi is still working; next message will start fresh_";
    return final ? "*(no response)*" : "…";
  }
  if (t.disconnected) {
    parts.push("_⚠ connection lost — pi is still working; next message will start fresh_");
  }
  return parts.join("\n\n");
}

// One-line summary of a tool call. Tool-specific arg surfacing where it
// helps; generic fallback otherwise. Results unwrap the common
// {"content":[{"type":"text","text":"…"}]} envelope and inline a short
// preview (or just ✓ / ✗ if the result echoes the args).
function formatToolLine(tc: ToolCall): string {
  const args = (tc.arguments && typeof tc.arguments === "object") ? tc.arguments as Record<string, any> : {};
  const argSummary = summarizeArgs(tc.name, args);

  let line = `🔧 **${tc.name}**`;
  if (argSummary) line += ` \`${argSummary}\``;

  if (tc.result === undefined) return line; // still in flight

  const resultText = unwrapResult(tc.result);
  if (tc.isError) {
    return line + (resultText ? ` ✗ ${truncate(resultText, 120)}` : " ✗");
  }
  if (!resultText) return line + " ✓";

  // If the result just echoes the arg summary (e.g. "wrote foo.md" after
  // write_memory(foo.md)), collapse to a check.
  if (argSummary && resultText.toLowerCase().includes(argSummary.toLowerCase())) {
    return line + " ✓";
  }
  // Long results: show a short preview inline + pointer to the thread
  // reply with the full text (posted by flushSlack). If the thread post
  // hasn't landed yet, fall back to the longer truncated form.
  if (resultText.length > TOOL_PREVIEW_CAP) {
    const preview = truncate(resultText, TOOL_PREVIEW_CAP);
    if (tc.threadTs) {
      return line + ` → ${preview} _↳ ${formatBytes(resultText.length)} (see thread)_`;
    }
    return line + ` → ${preview}`;
  }
  return line + ` → ${resultText.replace(/\n+/g, " ")}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function summarizeArgs(toolName: string, args: Record<string, any>): string {
  const pickStr = (k: string) => typeof args[k] === "string" ? args[k] : "";
  switch (toolName) {
    case "write_memory":
    case "write_yearning":
    case "read_memory":
      return pickStr("name");
    case "write_file":
    case "read_file":
    case "edit_file":
      return pickStr("path") || pickStr("file_path");
    case "bash":
    case "shell":
      return pickStr("command");
    case "web_search":
    case "code_search":
      return pickStr("query");
    case "fetch_content":
    case "get_search_content":
      return pickStr("url") || pickStr("query");
    case "slack_post":
    case "slack_react":
      return pickStr("text") || pickStr("name");
    default: {
      // Generic: first string value, or {N keys} placeholder.
      const firstStr = Object.values(args).find(v => typeof v === "string");
      if (firstStr) return String(firstStr);
      const n = Object.keys(args).length;
      return n > 0 ? `{${n} arg${n === 1 ? "" : "s"}}` : "";
    }
  }
}

// Pull text out of the standard pi tool-result envelope. Falls back to
// the raw string if it doesn't match the shape.
function unwrapResult(raw: string): string {
  if (!raw) return "";
  try {
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.content)) {
      const texts = obj.content
        .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text);
      if (texts.length) return texts.join("\n").trim();
    }
    if (typeof obj === "string") return obj.trim();
  } catch {
    /* not JSON */
  }
  return raw.trim();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s.replace(/\n+/g, " ");
  return s.slice(0, n).replace(/\n+/g, " ") + "…";
}
