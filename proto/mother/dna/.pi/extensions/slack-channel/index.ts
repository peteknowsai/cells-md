/**
 * slack-channel — let a cell post to its Slack channel.
 *
 * Optional cell extension; pruned at birth unless the user opts in (or
 * passes a Slack channel ID at create-time, which auto-installs it).
 *
 * Registers one tool, `slack_post`. Tool-only — no listener, no
 * fs.watch, no long-lived state. A hibernating sprite stays hibernated;
 * the tool only runs when the agent decides to call it.
 *
 * Routing: by default the proxy looks up this cell's binding in
 * ~/.cells/channels.json (set via `cells channel link <cell> <id>`) and
 * posts there. Pass `channel` explicitly to override (e.g. when an
 * inbound message from operator named a different channel/thread).
 *
 * Identity: by default the proxy posts as username=<cell> with a
 * deterministic gravatar identicon, so messages appear authored AS the
 * cell even though one shared bot account underlies all cells. Pass
 * `username`/`icon_url` to override per-message.
 *
 * Auth: shared CELLS_PROXY_SECRET, available on cells as MOTHER_SECRET
 * (set by configure-cell-proxy.sh into ~/.bashrc.d/site_proxy).
 */

import { Type } from "@sinclair/typebox";
import * as os from "node:os";

const SLACK_SEND_URL = "https://slack.cells.md/send";

function readSelfName(): string {
  return os.hostname() || process.env.CELL_NAME || "unknown";
}

export default function (pi: any) {
  pi.registerTool({
    name: "slack_post",
    label: "Post to Slack",
    description:
      "Post a message to your bound Slack channel (or a specific channel/thread if given). " +
      "**REQUIRED whenever you receive a prompt prefixed with `from-slack`** — that prefix means the human asked you in Slack, and the only way they can hear your answer is if you call slack_post. Replying only in the agent transcript is invisible to them. " +
      "Also use proactively to surface progress, or to ask the human something. " +
      "Posts as you (your cell name + a per-cell avatar) — not as a generic bot. Returns the chat.postMessage response from Slack.",
    parameters: Type.Object({
      text: Type.String({
        description: "The message to send. Slack mrkdwn supported.",
      }),
      thread_ts: Type.Optional(
        Type.String({
          description:
            "Optional thread timestamp to reply in-thread. Pass this through verbatim from an inbound `from-slack` message to keep replies in the same thread.",
        }),
      ),
      channel: Type.Optional(
        Type.String({
          description:
            "Optional channel ID override. Defaults to your bound channel. Pass through from `from-slack channel=<id>` when replying to a different channel than your default.",
        }),
      ),
      username: Type.Optional(
        Type.String({
          description: "Optional display-name override (default: your cell name).",
        }),
      ),
      icon_url: Type.Optional(
        Type.String({
          description: "Optional avatar URL (default: deterministic gravatar identicon).",
        }),
      ),
    }),
    async execute(
      _id: string,
      params: {
        text: string;
        thread_ts?: string;
        channel?: string;
        username?: string;
        icon_url?: string;
      },
      signal: AbortSignal,
    ) {
      if (signal.aborted) throw new Error("aborted");
      const secret = process.env.MOTHER_SECRET;
      if (!secret) {
        return {
          content: [
            { type: "text", text: "✗ slack_post failed: MOTHER_SECRET not set" },
          ],
        };
      }

      const cell = readSelfName();
      const body = {
        cell,
        text: params.text,
        ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
        ...(params.channel ? { channel: params.channel } : {}),
        ...(params.username ? { username: params.username } : {}),
        ...(params.icon_url ? { icon_url: params.icon_url } : {}),
      };

      // Pi globally disables undici body/headers timeouts (cli.js sets
      // bodyTimeout=0, headersTimeout=0 to support slow local LLMs), so
      // a stalled TCP stream here would hang the tool — and the agent —
      // forever. Enforce our own 30s deadline via AbortController.
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal.addEventListener("abort", onAbort);
      const t = setTimeout(() => ac.abort(), 30_000);

      // The 30s timer must protect BOTH the fetch (headers) and the body
      // read — fetch() resolves as soon as headers arrive, but res.text()
      // can still hang forever if the body stream stalls. Keep the timer
      // armed until the body is fully read.
      try {
        let res: Response;
        try {
          res = await fetch(SLACK_SEND_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${secret}`,
            },
            body: JSON.stringify(body),
            signal: ac.signal,
          });
        } catch (e) {
          return {
            content: [
              { type: "text", text: `✗ slack_post unreachable: ${String(e).slice(0, 200)}` },
            ],
          };
        }
        let text: string;
        try {
          text = await res.text();
        } catch (e) {
          return {
            content: [
              { type: "text", text: `✗ slack_post body-read failed: ${String(e).slice(0, 200)}` },
            ],
          };
        }
        if (!res.ok) {
          return {
            content: [
              { type: "text", text: `✗ slack_post ${res.status}: ${text.slice(0, 300)}` },
            ],
          };
        }
        return { content: [{ type: "text", text }] };
      } finally {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
      }
    },
  });
}
