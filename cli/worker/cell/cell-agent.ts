/**
 * CellAgent — per-cell Durable Object.
 *
 * Holds the bridge WebSocket to the cell's well. Post-direction-flip
 * (2026-05-22) the well's supervisor dials IN to wss://<cell>.cells.md/agent
 * and this DO accepts the connection; before the flip the DO dialed out to
 * the well. Either way the connection is the bidirectional bridge:
 *
 *   - DO → well:  pi RPC commands ({type:"prompt"}, {type:"switch_session"})
 *   - well → DO:  pi RPC events (agent_start, message_update, agent_end, …)
 *
 * A hibernating cell holds no connection. When a message arrives for a
 * sleeping cell the DO rings the doorbell (proxy.cells.md/wake), queues the
 * frame, and flushes the queue once the supervisor dials back in.
 *
 * For each pi turn, the DO maintains one Slack message that it edits
 * as events arrive. agent_start posts the initial message; deltas are
 * accumulated and flushed at ~1Hz via chat.update; agent_end finalizes.
 *
 * No tool calls required of pi. The DO renders whatever pi emits into
 * Slack-mrkdwn and ships it.
 *
 * The bridge WS uses the Cloudflare WebSocket Hibernation API
 * (state.acceptWebSocket), so the DO can be evicted from memory during
 * idle stretches — between turns, and through the long forkAndAsk wait an
 * agent_message triggers — while the socket stays open. Everything that
 * must outlive an eviction (currentTurn, the wsQueue, the agent-fork reply
 * map, pending-turn context) lives in a single PersistedState snapshot:
 * ensureLoaded() rehydrates it, persist() mirrors every mutation back. A
 * 25s alarm runs only while a final Slack/email delivery is stranded.
 */

import { gateHtml } from "../../shared/clerk-gate";
import {
  validateEnvelope,
  isExpired,
  MAX_HOPS,
  ulid,
  sortedThreadId,
  type AgentEnvelope,
} from "../../shared/agent-envelope";

interface Env {
  CELL_NAME: string;
  CELLS_PROXY_SECRET: string;
  CELL_AGENT: DurableObjectNamespace;
  // Clerk publishable key — embedded in the served HTML so the Clerk
  // widget can bootstrap client-side. Optional: if absent, the DO skips
  // widget injection and the site looks exactly like it did pre-Clerk.
  CLERK_PUBLISHABLE_KEY?: string;
}

const SLACK_SEND_URL = "https://slack.cells.md/send";
const SLACK_EDIT_URL = "https://slack.cells.md/edit";
const SLACK_REPLY_URL = "https://slack.cells.md/reply";
// Email twin. One-shot send per turn — no streaming edits, no thread
// replies for tool overflow (the cell-agent skips both branches when
// channelKind === "email").
const EMAIL_SEND_URL = "https://email.cells.md/send";
const ALARM_INTERVAL_MS = 25_000;
// Default flush cadence. Slack documents 1/sec/message but tolerates
// faster bursts; we honor 429 + Retry-After dynamically below to back
// off without hard-capping at 1Hz.
const FLUSH_INTERVAL_MS = 400;
const FLUSH_BACKOFF_DECAY_MS = 60_000; // decay 429 backoff after 60s clean
const FLUSH_BACKOFF_CAP_MS = 5_000;
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

type ChannelKind = "slack" | "email";

// A single file in the cell's published site snapshot. `data` is base64
// — uniform for text and binary; DO storage caps a value at 128 KiB.
type SiteFile = { ct: string; data: string };
// Index of the current snapshot: what's published and when.
type SiteMeta = { paths: string[]; publishedAt: number };

type TurnState = {
  channel: string;
  threadTs: string;
  // Discriminator chosen at agent_start from the inbound event.kind. Drives
  // whether the final render fans out to slack.cells.md/{send,edit,reply}
  // or email.cells.md/send.
  kind: ChannelKind;
  // Email-only context, captured from the inbound event so the final
  // flush can build a reply with proper In-Reply-To / Subject. Empty for
  // slack turns.
  emailTo: string;
  emailMsgId: string;
  emailSubject: string;
  emailSent: boolean;            // email is one-shot — guard so a re-flush doesn't double-send
  slackTs: string | null;        // ts of the live Slack message we're editing
  thinking: string;
  thinkingActive: boolean;       // true between thinking_start and thinking_end
  thinkingObserved: boolean;     // true if any thinking event fired this turn
  text: string;
  tools: ToolCall[];
  flushTimer: number | null;
  lastFlushAt: number;
  ended: boolean;
  // Set when the final flush failed (429s, upstream errors). The alarm
  // re-runs flushSlack/flushEmail on each fire while this is true; clears
  // on confirmed delivery, at which point the keep-warm chain can stop.
  pendingDelivery: boolean;
  disconnected: boolean;         // bridge WS dropped mid-turn — append a footer on final flush
  // Continuation thread replies in order, posted under slackTs when the
  // rendered text exceeds SLACK_MSG_CAP. Each entry holds the ts of the
  // continuation message and the chunk we last wrote to it (used so we
  // can chat.update it as more text streams in).
  overflow: { ts: string; text: string }[];
};

