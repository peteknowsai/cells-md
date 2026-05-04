# operator (RETIRED — see cells-cloud-front Phase 1a)

> **This document describes the v1 operator that was retired in
> cells-cloud-front Phase 1a.** Slack inbound + outbound now run
> through Cloudflare:
>
> - `slack.cells.md` (Cloudflare Worker `cells-front-slack`) handles
>   the Slack Events API webhook AND the outbound `/send` route
>   that cells use via the slack-channel extension.
> - Each cell has its own Worker `cells-front-<cell>` at
>   `<cell>.cells.md` with a `CellInbox` Durable Object. The Slack
>   Worker fans out to the right cell via channel→cell bindings in
>   the `CHANNELS` KV namespace.
> - An in-sprite `cell-drainer` service (registered via
>   `scripts/register-drainer-service.sh`) long-polls
>   `<cell>.cells.md/inbox/poll`, hosts `pi --mode rpc --continue`
>   as a child, and writes prompts to pi's stdin.
>
> Phase 4 of the cloud-front roadmap reintroduces operator in a
> different shape — an HTTP-driven LLM-routed inbox at
> `operator.cells.md/inbox/*` for an "operator channel" where Pete
> directs work and operator picks the right cell. Until then, the
> files in `proto/operator/` are kept for reference only.

The rest of this document is the v1 architecture as it existed before
retirement, kept for historical context.

## Architecture (v1, retired)

```
   Slack (Socket Mode WebSocket out from Mac)
        │
        ▼
   ┌─────────────────────────────────────┐
   │  proto/operator/  (Mac, launchd)    │
   │   bin/operator.ts                   │
   │   - SDK-driven AgentSession         │
   │     (createAgentSession, persistent │
   │     session via continueRecent)     │
   │   - @slack/bolt App in-process      │
   │   - inline slack_post / slack_react │
   │   .pi/extensions/use-codex          │
   │     anatomy + codex provider routing│
   │   .pi/extensions/operator-tools     │
   │     cells_list, cells_status,       │
   │     cells_talk, channel_lookup      │
   └─────────────────────────────────────┘
        │ shell: cells talk pete "..."   ▲
        ▼                                │
   pete (sprite)                         │
   slack-channel ext: slack_post(text,   │
                      thread_ts?, channel?)
        │                                │
        ▼                                │
   mother proxy /send (slack.cells.md) ──┘
        │
        ▼ chat.postMessage
        │  username=pete, icon_url=<gravatar>
        ▼
   Slack #cells-pete posts as "pete"
```

Two long-lived processes on the Mac: **mother proxy** and **operator**.
Pulse stays as-is. No public webhook for Slack — Socket Mode is outbound
from the Mac.

## Why an LLM at the boundary

