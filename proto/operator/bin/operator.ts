#!/usr/bin/env bun
/**
 * operator.ts — long-lived operator runtime.
 *
 * Drives a pi AgentSession programmatically (no `pi` binary, no
 * captured-pi-going-stale problem). Holds the Slack Socket Mode
 * connection in-process and pipes each inbound event into
 * session.prompt(). Two outbound tools (slack_post, slack_react) are
 * registered via an inline extension factory so they can close over
 * the live Slack App instance.
 *
 * Tools that are channel-agnostic (cells_list, cells_status,
 * cells_talk, channel_lookup) and the codex+anatomy composer
 * (use-codex) live in proto/operator/.pi/extensions/ and are picked up
 * automatically by createAgentSession's resource loader.
 *
 * Env contract (set by bin/operator-run before exec'ing this script):
 *   OPENAI_CODEX_API_KEY  — bearer for mother proxy /codex/*
 *   MOTHER_SECRET         — bearer for slack.cells.md/send (operator
 *                           uses this when posting via slack_post)
 *   SLACK_APP_TOKEN       — Socket Mode app-level (xapp-...)
 *   SLACK_BOT_TOKEN       — bot user OAuth (xoxb-...)
 *   PI_CODING_AGENT_DIR   — operator's private pi config dir
 */

import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { App, LogLevel } from "@slack/bolt";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
if (!APP_TOKEN || !BOT_TOKEN) {
  console.error("operator: SLACK_APP_TOKEN/SLACK_BOT_TOKEN missing — exiting");
  process.exit(1);
}

const CHANNELS_PATH = join(homedir(), ".cells/channels.json");
const STATE_PATH = join(homedir(), ".cells/operator-state.json");

function loadChannels(): Record<string, { cell: string; kind: string }> {
  if (!existsSync(CHANNELS_PATH)) return {};
  try {
    const j = JSON.parse(readFileSync(CHANNELS_PATH, "utf-8"));
    return j?.bindings ?? {};
  } catch { return {}; }
}

type OperatorState = {
  version: 1;
  // last-seen Slack ts per channel ID. We replay any newer user
  // messages on boot.
  lastSeenTs: Record<string, string>;
};

function loadState(): OperatorState {
  if (!existsSync(STATE_PATH)) return { version: 1, lastSeenTs: {} };
  try {
    const j = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    if (j && typeof j === "object" && j.version === 1) return j as OperatorState;
  } catch { /* fallthrough */ }
  return { version: 1, lastSeenTs: {} };
}

function saveState(s: OperatorState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE_PATH);
}

const slackApp = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.WARN,
});

let botUserId: string | null = null;

// Subtypes that are meta (not user prose) and safe to drop. Anything not
// in this set — including no subtype, file_share, me_message,
// thread_broadcast — is a real message we want to forward.
const DROP_SUBTYPES = new Set([
  "channel_join", "channel_leave", "channel_topic", "channel_purpose",
  "channel_name", "channel_archive", "channel_unarchive", "group_join",
  "group_leave", "message_changed", "message_deleted",
  "tombstone", "bot_message", "bot_remove", "bot_add",
]);

function looksLikeOurBot(event: any): boolean {
  if (!event) return false;
  if (event.bot_id) return true;
  if (botUserId && event.user === botUserId) return true;
  if (event.subtype && DROP_SUBTYPES.has(event.subtype)) return true;
  return false;
}

function formatInbound(event: any): string {
  const channel = event.channel ?? "?";
  const user = event.user ?? "?";
  const text = (event.text ?? "").trim();
  const threadPart = event.thread_ts ? ` thread=${event.thread_ts}` : "";
  return `from-slack channel=${channel}${threadPart} user=${user} text=${text}`;
}