// Everything the DO carries between events. The bridge WS uses the
// Cloudflare Hibernation API (state.acceptWebSocket) so the DO can be
// evicted from memory during idle stretches — between turns, and during
// the long forkAndAsk wait an agent_message triggers. Anything that must
// survive that eviction lives in this snapshot, persisted to
// state.storage under DO_STATE_KEY and reloaded on the next event.
type PersistedState = {
  pendingChannel: string;
  pendingThreadTs: string;
  pendingKind: ChannelKind;
  pendingEmailTo: string;
  pendingEmailMsgId: string;
  pendingEmailSubject: string;
  // Frames buffered while no bridge WS is up (cell hibernating); flushed
  // in order when the supervisor dials in.
  wsQueue: string[];
  // Outstanding agent forks: corr_id → reply context. Populated when an
  // inbound kind:"agent" arrives and we hand it to the supervisor; drained
  // when the supervisor's agent_response matches. Stored as entries since
  // a Map doesn't survive JSON.
  agentForks: [string, { reply_to: string; from: string; thread_id: string }][];
  flushBackoffMs: number;
  last429At: number;
};

// The small cross-event snapshot lives under one key; currentTurn gets its
// own key because a turn with large tool output can grow past DO storage's
// 128 KiB per-value cap. TURN_PERSIST_CAP leaves headroom under that.
const DO_STATE_KEY = "do-state";
const DO_TURN_KEY = "do-turn";
const TURN_PERSIST_CAP = 120 * 1024;

