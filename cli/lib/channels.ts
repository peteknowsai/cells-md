// channels.json — channel-id → cell binding registry, plus the Slack/email
// wiring that birth and the `cells channel` CLI both depend on.
//
// Extracted from cells.ts so the birthing ritual can bind channels via
// scripts/bind-channel.ts without importing the whole CLI (cells.ts runs
// its arg dispatch on import).

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readSecret, readSecretsKey } from "./secrets";

// ────────────────────────────────────────────────────────────────────────────
// channels.json — channel-id → cell binding registry. Keyed by channel ID
// because inbound events arrive with a channel ID and need O(1) routing.
// One cell can be bound to multiple channels (multiple keys, same .cell).
// ────────────────────────────────────────────────────────────────────────────

export const CHANNELS_PATH = join(homedir(), ".cells", "channels.json");

export type ChannelKind = "slack" | "email"; // future: "imessage" | "telegram"
export type ChannelBinding = { cell: string; kind: ChannelKind; createdAt: string };
export type ChannelsFile = { version: 1; bindings: Record<string, ChannelBinding> };

export const CHANNEL_ID_PATTERNS: Record<ChannelKind, RegExp> = {
  slack: /^[CDG][A-Z0-9]{8,}$/, // C=public, D=DM, G=private/group/mpdm
  // Email "channel ID" is the address itself. KV key is shaped
  // "email:<local-part>" downstream so the email worker's lookup namespace
  // doesn't collide with Slack channel IDs.
  email: /^[a-z0-9._-]+@cells\.md$/,
};

// Map a binding to the KV key used by the front-door workers. Slack uses
// the bare channel ID (Slack worker reads CHANNELS.get(channelId)); email
// uses an "email:<local-part>" prefix so the namespaces stay separate.
function kvKeyFor(kind: ChannelKind, channelId: string): string {
  if (kind === "email") {
    const local = channelId.split("@")[0]?.toLowerCase() ?? "";
    return `email:${local}`;
  }
  return channelId;
}

export async function loadChannels(): Promise<ChannelsFile> {
  if (!existsSync(CHANNELS_PATH)) return { version: 1, bindings: {} };
  try {
    const j = JSON.parse(await readFile(CHANNELS_PATH, "utf-8"));
    if (j && typeof j === "object" && j.bindings) return j as ChannelsFile;
  } catch { /* fallthrough */ }
  return { version: 1, bindings: {} };
}

export async function saveChannels(file: ChannelsFile): Promise<void> {
  await mkdir(dirname(CHANNELS_PATH), { recursive: true });
  const tmp = CHANNELS_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(file, null, 2));
  await rename(tmp, CHANNELS_PATH);
}

// channels.json mirrors to a Cloudflare KV namespace (CHANNELS) so the
// Slack Worker can resolve channel→cell at request time without a
// laptop hop. Best-effort: a KV write failure logs a warning but
// doesn't roll back the local file. Re-sync via `cells channel sync`.
//
// We talk to the CF REST API directly instead of shelling out to
// `wrangler kv key put` — wrangler 3.x defaults that command to LOCAL
// (miniflare) emulation, which the live Worker can't read. Wrangler
// 4 added a `--remote` flag but it's not available in 3.
async function kvChannelsNamespaceId(): Promise<string | null> {
  return process.env.CLOUDFLARE_KV_CHANNELS_ID ?? (await readSecretsKey("CLOUDFLARE_KV_CHANNELS_ID"));
}