console.log("[operator] booting AgentSession");
const { session } = await createAgentSession({
  cwd: process.cwd(),
  // Persistent so operator remembers context across restarts. Sessions
  // are scoped to operator's PI_CODING_AGENT_DIR (set by operator-run),
  // separate from mother and pulse.
  sessionManager: SessionManager.continueRecent(process.cwd()),
  extensionFactories: [
    // Inline factory: slack_post + slack_react. Lives here so the
    // tools can close over the live `slackApp` reference instead of
    // re-instantiating Bolt per-tool-call.
    (pi: any) => {
      pi.registerTool({
        name: "slack_post",
        label: "Slack: post (as operator)",
        description:
          "Post a message to a Slack channel AS yourself (operator). Use for acks ('ok, asking pete'), generalist answers, and clarifying questions. Do NOT use to speak on behalf of a cell — cells post via their own slack-channel extension.",
        parameters: Type.Object({
          channel: Type.String({ description: "Slack channel ID, e.g. C0123456789." }),
          text: Type.String({ description: "Message text. Slack mrkdwn supported." }),
          thread_ts: Type.Optional(
            Type.String({ description: "Optional thread timestamp for in-thread reply." }),
          ),
        }),
        async execute(_id: string, params: { channel: string; text: string; thread_ts?: string }) {
          try {
            const r = await slackApp.client.chat.postMessage({
              channel: params.channel,
              text: params.text,
              ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: r.ok, ts: r.ts, channel: r.channel }) }], details: {} };
          } catch (e) {
            return {
              content: [{ type: "text", text: `✗ slack_post failed: ${String(e).slice(0, 300)}` }],
              details: {},
            };
          }
        },
      });

      pi.registerTool({
        name: "slack_react",
        label: "Slack: react",
        description:
          "Add an emoji reaction to a Slack message. Cheap acknowledgement — 'eyes' for 'got it / working on it', 'white_check_mark' for done, 'hourglass_flowing_sand' for waiting on a cell. Saves spamming the channel.",
        parameters: Type.Object({
          channel: Type.String({ description: "Channel ID." }),
          ts: Type.String({ description: "Timestamp of the target message (event.ts)." }),
          name: Type.String({ description: "Emoji name without colons." }),
        }),
        async execute(_id: string, params: { channel: string; ts: string; name: string }) {
          try {
            const r = await slackApp.client.reactions.add({
              channel: params.channel,
              timestamp: params.ts,
              name: params.name,
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: r.ok }) }], details: {} };
          } catch (e) {
            return {
              content: [{ type: "text", text: `✗ slack_react failed: ${String(e).slice(0, 300)}` }],
              details: {},
            };
          }
        },
      });
    },
  ],
});

console.log(`[operator] session ready (file=${session.sessionFile ?? "(in-memory)"})`);

// Stream assistant text to stdout for visibility under launchd logs.
session.subscribe((event: any) => {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_end") {
    process.stdout.write("\n");
  }
});

// Cache bot user ID for self-message filtering.
try {
  const me = await slackApp.client.auth.test();
  botUserId = (me as any).user_id ?? null;
  console.log(`[operator] connected as ${(me as any).user ?? "?"} (${botUserId})`);
} catch (e) {
  console.error(`[operator] auth.test failed: ${String(e).slice(0, 200)}`);
}

const state = loadState();

const handle = async (event: any, opts: { fromCatchup?: boolean } = {}) => {
  if (looksLikeOurBot(event)) {
    console.log(`[operator] dropped: type=${event?.type ?? "?"} subtype=${event?.subtype ?? "-"} bot_id=${event?.bot_id ?? "-"} user=${event?.user ?? "-"}`);
    if (event?.channel && event?.ts) {
      state.lastSeenTs[event.channel] = event.ts;
      saveState(state);
    }
    return;
  }
  const text = formatInbound(event);
  console.log(`[operator]${opts.fromCatchup ? " catchup" : ""} inbound: ${text.slice(0, 200)}`);
  try {
    if (session.isStreaming) {
      await session.prompt(text, { streamingBehavior: "followUp" });
    } else {
      await session.prompt(text);
    }
    if (event?.channel && event?.ts) {
      state.lastSeenTs[event.channel] = event.ts;
      saveState(state);
    }
  } catch (e) {
    console.error(`[operator] session.prompt failed: ${String(e).slice(0, 300)}`);
  }
};

slackApp.message(async ({ event }) => { await handle(event); });
slackApp.event("app_mention", async ({ event }) => { await handle(event); });

await slackApp.start();
console.log(`[operator] Socket Mode connected — running`);

// Bolt's Socket Mode WebSocket can silently drop on flaky networks
// ("A pong wasn't received...") and stop delivering events without
// crashing the process. The 'disconnect'/'close' events on the
// underlying socket aren't reliable for this state — Bolt logs the
// pong timeout but stays in a half-open zombie. So we run our own
// liveness watchdog: hit auth.test every 60s, and exit (letting
// launchd KeepAlive restart + catch-up replay the gap) after 3 in
// a row fail or after the WebSocket has been in CONNECTING/CLOSED
// for a stretch.
slackApp.error(async (error: any) => {
  console.error(`[operator] bolt error: ${String(error).slice(0, 300)}`);
});

