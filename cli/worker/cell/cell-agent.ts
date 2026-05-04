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
const ALARM_INTERVAL_MS = 25_000;
const FLUSH_INTERVAL_MS = 1100;        // chat.update rate-limit safe (~1Hz)
const IDLE_WINDOW_MS = 60_000;         // close WS and let sprite hibernate after 60s idle

type ToolCall = {
  id: string;
  name: string;
  arguments: any;
  result?: string;
  isError?: boolean;
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

  private scheduleFlush() {
    if (!this.currentTurn || this.currentTurn.ended) return;
    if (this.currentTurn.flushTimer != null) return;
    const now = Date.now();
    const delay = Math.max(0, this.currentTurn.lastFlushAt + FLUSH_INTERVAL_MS - now);
    this.currentTurn.flushTimer = setTimeout(() => {
      if (this.currentTurn) this.currentTurn.flushTimer = null;
      void this.flushSlack(false);
    }, delay) as unknown as number;
  }

  private async flushSlack(final: boolean): Promise<void> {
    const t = this.currentTurn;
    if (!t) return;
    t.lastFlushAt = Date.now();

    const text = renderTurn(t, final);

    try {
      if (!t.slackTs) {
        const res = await fetch(SLACK_SEND_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.env.CELLS_PROXY_SECRET}` },
          body: JSON.stringify({ cell: this.env.CELL_NAME, text, channel: t.channel, thread_ts: t.threadTs || undefined }),
        });
        if (!res.ok) { console.error(`[${this.env.CELL_NAME}] slack post failed ${res.status}: ${(await res.text()).slice(0, 200)}`); return; }
        const j: any = await res.json();
        t.slackTs = String(j?.ts ?? "");
      } else {
        const res = await fetch(SLACK_EDIT_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.env.CELLS_PROXY_SECRET}` },
          body: JSON.stringify({ cell: this.env.CELL_NAME, text, channel: t.channel, ts: t.slackTs }),
        });
        if (!res.ok) console.error(`[${this.env.CELL_NAME}] slack edit failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`[${this.env.CELL_NAME}] flush error: ${String(e).slice(0, 200)}`);
    }
  }
}

function renderTurn(t: TurnState, final: boolean): string {
  const parts: string[] = [];
  if (t.thinking.trim()) {
    parts.push("🧠 _thinking_");
    parts.push("> " + t.thinking.split("\n").join("\n> "));
  } else if (t.thinkingActive) {
    parts.push("🧠 _thinking…_");
  } else if (t.thinkingObserved) {
    // Reasoning happened but the provider didn't expose any text
    // (e.g. OpenAI-codex encrypts the chain-of-thought).
    parts.push("🧠 _reasoned silently_");
  }
  if (t.tools.length > 0) {
    // Tools as a single tight block, one line per call.
    parts.push(t.tools.map(formatToolLine).join("\n"));
  }
  if (t.text.trim()) {
    parts.push(t.text);
  }
  if (parts.length === 0) {
    return final ? "_(no response)_" : "…";
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

  let line = `🔧 *${tc.name}*`;
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
  return line + ` → ${truncate(resultText, 120)}`;
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