async function readWranglerOauthToken(): Promise<string | null> {
  const path = join(homedir(), "Library/Preferences/.wrangler/config/default.toml");
  if (!existsSync(path)) return null;
  try {
    const text = await readFile(path, "utf-8");
    const m = text.match(/^oauth_token\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch { return null; }
}

// Verify a bearer token against the CF API. Used to detect a dead
// CLOUDFLARE_API_TOKEN before we waste a real call on it. OAuth tokens
// don't respond to this endpoint (returns success:false even for valid
// ones), so callers MUST only invoke this on API tokens.
async function verifyCfApiToken(token: string): Promise<boolean> {
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return false;
    const j = (await r.json()) as { success?: boolean };
    return !!j.success;
  } catch { return false; }
}

// Memoized so a single CLI invocation that writes multiple KV keys
// (e.g. `cells channel sync`, or birth's bind-cell-channels for both
// slack + email) only pays the verify round-trip once. Process-scoped —
// each fresh `cells` invocation re-resolves.
let _cfCredsCache: { accountId: string; token: string } | null | undefined;

async function cfCreds(): Promise<{ accountId: string; token: string } | null> {
  if (_cfCredsCache !== undefined) return _cfCredsCache;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
    ?? (await readSecretsKey("CLOUDFLARE_ACCOUNT_ID"));
  if (!accountId) { _cfCredsCache = null; return null; }

  // Prefer the long-lived API token from env/secrets. If it's present
  // but invalid (revoked, rotated, typo) preflight-verify catches it and
  // we fall through to wrangler's OAuth token (refreshed by
  // `bunx wrangler login`). Previously a dead API token silently
  // 401'd every KV write — the fallback path was unreachable.
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
    ?? (await readSecretsKey("CLOUDFLARE_API_TOKEN"));
  if (apiToken && await verifyCfApiToken(apiToken)) {
    _cfCredsCache = { accountId, token: apiToken };
    return _cfCredsCache;
  }
  if (apiToken) {
    console.warn("[kv] CLOUDFLARE_API_TOKEN failed verify — falling back to wrangler OAuth. Rotate the token in ~/.cells/secrets.json to silence this.");
  }

  const oauth = await readWranglerOauthToken();
  if (oauth) {
    _cfCredsCache = { accountId, token: oauth };
    return _cfCredsCache;
  }

  _cfCredsCache = null;
  return null;
}

export async function kvUpsert(kind: ChannelKind, channelId: string, cell: string): Promise<void> {
  const id = await kvChannelsNamespaceId();
  const creds = await cfCreds();
  if (!id || !creds) {
    console.warn(`[kv] missing CLOUDFLARE_KV_CHANNELS_ID or account/token — local channels.json updated but KV is stale`);
    return;
  }
  const key = kvKeyFor(kind, channelId);
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`,
    { method: "PUT", headers: { Authorization: `Bearer ${creds.token}` }, body: cell },
  );
  if (!r.ok) {
    console.warn(`[kv] put ${key}=${cell} failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  }
}

export async function kvDelete(kind: ChannelKind, channelId: string): Promise<void> {
  const id = await kvChannelsNamespaceId();
  const creds = await cfCreds();
  if (!id || !creds) {
    console.warn(`[kv] missing CLOUDFLARE_KV_CHANNELS_ID or account/token — local channels.json updated but KV is stale`);
    return;
  }
  const key = kvKeyFor(kind, channelId);
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${creds.token}` } },
  );
  if (!r.ok) {
    console.warn(`[kv] delete ${key} failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  }
}

export async function evictChannelBindingsForCell(name: string): Promise<void> {
  if (!existsSync(CHANNELS_PATH)) return;
  try {
    const file = await loadChannels();
    const removed: { id: string; kind: ChannelKind }[] = [];
    for (const [id, b] of Object.entries(file.bindings)) {
      if (b.cell === name) {
        removed.push({ id, kind: b.kind });
        delete file.bindings[id];
      }
    }
    if (removed.length > 0) {
      await saveChannels(file);
      for (const r of removed) await kvDelete(r.kind, r.id);
    }
  } catch { /* best-effort */ }
}