let consecutiveFailures = 0;
const PING_INTERVAL_MS = 30_000;
const FAIL_THRESHOLD = 2;
setInterval(async () => {
  try {
    const r = await Promise.race([
      slackApp.client.auth.test(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
    ]);
    if ((r as any)?.ok) {
      if (consecutiveFailures > 0) {
        console.log(`[operator] liveness recovered after ${consecutiveFailures} failure(s)`);
      }
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      console.error(`[operator] liveness probe not ok (${consecutiveFailures}/${FAIL_THRESHOLD})`);
    }
  } catch (e) {
    consecutiveFailures++;
    console.error(
      `[operator] liveness probe failed ${consecutiveFailures}/${FAIL_THRESHOLD}: ${String(e).slice(0, 200)}`,
    );
  }
  if (consecutiveFailures >= FAIL_THRESHOLD) {
    console.error(`[operator] liveness threshold reached — exiting for launchd restart`);
    process.exit(1);
  }
}, PING_INTERVAL_MS);

// Also tap the SocketModeClient state machine: it emits 'disconnected'
// (and 'connecting'/'connected'/'disconnecting') as it transitions.
// If we see 'disconnected' AND it stays disconnected for 10s, exit —
// catches the case where Bolt's own auto-reconnect gives up or stalls.
const smClient: any = (slackApp as any).socketModeReceiver?.client;
if (smClient && typeof smClient.on === "function") {
  let disconnectedSince: number | null = null;
  smClient.on("connected", () => {
    if (disconnectedSince) {
      console.log(`[operator] socket-mode reconnected after ${Math.round((Date.now() - disconnectedSince) / 1000)}s`);
    }
    disconnectedSince = null;
  });
  smClient.on("disconnected", () => {
    disconnectedSince = Date.now();
    console.error(`[operator] socket-mode disconnected — watching for reconnect`);
    setTimeout(() => {
      if (disconnectedSince && Date.now() - disconnectedSince >= 10_000) {
        console.error(`[operator] socket-mode still disconnected after 10s — exiting for launchd restart`);
        process.exit(1);
      }
    }, 11_000);
  });
}

// Catch-up: for every bound channel, fetch messages newer than our
// last-seen ts and forward them. Slack Socket Mode is at-most-once
// during disconnect windows, so any post made while operator was
// down would be dropped without this. Sequential per-channel; we
// don't await within because it'd block the Socket Mode handler
// loop, but we DO need to process catchup before declaring "ready"
// or you get out-of-order weirdness.
(async () => {
  const bindings = loadChannels();
  const channelIds = Object.keys(bindings);
  if (channelIds.length === 0) return;
  console.log(`[operator] catch-up: ${channelIds.length} bound channel(s)`);
  for (const cid of channelIds) {
    const oldest = state.lastSeenTs[cid];
    if (!oldest) {
      // No prior watermark — don't replay history on first ever boot;
      // would dump months of channel logs into operator's session.
      // Just stamp the latest message and start fresh.
      try {
        const r = await slackApp.client.conversations.history({ channel: cid, limit: 1 });
        const latest = r.messages?.[0]?.ts;
        if (latest) {
          state.lastSeenTs[cid] = latest;
          saveState(state);
        }
      } catch (e) {
        console.error(`[operator] catch-up: ${cid} initial stamp failed: ${String(e).slice(0, 120)}`);
      }
      continue;
    }
    try {
      const r = await slackApp.client.conversations.history({
        channel: cid,
        oldest,
        inclusive: false,
        limit: 50,
      });
      const msgs = (r.messages ?? []).slice().reverse(); // oldest-first replay
      if (msgs.length === 0) continue;
      console.log(`[operator] catch-up ${cid}: replaying ${msgs.length} message(s)`);
      for (const m of msgs) {
        await handle({ ...m, channel: cid }, { fromCatchup: true });
      }
    } catch (e) {
      console.error(`[operator] catch-up ${cid} failed: ${String(e).slice(0, 200)}`);
    }
  }
  console.log(`[operator] catch-up done`);
})();

// Keep process alive forever; launchd KeepAlive restarts on crash.
process.on("SIGTERM", async () => {
  console.log("[operator] SIGTERM — shutting down");
  try { await slackApp.stop(); } catch { /* best-effort */ }
  process.exit(0);
});