export class CellAgent {
  private state: DurableObjectState;
  private env: Env;
  // Dedup guard so a burst of inbound messages rings the doorbell once.
  // Request-scoped — fine to lose on eviction.
  private doorbellInFlight = false;
  // Hydrated from storage on first use (loaded === true thereafter). After a
  // hibernation eviction the DO is recreated, loaded resets to false, and
  // the next entry point reloads the snapshot.
  private loaded = false;
  private currentTurn: TurnState | null = null;
  private pendingChannel = "";
  private pendingThreadTs = "";
  private pendingKind: ChannelKind = "slack";
  private pendingEmailTo = "";
  private pendingEmailMsgId = "";
  private pendingEmailSubject = "";
  private wsQueue: string[] = [];
  private flushBackoffMs = FLUSH_INTERVAL_MS;
  private last429At = 0;
  private pendingAgentForks: Map<string, { reply_to: string; from: string; thread_id: string }> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // Hydrate cross-event state from storage. Idempotent and cheap after the
  // first call — a warm DO keeps the in-memory copy authoritative (persist()
  // mirrors every mutation back), so we only hit storage once per lifetime.
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const [p, turn] = await Promise.all([
      this.state.storage.get<PersistedState>(DO_STATE_KEY),
      this.state.storage.get<TurnState>(DO_TURN_KEY),
    ]);
    if (turn) {
      this.currentTurn = turn;
      // A persisted setTimeout handle is meaningless after eviction — null
      // it so scheduleFlush re-arms on the next event.
      this.currentTurn.flushTimer = null;
    }
    if (!p) return;
    this.pendingChannel = p.pendingChannel ?? "";
    this.pendingThreadTs = p.pendingThreadTs ?? "";
    this.pendingKind = p.pendingKind ?? "slack";
    this.pendingEmailTo = p.pendingEmailTo ?? "";
    this.pendingEmailMsgId = p.pendingEmailMsgId ?? "";
    this.pendingEmailSubject = p.pendingEmailSubject ?? "";
    this.wsQueue = Array.isArray(p.wsQueue) ? p.wsQueue : [];
    this.pendingAgentForks = new Map(Array.isArray(p.agentForks) ? p.agentForks : []);
    this.flushBackoffMs = p.flushBackoffMs ?? FLUSH_INTERVAL_MS;
    this.last429At = p.last429At ?? 0;
  }

  // Mirror the in-memory snapshot to storage. Called after any handler that
  // mutates cross-event state, so a hibernation eviction loses nothing.
  // currentTurn rides its own key (it can grow large); if it would exceed
  // the per-value cap we drop the persisted copy — that single oversized
  // turn won't survive an eviction, but the turn finishes fine on a warm DO
  // and the rest of the snapshot stays durable.
  private async persist(): Promise<void> {
    const snap: PersistedState = {
      pendingChannel: this.pendingChannel,
      pendingThreadTs: this.pendingThreadTs,
      pendingKind: this.pendingKind,
      pendingEmailTo: this.pendingEmailTo,
      pendingEmailMsgId: this.pendingEmailMsgId,
      pendingEmailSubject: this.pendingEmailSubject,
      wsQueue: this.wsQueue,
      agentForks: [...this.pendingAgentForks.entries()],
      flushBackoffMs: this.flushBackoffMs,
      last429At: this.last429At,
    };
    const writes: Promise<unknown>[] = [this.state.storage.put(DO_STATE_KEY, snap)];
    if (this.currentTurn) {
      const turn = { ...this.currentTurn, flushTimer: null };
      if (JSON.stringify(turn).length <= TURN_PERSIST_CAP) {
        writes.push(this.state.storage.put(DO_TURN_KEY, turn));
      } else {
        console.warn(`[${this.env.CELL_NAME}] currentTurn over ${TURN_PERSIST_CAP}B — not persisting (won't survive eviction)`);
        writes.push(this.state.storage.delete(DO_TURN_KEY));
      }
    } else {
      writes.push(this.state.storage.delete(DO_TURN_KEY));
    }
    await Promise.all(writes);
  }

  // The bridge WS, retrieved from the hibernation manager. getWebSockets()
  // returns the live socket even after the DO was evicted and recreated —
  // there is exactly one per cell.
  private bridgeWs(): WebSocket | null {
    const all = this.state.getWebSockets();
    return all.length > 0 ? all[0]! : null;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/agent") return this.acceptBridge(req);
    if (req.method === "POST" && url.pathname === "/append") return this.handleAppend(req);
    if (req.method === "POST" && url.pathname === "/site-publish") return this.handleSitePublish(req);
    if (req.method === "GET" && url.pathname === "/debug") return this.handleDebug();
    // Public site serve — the worker names this route and passes the real
    // request path in x-site-path, so public traffic can never reach the
    // control-plane routes above.
    if (url.pathname === "/site-serve") {
      const signedIn = req.headers.get("x-signed-in") === "1";
      return this.serveSite(req.headers.get("x-site-path") ?? "/", signedIn);
    }
    return new Response("not found", { status: 404 });
  }

  // ---- alarm-driven delivery retry ----
  //
  // Post-flip the alarm has exactly one job: re-attempt a stranded final
  // Slack/email delivery. The bridge connection is the supervisor's
  // responsibility now (it dials in and reconnects on drop), and well
  // hibernation is welld's call — so the DO no longer reconnects, pings,
  // or idle-closes. endTurn arms this alarm only when delivery fails.

  async alarm() {
    await this.ensureLoaded();
    if (this.currentTurn?.pendingDelivery) {
      await this.retryPendingDelivery();
      if (this.currentTurn?.pendingDelivery) {
        // Still stranded — reschedule and try again next tick.
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }
    }
    await this.persist();
  }

  // ---- inbound from cell Worker /inbox/append ----

  private async handleAppend(req: Request): Promise<Response> {
    await this.ensureLoaded();
    let body: any;
    try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

    const event = body?.event ?? {};

    // Cells-to-cells agent comms. Sender POSTed a kind:"agent" envelope to
    // our /inbox/append. Routing depends on whether this is a new message
    // (no in_reply_to → forward to supervisor) or a reply to one of our
    // outgoing awaits (in_reply_to → match to a pending corr_id). Slack
    // and email continue through their existing path below.
    if (event.kind === "agent") {
      return this.handleAgentEnvelope(event);
    }

    const channel = String(event.channel ?? "");
    const user = String(event.user ?? "");
    const threadTs = String(event.thread_ts ?? "");
    // event.kind discriminates the front-door (slack default for back-compat;
    // "email" enables the email outbound path). New event fields:
    //   subject     — email subject line (empty for slack)
    //   recipient   — the cell's own address ("bob@cells.md") for email
    const kind: ChannelKind = event.kind === "email" ? "email" : "slack";
    const subject = String(event.subject ?? "");
    const recipient = String(event.recipient ?? "");
    // event.text may already include `[voice]: …` transcripts and
    // `[file: …]` markers appended by the slack worker's enrichment step.
    // Newlines need to survive — collapse only \r and avoid stripping \n.
    const text = String(event.text ?? "").replace(/\r/g, "");
    const message = kind === "email"
      ? `from-email from=${user}${recipient ? ` to=${recipient}` : ""}${subject ? ` subject=${subject}` : ""} text=${text}`
      : `from-slack channel=${channel}${user ? ` user=${user}` : ""}${threadTs ? ` thread=${threadTs}` : ""} text=${text}`;
    // Pi's RPC `prompt` accepts an optional `images: ImageContent[]`; the
    // slack worker base64-encodes image attachments and forwards them here.
    // Vision-capable cell models (Opus/Sonnet) handle them inline; nothing
    // to do at the cell-agent layer.
    const images = Array.isArray(body?.images) ? body.images : undefined;

    this.pendingChannel = channel;
    this.pendingThreadTs = threadTs;
    this.pendingKind = kind;
    this.pendingEmailTo = kind === "email" ? user : "";
    this.pendingEmailMsgId = kind === "email" ? threadTs : "";
    this.pendingEmailSubject = kind === "email" ? subject : "";

    // Send if the supervisor is connected; otherwise queue and ring the
    // doorbell — the cell is hibernating and welld will wake it, the
    // supervisor will dial in, and acceptBridge flushes the queue.
    await this.sendOrQueue(JSON.stringify({
      type: "prompt",
      message,
      ...(images && images.length ? { images } : {}),
      streamingBehavior: "steer",
    }));

    await this.persist();
    return new Response(null, { status: 202 });
  }

  // ---- inbound from cell Worker /inbox/append (kind:"agent") ----

  // Two routes from here:
  //   (1) in_reply_to is set → this is a reply to one of our outgoing awaits.
  //       Match to a pending corr_id (Phase 2 wires the corr_id→ws matcher;
  //       for now we log and 202).
  //   (2) in_reply_to is null → new inbound. Validate, hops-cap, forward to
  //       the supervisor via the existing WS as an `agent_message` frame.
  //       Supervisor will run fork-and-ask (Phase 1) and emit `agent_response`
  //       on the WS, which onPiEvent routes back to reply_to.
  private async handleAgentEnvelope(rawEvent: any): Promise<Response> {
    const v = validateEnvelope(rawEvent);
    if (!v.ok) {
      console.error(`[${this.env.CELL_NAME}] bad agent envelope: ${v.reason}`);
      return new Response(`bad envelope: ${v.reason}`, { status: 400 });
    }
    const env = v.env;

    if (env.hops > MAX_HOPS) {
      console.log(`[${this.env.CELL_NAME}] dropping agent envelope: hops=${env.hops} > ${MAX_HOPS}`);
      return new Response(null, { status: 200 });
    }
    // Re-enabled 2026-05-19 after fixing chrony makestep on wells VMs (cells
    // were hibernating, waking with stale RTC, and chrony defaults only
    // step at startup — they slewed forever on offsets >1s). bake-egg.sh
    // now appends `makestep 1.0 -1` to /etc/chrony/chrony.conf at birth.
    if (isExpired(env)) {
      console.log(`[${this.env.CELL_NAME}] dropping expired agent envelope corr=${env.corr_id.slice(0, 10)}`);
      return new Response(null, { status: 200 });
    }

    // (1) Reply path. Forward to the supervisor over the existing WS so
    // a waiting CLI (cells talk --await) can match by corr_id and unblock.
    // Best-effort: if the WS is down the CLI will time out cleanly.
    if (env.in_reply_to) {
      console.log(
        `[${this.env.CELL_NAME}] inbound agent_reply from=${env.from} in_reply_to=${env.in_reply_to.slice(0, 10)} text=${env.text.slice(0, 100).replace(/\n/g, " ")}`
      );
      await this.sendOrQueue(JSON.stringify({
        type: "agent_reply",
        in_reply_to: env.in_reply_to,
        from: env.from,
        text: env.text,
      }));
      await this.persist();
      return new Response(null, { status: 202 });
    }

    // (2) Inbound new agent message — forward to the supervisor.
    // The supervisor's response will arrive over the WS as agent_response;
    // onPiEvent looks up pendingAgentForks[corr_id] and POSTs to reply_to.
    if (env.reply_to) {
      this.pendingAgentForks.set(env.corr_id, {
        reply_to: env.reply_to,
        from: env.from,
        thread_id: env.thread_id,
      });
    }

    // The supervisor speaks pi's RPC vocabulary; agent_message is a new
    // frame type that bypasses the prompt path (different routing target).
    // Queue + doorbell if the cell is asleep — same as the prompt path.
    await this.sendOrQueue(JSON.stringify({
      type: "agent_message",
      from: env.from,
      corr_id: env.corr_id,
      thread_id: env.thread_id,
      target: env.target,
      hops: env.hops,
      text: env.text,
    }));

    await this.persist();
    return new Response(null, { status: 202 });
  }

  // POST our cell's response back to the sender's inbox/append. Called
  // from onPiEvent when the supervisor emits agent_response.
  private async forwardAgentResponse(corrId: string, text: string): Promise<void> {
    const pending = this.pendingAgentForks.get(corrId);
    if (!pending) {
      console.log(`[${this.env.CELL_NAME}] agent_response for unknown corr=${corrId.slice(0, 10)} — discarding`);
      return;
    }
    this.pendingAgentForks.delete(corrId);
    await this.persist();
    if (!pending.reply_to) return; // fire-and-forget — no callback to make

    const reply: AgentEnvelope = {
      kind: "agent",
      from: this.env.CELL_NAME,
      to: pending.from,
      corr_id: ulid(),
      thread_id: pending.thread_id || sortedThreadId(this.env.CELL_NAME, pending.from),
      target: "fork",
      reply_to: "",
      hops: 0,
      sent_at: new Date().toISOString(),
      expires_at: "",
      in_reply_to: corrId,
      text,
    };
    try {
      const res = await fetch(pending.reply_to, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.env.CELLS_PROXY_SECRET}`,
        },
        body: JSON.stringify({ event: reply }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.error(`[${this.env.CELL_NAME}] reply POST to ${pending.reply_to} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`[${this.env.CELL_NAME}] reply POST error: ${String(e).slice(0, 200)}`);
    }
  }

  private async handleDebug(): Promise<Response> {
    await this.ensureLoaded();
    const siteMeta = await this.state.storage.get<SiteMeta>("site:__meta__");
    const ws = this.bridgeWs();
    return Response.json({
      cell: this.env.CELL_NAME,
      wsState: ws ? ws.readyState : null,
      queued: this.wsQueue.length,
      site: siteMeta
        ? { files: siteMeta.paths.length, paths: siteMeta.paths, publishedAt: siteMeta.publishedAt }
        : null,
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

  // ---- site snapshot: stored here, served while the cell sleeps ----

  // The cell's site server pushes a full snapshot of its public/ dir.
  // A publish is a full replace, not a merge — old keys are cleared so
  // deletes propagate. Each file is { ct, data:base64 }; DO storage caps
  // a value at 128 KiB, so oversized files are skipped (reported back).
  private async handleSitePublish(req: Request): Promise<Response> {
    let body: any;
    try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
    const files = body?.files;
    if (!files || typeof files !== "object") {
      return new Response("missing files", { status: 400 });
    }

    const old = await this.state.storage.list({ prefix: "site:" });
    if (old.size > 0) await this.state.storage.delete([...old.keys()]);

    const stored: string[] = [];
    const skipped: string[] = [];
    for (const [rawPath, entry] of Object.entries(files)) {
      const path = normalizeSitePath(rawPath);
      const e = entry as any;
      const data = typeof e?.data === "string" ? e.data : "";
      const ct = (typeof e?.ct === "string" && e.ct) ? e.ct : "application/octet-stream";
      if (!path || !data || data.length > 128 * 1024) {
        skipped.push(String(rawPath));
        continue;
      }
      await this.state.storage.put(`site:${path}`, { ct, data } satisfies SiteFile);
      stored.push(path);
    }
    const meta: SiteMeta = { paths: stored, publishedAt: Date.now() };
    await this.state.storage.put("site:__meta__", meta);
    console.log(`[${this.env.CELL_NAME}] site publish: ${stored.length} file(s)` +
      (skipped.length ? `, ${skipped.length} skipped` : ""));
    return Response.json({ stored, skipped });
  }

  // Serve a path from the stored snapshot. "/" → "/index.html"; a missing
  // index when nothing was ever published returns a friendly placeholder
  // (not a 404) so a freshly-born cell's domain looks alive immediately.
  //
  // Clerk gating: every served HTML page gets two transforms via
  // HTMLRewriter — (1) when `signedIn` is false, all elements matching
  // `[data-private]` are stripped at the edge so private bytes never
  // reach an anonymous client; (2) when CLERK_PUBLISHABLE_KEY is set,
  // the Clerk widget snippet is injected before `</body>` so the
  // sign-in / user-button shows on every page. Non-HTML files (CSS,
  // images, JSON) pass through untouched — they're treated as already
  // public; private blobs should live inside data-private wrappers in
  // an HTML page, not as separate files.
  private async serveSite(rawPath: string, signedIn: boolean): Promise<Response> {
    const path = normalizeSitePath(rawPath) || "/index.html";
    let lookup = path === "/" ? "/index.html" : path;
    if (lookup.endsWith("/")) lookup += "index.html";

    let entry = await this.state.storage.get<SiteFile>(`site:${lookup}`);
    if (!entry && !lookup.includes(".")) {
      // Extensionless path — try it as a directory index.
      entry = await this.state.storage.get<SiteFile>(`site:${lookup}/index.html`);
    }
    if (!entry) {
      if (lookup === "/index.html") {
        const meta = await this.state.storage.get<SiteMeta>("site:__meta__");
        if (!meta || meta.paths.length === 0) {
          return this.maybeTransformHtml(
            new Response(sitePlaceholder(this.env.CELL_NAME), {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
            signedIn,
          );
        }
      }
      return new Response("not found", { status: 404 });
    }
    const response = new Response(base64ToBytes(entry.data), {
      headers: { "content-type": entry.ct },
    });
    return this.maybeTransformHtml(response, signedIn);
  }

  // Apply the Clerk-aware HTML transforms (strip data-private for anon,
  // inject widget). Non-HTML responses pass through. The shared helper
  // owns the rules — proxy.ts uses the same function for mother.cells.md
  // and pulse.cells.md.
  private maybeTransformHtml(response: Response, signedIn: boolean): Response {
    return gateHtml(response, {
      signedIn,
      publishableKey: this.env.CLERK_PUBLISHABLE_KEY,
    });
  }

  // ---- bridge WebSocket (inbound from the well's supervisor) ----

  // Accept the inbound bridge WS. The supervisor on the well dials
  // wss://<cell>.cells.md/agent (bearer-checked in index.ts before this is
  // reached). We complete the upgrade with a WebSocketPair and hand the
  // server end to the Hibernation API (state.acceptWebSocket) — the runtime
  // owns the socket and routes frames to webSocketMessage/Close/Error, so
  // the DO can be evicted from memory between events and recreated on the
  // next one. Queued frames (buffered while the cell slept) flush here.
  private async acceptBridge(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    await this.ensureLoaded();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    // Auto-answer the supervisor's heartbeat ping without un-hibernating
    // the DO — the runtime matches the exact frame and replies for us.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "pong" }),
      ),
    );
    // Replace any stale socket — a reconnecting supervisor must not leave
    // the DO holding two.
    for (const old of this.state.getWebSockets()) {
      if (old !== server) { try { old.close(1000, "replaced"); } catch {} }
    }

    // Flush frames queued while the cell was hibernating.
    if (this.wsQueue.length) {
      console.log(`[${this.env.CELL_NAME}] bridge connected — flushing ${this.wsQueue.length} queued frame(s)`);
      for (const frame of this.wsQueue) {
        try { server.send(frame); } catch (e) {
          console.error(`[${this.env.CELL_NAME}] queue flush send failed: ${String(e).slice(0, 120)}`);
        }
      }
      this.wsQueue = [];
      await this.persist();
    } else {
      console.log(`[${this.env.CELL_NAME}] bridge connected`);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Hibernation API handlers — the runtime calls these, even on a DO
  // instance recreated after eviction. ensureLoaded() rehydrates the
  // snapshot; persist() mirrors mutations back so the next eviction is safe.

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    await this.ensureLoaded();
    const data = typeof message === "string" ? message : "";
    if (data) {
      for (const raw of data.split("\n")) {
        const line = raw.trim();
        if (line) this.onPiEvent(line);
      }
    }
    await this.persist();
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    await this.ensureLoaded();
    console.log(`[${this.env.CELL_NAME}] bridge ws closed (${code})`);
    try { ws.close(code < 4000 ? code : 1000, "closed"); } catch {}
    // If a turn was streaming when the WS dropped, the user sees a frozen
    // Slack message with no clue why. Finalize it with a footer so they
    // know to retry. Pi's session continuity is preserved on the well —
    // the next /append starts a clean new turn.
    const t = this.currentTurn;
    if (t && !t.ended) {
      t.disconnected = true;
      t.ended = true;
      if (t.flushTimer != null) { clearTimeout(t.flushTimer); t.flushTimer = null; }
      if (t.kind === "email") await this.flushEmail();
      else await this.flushSlack(true);
    }
    await this.persist();
  }

  webSocketError(_ws: WebSocket, error: unknown) {
    console.error(`[${this.env.CELL_NAME}] bridge ws error: ${String(error).slice(0, 120)}`);
  }

  // Send a frame to the supervisor if connected; otherwise queue it and
  // ring the doorbell so welld wakes the cell and the supervisor dials in.
  private async sendOrQueue(frame: string): Promise<void> {
    const ws = this.bridgeWs();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(frame); return; }
      catch (e) { console.error(`[${this.env.CELL_NAME}] bridge send failed, queueing: ${String(e).slice(0, 120)}`); }
    }
    this.wsQueue.push(frame);
    await this.ringDoorbell();
  }

  // Ring proxy.cells.md/wake so welld wakes a hibernating cell. The
  // supervisor boots, dials wss://<cell>.cells.md/agent, and acceptBridge
  // flushes wsQueue. Deduped so a burst of inbound messages wakes once.
  private async ringDoorbell(): Promise<void> {
    if (this.doorbellInFlight) return;
    this.doorbellInFlight = true;
    try {
      const res = await fetch("https://proxy.cells.md/wake", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.env.CELLS_PROXY_SECRET}`,
        },
        body: JSON.stringify({ cell: this.env.CELL_NAME }),
        signal: AbortSignal.timeout(40_000),
      });
      if (!res.ok) {
        console.error(`[${this.env.CELL_NAME}] doorbell -> ${res.status}: ${(await res.text()).slice(0, 150)}`);
      } else {
        console.log(`[${this.env.CELL_NAME}] doorbell rang — supervisor will dial in`);
      }
    } catch (e) {
      console.error(`[${this.env.CELL_NAME}] doorbell failed: ${String(e).slice(0, 150)}`);
    } finally {
      this.doorbellInFlight = false;
    }
  }

  // ---- pi RPC event handling ----

  private onPiEvent(line: string) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    const type = ev?.type;

    if (type === "bridge_hello" || type === "pong" || type === "response") return;

    // agent_response — supervisor's reply to an agent_message we forwarded.
    // Look up the pending corr_id and POST a kind:"agent" envelope back to
    // the sender's reply_to. Does not touch turn state — main is untouched
    // for fork-targeted messages (Phase 1 enforces that on the supervisor).
    if (type === "agent_response") {
      const corrId = typeof ev.in_reply_to === "string" ? ev.in_reply_to : "";
      const text = typeof ev.text === "string" ? ev.text : "";
      if (corrId) void this.forwardAgentResponse(corrId, text);
      return;
    }

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
      kind: this.pendingKind,
      emailTo: this.pendingEmailTo,
      emailMsgId: this.pendingEmailMsgId,
      emailSubject: this.pendingEmailSubject,
      emailSent: false,
      slackTs: null,
      thinking: "",
      thinkingActive: false,
      thinkingObserved: false,
      text: "",
      tools: [],
      flushTimer: null,
      lastFlushAt: 0,
      ended: false,
      pendingDelivery: false,
      disconnected: false,
      overflow: [],
    };
    // Email turns don't pre-flush — they only emit on agent_end. Skipping
    // the speculative first flush avoids an empty placeholder send.
    if (this.currentTurn.kind === "slack") {
      void (async () => { await this.flushSlack(false); await this.persist(); })();
    }
  }

  private endTurn() {
    const t = this.currentTurn;
    if (!t) return;
    t.ended = true;
    if (t.flushTimer != null) {
      clearTimeout(t.flushTimer);
      t.flushTimer = null;
    }
    // Final delivery. Post-flip the DO does NOT close the bridge — the
    // supervisor owns the connection and well hibernation is welld's call.
    // The cell can hibernate (and this DO evict) while Slack/email delivery
    // is still being retried; the alarm chain handles those retries.
    void (async () => {
      const delivered = t.kind === "email"
        ? await this.flushEmail()
        : await this.flushSlack(true);
      // If a new turn arrived during the final flush, leave it be — the
      // alarm/persist below would clobber it. The new turn owns state now.
      if (this.currentTurn !== t) return;
      if (delivered) {
        // Clean exit — drop the alarm chain. handleAppend re-arms on next
        // inbound. Storing alarm=null cancels any scheduled fire.
        try { await this.state.storage.deleteAlarm(); } catch {}
      } else {
        // Delivery stranded (429s, upstream failure). Keep the alarm
        // running so retryPendingDelivery() fires on the next tick.
        t.pendingDelivery = true;
        const existing = await this.state.storage.getAlarm();
        if (existing === null) {
          await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
        }
      }
      await this.persist();
    })();
  }

  // Re-attempt the final flush from the alarm. Slack/email post helpers
  // are already idempotent on slackTs / emailSent, so a retry just re-edits
  // the parent and re-posts any missing thread replies.
  private async retryPendingDelivery(): Promise<void> {
    const t = this.currentTurn;
    if (!t || !t.pendingDelivery) return;
    const delivered = t.kind === "email"
      ? await this.flushEmail()
      : await this.flushSlack(true);
    if (delivered) {
      t.pendingDelivery = false;
    }
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
    // Email is one-shot — buffer everything until endTurn. No streaming
    // edits, no incremental thread replies. The flush at agent_end handles
    // the single send via flushEmail.
    if (this.currentTurn.kind === "email") return;
    if (this.currentTurn.flushTimer != null) return;
    const now = Date.now();
    const delay = Math.max(0, this.currentTurn.lastFlushAt + this.currentFlushInterval() - now);
    this.currentTurn.flushTimer = setTimeout(() => {
      if (this.currentTurn) this.currentTurn.flushTimer = null;
      void (async () => {
        await this.flushSlack(false);
        // flushSlack sets slackTs / overflow / lastFlushAt — persist so a
        // hibernation eviction doesn't lose the parent-message handle and
        // re-post a duplicate on the next flush.
        await this.persist();
      })();
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

  // Returns true iff every chunk + tool-thread reply landed cleanly. Caller
  // uses this on the final flush to decide whether to keep an alarm chain
  // running for retry.
  private async flushSlack(final: boolean): Promise<boolean> {
    const t = this.currentTurn;
    if (!t) return true;
    t.lastFlushAt = Date.now();

    const fullText = renderTurn(t, final);
    // Split into chunks each <= SLACK_MSG_CAP. Index 0 is the parent
    // message body; indexes 1+ map onto t.overflow[0..]. All chunks
    // except the last get a "_…continued ↓_" footer.
    const chunks = splitForCap(fullText, SLACK_MSG_CAP);

    try {
      for (const [i, chunk] of chunks.entries()) {
        const isLast = i === chunks.length - 1;
        const chunkText = isLast ? chunk : chunk + SLACK_CONTINUE_FOOTER;

        if (i === 0) {
          if (await this.postOrEditParent(t, chunkText)) continue;
          return false; // 429 or upstream failure — abort this flush
        }

        const overflowIdx = i - 1;
        const existing = t.overflow[overflowIdx];
        if (existing) {
          // Existing continuation — edit it.
          if (chunkText === existing.text) continue; // unchanged, skip
          const ok = await this.postSlackEdit(t.channel, existing.ts, chunkText);
          if (!ok) return false;
          existing.text = chunkText;
        } else {
          // New continuation — post into the thread under the parent.
          if (!t.slackTs) return false; // shouldn't happen: parent posted above
          const ts = await this.postSlackReply(t.channel, t.slackTs, chunkText);
          if (!ts) return false;
          t.overflow.push({ ts, text: chunkText });
        }
      }

      // Post full-result thread replies for tools whose unwrapped result
      // exceeds TOOL_PREVIEW_CAP. Idempotent via tc.threadTs guard. Done
      // after parent/overflow so we know slackTs exists.
      let toolThreadsOk = true;
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
            if (!ts) { toolThreadsOk = false; break; }
            if (!firstTs) firstTs = ts;
          }
          if (firstTs) tc.threadTs = firstTs;
        }
      }
      return toolThreadsOk;
    } catch (e) {
      console.error(`[${this.env.CELL_NAME}] flush error: ${String(e).slice(0, 200)}`);
      return false;
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

  // ---- Email emission (one-shot) ----

  // Single send per turn. Body is the same renderTurn() output the slack
  // path uses (markdown), since most modern mail clients render markdown
  // in plain-text bodies acceptably (and a verbatim quoted-thinking
  // section is fine either way). The reply chains via In-Reply-To from
  // the original Message-ID we captured at handleAppend time.
  // Returns true iff the email landed (or was already sent — idempotent).
  private async flushEmail(): Promise<boolean> {
    const t = this.currentTurn;
    if (!t) return true;
    if (t.emailSent) return true;
    if (!t.emailTo) {
      console.error(`[${this.env.CELL_NAME}] email turn has no emailTo — dropping`);
      t.emailSent = true;
      return true; // there's nothing to retry
    }
    const body = renderTurn(t, true);
    const subject = t.emailSubject
      ? (t.emailSubject.toLowerCase().startsWith("re:") ? t.emailSubject : `Re: ${t.emailSubject}`)
      : "(no subject)";
    try {
      const res = await fetch(EMAIL_SEND_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.env.CELLS_PROXY_SECRET}` },
        body: JSON.stringify({
          cell: this.env.CELL_NAME,
          text: body,
          to: t.emailTo,
          inReplyTo: t.emailMsgId || undefined,
          subject,
        }),
      });
      if (!res.ok) {
        console.error(`[${this.env.CELL_NAME}] email send failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return false;
      }
      t.emailSent = true;
      return true;
    } catch (e) {
      console.error(`[${this.env.CELL_NAME}] email send threw: ${String(e).slice(0, 200)}`);
      return false;
    }
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

// ---- site helpers ----

// Site paths become DO storage keys (site:<path>) and are echoed into
// Response handling. Constrain them: absolute, no traversal, no control
// chars. Empty return = reject this entry.
function normalizeSitePath(p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  const path = p.startsWith("/") ? p : `/${p}`;
  if (path.includes("..")) return "";
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) < 0x20) return "";
  }
  return path;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Shown at <cell>.cells.md before the cell has published anything.
function sitePlaceholder(name: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${name}</title>` +
    `<style>body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:640px;` +
    `margin:4em auto;padding:0 1em;color:#ddd;background:#111}h1{font-size:2em;margin:0 0 .2em}` +
    `.sub{color:#888}</style><body><h1>🧬 ${name}</h1>` +
    `<p class="sub">A living cell.</p><p>${name} hasn't published a page yet.</p></body></html>`;
}