// Slack: create #<name> via conversations.create (requires channels:manage
// on the bot scope). If the channel already exists, fall back to looking
// it up. Returns the channel ID either way.
export async function ensureSlackChannel(cellName: string): Promise<string> {
  const token = await readSecret("SLACK_BOT_TOKEN");
  if (!token) throw new Error("SLACK_BOT_TOKEN missing from ~/.cells/secrets.json");

  // Try the bare cell name first; if that's taken, fall back to the
  // namespaced `cells-<name>` form to avoid colliding with a
  // pre-existing unrelated channel.
  const tryCreate = async (name: string) => {
    const r = await fetch("https://slack.com/api/conversations.create", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name, is_private: false }),
    });
    return (await r.json()) as { ok: boolean; channel?: { id: string }; error?: string };
  };

  const bare = await tryCreate(cellName);
  if (bare.ok && bare.channel?.id) return bare.channel.id;
  if (bare.error !== "name_taken") {
    throw new Error(`conversations.create #${cellName} failed: ${bare.error ?? "unknown"}`);
  }

  // Brand prefix comes from the Slack bot's own username so this stays
  // correct across installs where the project is rebranded (e.g. "zero"
  // instead of "cells"). Falls back to "cells" only if auth.test fails.
  const prefix = await getSlackBrandPrefix(token);
  const prefixed = `${prefix}-${cellName}`;
  console.log(`! #${cellName} taken; using #${prefixed}`);
  const pref = await tryCreate(prefixed);
  if (pref.ok && pref.channel?.id) return pref.channel.id;
  if (pref.error !== "name_taken") {
    throw new Error(`conversations.create #${prefixed} failed: ${pref.error ?? "unknown"}`);
  }

  // Both names taken — look up the prefixed one (which we'd own from a
  // prior cells run) and bind to it. Walk pagination in case the
  // workspace has a lot of channels.
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("types", "public_channel,private_channel");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const j = (await r.json()) as {
      ok: boolean;
      channels?: { id: string; name: string }[];
      response_metadata?: { next_cursor?: string };
      error?: string;
    };
    if (!j.ok) throw new Error(`conversations.list failed: ${j.error ?? "unknown"}`);
    const hit = j.channels?.find((c) => c.name === prefixed);
    if (hit) return hit.id;
    cursor = j.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  throw new Error(`#${prefixed} reported name_taken but not found in conversations.list`);
}

// Slack bot's own username, lowercased and slugged. Used as the
// channel-name prefix when a cell's bare name collides with an
// existing channel. Cached per-process — bot name doesn't change.
let _slackBrandPrefix: string | null = null;
async function getSlackBrandPrefix(botToken: string): Promise<string> {
  if (_slackBrandPrefix) return _slackBrandPrefix;
  try {
    const r = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}` },
    });
    const j = (await r.json()) as { ok: boolean; user?: string };
    const raw = j.ok && j.user ? j.user : "cells";
    _slackBrandPrefix = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "cells";
  } catch {
    _slackBrandPrefix = "cells";
  }
  return _slackBrandPrefix;
}

// Look up the human owner's Slack user ID via auth.test on
// SLACK_USER_TOKEN. The user token belongs to whoever installed the
// app (Pete), so this returns Pete's ID. No extra scope required —
// auth.test just reflects the token owner.
export async function resolveSlackUserId(): Promise<string | null> {
  const userToken = await readSecret("SLACK_USER_TOKEN");
  if (!userToken) return null;
  const r = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${userToken}` },
  });
  const j = (await r.json()) as { ok: boolean; user_id?: string; error?: string };
  if (!j.ok || !j.user_id) throw new Error(`auth.test failed: ${j.error ?? "unknown"}`);
  return j.user_id;
}

export async function inviteSlackUser(channelId: string, userId: string): Promise<void> {
  const botToken = await readSecret("SLACK_BOT_TOKEN");
  if (!botToken) throw new Error("SLACK_BOT_TOKEN missing");
  const r = await fetch("https://slack.com/api/conversations.invite", {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: channelId, users: userId }),
  });
  const j = (await r.json()) as { ok: boolean; error?: string };
  // already_in_channel is fine — idempotent re-runs.
  if (!j.ok && j.error !== "already_in_channel") {
    throw new Error(`conversations.invite failed: ${j.error ?? "unknown"}`);
  }
}

