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
      "Send a message to your bound Slack channel (or a specific channel/thread if given). Use this to reply to a question forwarded from Slack via the operator, to surface progress proactively, or to ask the human something. Posts as you (your cell name + a per-cell avatar) — not as a generic bot. Returns the chat.postMessage response from Slack.",
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

      let res: Response;
      try {
        res = await fetch(SLACK_SEND_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        return {
          content: [
            { type: "text", text: `✗ slack_post unreachable: ${String(e).slice(0, 200)}` },
          ],
        };
      }

      const text = await res.text();
      if (!res.ok) {
        return {
          content: [
            { type: "text", text: `✗ slack_post ${res.status}: ${text.slice(0, 300)}` },
          ],
        };
      }
      return { content: [{ type: "text", text }] };
    },
  });
}