A cheap fast model (GPT-5.5 low, routed through the Codex proxy on
Pete's ChatGPT sub) makes routing flexible: "talk to whoever knows
about X," "summarize this thread before waking pete," "handle this
yourself." Deterministic routing can't do any of that.

Operator also accumulates skills over time — over weeks it learns to
handle classes of messages inline (read the registry, summarize
heartbeats, look something up) without delegating, which is the
insight behind Mario's pi-mom.

## Why a custom Node binary, not the `pi` CLI

Originally tried using the `pi` binary plus a Slack-listener extension.
The captured `ExtensionAPI` reference staled out the moment a Slack
event arrived (`This extension ctx is stale after session replacement
or reload`), so the agent never took a turn.

Pivoted to the pattern Mario recommends in `pi-coding-agent/docs/rpc.md`:

> If you're building a Node.js application, consider using
> AgentSession directly from @mariozechner/pi-coding-agent instead of
> spawning a subprocess.

`bin/operator.ts`:
- `createAgentSession({ sessionManager: continueRecent })` — one
  persistent session that survives operator restarts.
- holds the `@slack/bolt` App in-process.
- inbound events call `session.prompt(text)` directly (uses
  `streamingBehavior: "followUp"` to queue if a turn is in flight).
- registers `slack_post` / `slack_react` inline so they close over the
  live App reference.

Channel-agnostic tools (`cells_list`, `cells_status`, `cells_talk`,
`channel_lookup`) live in `.pi/extensions/operator-tools/` and load
automatically via the SDK's resource loader. The codex provider routing
+ anatomy composer lives in `.pi/extensions/use-codex/`, copied from
pulse.

## Files

| Path | Purpose |
|---|---|
| `proto/operator/SOUL.md` | role + boundaries (loaded into systemPrompt) |
| `proto/operator/TOOLS.md` | tool descriptions (loaded into systemPrompt) |
| `proto/operator/HEARTBEAT.md` | declares "no schedule" (loaded for symmetry) |
| `proto/operator/IDENTITY.md` | metadata + boot env documentation |
| `proto/operator/.pi/settings.json` | gpt-5.5 / low thinking / codex provider |
| `proto/operator/.pi/extensions/use-codex/` | codex routing + anatomy composer |
| `proto/operator/.pi/extensions/operator-tools/` | cells_list/status/talk + channel_lookup |
| `proto/operator/bin/operator-run` | bash launcher; loads secrets, exec's bun |
| `proto/operator/bin/operator.ts` | SDK runtime; Slack listener + session lifecycle |
| `proto/operator/state/log.md` | (future) daily narrative — operator-written |
| `cli/proxy.ts` | `slack.cells.md/send` host branch |
| `cli/cells.ts` | `cells channel link/unlink/list`, `schedule-operator`, birth prompt |
| `proto/mother/dna/.pi/extensions/slack-channel/` | optional cell extension; `slack_post` tool |

## State

| Path | What |
|---|---|
| `~/.cells/channels.json` | channel ID → cell binding registry. Keyed by channel ID for O(1) inbound lookup. One cell can be bound to multiple channels. |
| `~/.cells/operator-agent/auth.json` | pi auth dir (isolated from mother's) |
| `~/.cells/operator-agent/sessions/.../*.jsonl` | persistent operator session — one file, continueRecent picks it up across restarts. |
| `~/.cells/secrets.json` | `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |
| `~/.cells/logs/operator.log` / `.err` | launchd-managed stdout/stderr |

## Slack app setup (one-time, manual)

1. api.slack.com/apps → **Create New App → From scratch** → name "cells".
2. **Socket Mode → Enable** → generate App-Level Token with
   `connections:write` scope → copy (`xapp-...`).
3. **OAuth & Permissions → Bot Token Scopes**: `app_mentions:read`,
   `chat:write`, `chat:write.customize` (the username/icon override),
   `channels:history`, `groups:history`, `im:history`, `im:read`,
   `im:write`, `users:read`.
4. **Event Subscriptions → Enable Events** (no Request URL — Socket Mode):
   subscribe to bot events `app_mention`, `message.channels`,
   `message.groups`, `message.im`.
5. **Install to workspace** → copy Bot User OAuth Token (`xoxb-...`).
6. **Basic Information → Signing Secret** → copy (defense in depth even
   though Socket Mode skips webhook signature verification).
7. Append to `~/.cells/secrets.json`:
   ```json
   "SLACK_APP_TOKEN":   "xapp-...",
   "SLACK_BOT_TOKEN":   "xoxb-...",
   "SLACK_SIGNING_SECRET": "..."
   ```
8. Restart mother (`launchctl kickstart -k gui/$UID/com.pete.cells-proxy`)
   so the proxy reads `SLACK_BOT_TOKEN`.

## Per-cell setup

For each cell that should be reachable via Slack:

1. **Create a private channel in Slack.** Convention: `#cells-pete`,
   `#cells-scott`, etc. (Public is fine too; private gives you a
   DM-feeling sidebar entry without per-cell bot apps.)
2. **Invite the bot:** `/invite @cells` in the channel.
3. **Bind the channel to the cell:** copy the channel ID (channel
   name → "About" → bottom of panel) and run:
   ```sh
   cells channel link <cell> <channel-id>
   ```
4. **Ensure the cell has the slack-channel extension.** New cells get
   it via the birth prompt. Existing cells need a one-shot retrofit:
   ```sh
   cells refresh-extensions <cell> slack-channel --restart
   ```

After this, anything posted in the bound channel routes to the cell.
The cell's `slack_post` tool uses the channel's ID and (optional)
`thread_ts` from the inbound envelope to reply in the same thread.

## Birth integration

`cells birth` (interactive) has a 6th step:
```
Slack channel ID? (paste or empty to skip):
```
A non-empty paste:
- adds `slack-channel` to the chosen extensions automatically
- writes the channel↔cell binding post-birth

Non-interactive flag: `--slack-channel=C0123456789`. Bad IDs rejected at
parse time.

## Identity in Slack

One shared bot user (`cells`). Per-message `username` and `icon_url`
override (via `chat:write.customize` scope) makes each cell appear as
itself in Slack — when pete posts, the message shows "pete" + a
deterministic gravatar identicon. Operator's own messages (acks,
generalist replies, clarifying questions) post under operator's
default identity.

True per-cell DM threads (sidebar identity per cell) are deferred —
would require per-cell Slack apps. The current architecture supports
them: `channels.json` keys by channel ID and DM channels (`D...`)
slot in identically to public/private channel IDs.

## Operations

```sh
cells schedule-operator       # install launchd plist (KeepAlive=true, RunAtLoad=true)
cells unschedule-operator     # remove plist
cells channel list            # show all bindings
cells channel link <cell> <id>
cells channel unlink <cell> [<id>]
```

To bounce operator manually:
```sh
launchctl kickstart -k gui/$UID/com.pete.cells-operator
```

Operator's session persists at
`~/.cells/operator-agent/sessions/.../*.jsonl`. To start fresh
(forget all conversation history), delete that file before next boot.

## Known limitations (v1)

- **At-most-once on disconnect.** Slack Socket Mode does not replay
  events fired during a disconnect window. If operator restarts (e.g.
  during deploy), messages posted in that gap are silently dropped.
  Slack's `conversations.history` could backfill on startup; deferred.
- **Single bot identity in Slack.** All cells share the `cells` bot
  user; per-message `username`/`icon_url` overrides give visual
  distinction. True per-cell DM threads would require per-cell Slack
  apps; deferred until the workspace-clutter cost is worth it.
- **No threading semantics.** Operator passes `thread_ts` through to
  cells but doesn't reason about thread context (e.g. "this is a
  follow-up to what pete said in T-3"). The cell sees raw text.
- **No conversation memory across sessions.** Operator's context is one
  long persistent session; eventual compaction will drop old turns.
  Per-thread state caches deferred.
- **No skills directory yet.** When operator finds itself doing the
  same lookup repeatedly, it should build a skill (Mario's pi-mom
  pattern). Skills loader in pi-coding-agent supports this; not yet
  populated.

## Future channels

The architecture generalizes:
- new adapter (e.g. `imessage-adapter`) holds its channel-specific
  listener (BlueBubbles webhook, Telegram bot API, IMAP) — same shape
  as the inline slack section in `bin/operator.ts`
- new cell-side extension (e.g. `imessage-channel`) registers an
  outbound tool that POSTs to a parallel proxy route (e.g.
  `imessage.cells.md/send`)
- `channels.json` already has a `kind` discriminant and a per-kind ID
  pattern; just add `"imessage": /^.../` to `CHANNEL_ID_PATTERNS`

Each new adapter is one new extension + one new proxy route + one
new bearer in `secrets.json`. No core operator changes.