// Look up a slack channel's human-readable name (e.g. "cells-pete") so we
// can show "#cells-pete" in the cell's tmux bar instead of the raw ID.
// Best-effort: returns the channel ID on any failure.
async function slackChannelName(channelId: string): Promise<string> {
  const token = await readSecret("SLACK_BOT_TOKEN");
  if (!token) return channelId;
  try {
    const r = await fetch(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const j = (await r.json()) as { ok: boolean; channel?: { name?: string } };
    return j.ok && j.channel?.name ? `#${j.channel.name}` : channelId;
  } catch {
    return channelId;
  }
}

// Push the cell's current channel bindings to its on-cell status.json so
// the tmux status-right shows them. Best-effort — failures log a warning
// but don't roll back the laptop-side binding.
export async function updateCellStatusChannels(cell: string): Promise<void> {
  const file = await loadChannels();
  const ids = Object.entries(file.bindings)
    .filter(([, b]) => b.cell === cell)
    .map(([id]) => id);
  const names = await Promise.all(ids.map(slackChannelName));
  // Use jq on the cell to merge into status.json, preserving harness and
  // tolerating a missing file (start from {harness:"pi"} as a safe default).
  const channelsJson = JSON.stringify(names);
  // status.json lives under /root/.pi (root:root post-bake, agent runs
  // as root); plain sudo lifts the well user to root.
  const remote = `
set -e
F=/root/.pi/status.json
mkdir -p "$(dirname "$F")"
[ -f "$F" ] || echo '{"harness":"pi","channels":[]}' > "$F"
tmp=$(mktemp)
jq --argjson ch '${channelsJson.replace(/'/g, "'\\''")}' '.channels = $ch' "$F" > "$tmp" && mv "$tmp" "$F"
`.trim();
  // Resolve the cell's well via the shared name→well lookup. Pool-hatched
  // cells live in `egg-<hex>` wells; specials in `cells-<name>`; legacy
  // ones in `<name>`. Previously this passed the cell name to `well exec`
  // directly and failed for hatched cells.
  const { wellNameForCell } = await import("./resolve");
  const wellName = await wellNameForCell(cell);
  try {
    const proc = Bun.spawn(["well", "exec", "-s", wellName, "--", "sudo", "bash", "-c", remote], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      console.warn(`! status.json update for ${cell} failed (exit ${code}): ${err.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`! status.json update for ${cell} failed: ${e}`);
  }
}

// Bind a messaging channel to a cell — the birth-time channel wiring, also
// reusable standalone (scripts/bind-channel.ts, the `cells channel` CLI).
// slack: create the channel, invite the owner, write the binding.
// email: derive <cell>@cells.md, write the binding. Idempotent. Returns
// the bound channel id / address.
export async function bindChannel(cell: string, kind: ChannelKind): Promise<string> {
  if (kind === "slack") {
    const channelId = await ensureSlackChannel(cell);
    try {
      const userId = await resolveSlackUserId();
      if (userId) await inviteSlackUser(channelId, userId);
    } catch (e) {
      console.warn(`! could not auto-invite owner to the slack channel for ${cell}: ${e}`);
    }
    const file = await loadChannels();
    file.bindings[channelId] = { cell, kind: "slack", createdAt: new Date().toISOString() };
    await saveChannels(file);
    await kvUpsert("slack", channelId, cell);
    await updateCellStatusChannels(cell);
    return channelId;
  }
  const address = `${cell}@cells.md`;
  const file = await loadChannels();
  file.bindings[address] = { cell, kind: "email", createdAt: new Date().toISOString() };
  await saveChannels(file);
  await kvUpsert("email", address, cell);
  await updateCellStatusChannels(cell);
  return address;
}
