#!/usr/bin/env bun
//
// Bind a messaging channel to a cell — invoked by the birthing ritual
// (step 6) and runnable standalone. Thin wrapper over cli/lib/channels.ts.
//
// Usage: bun scripts/bind-channel.ts <cell> <slack|email>[:<session>]
//
// The optional `:<session>` suffix pins inbound from this channel to a named
// durable session on the cell (e.g. `slack:staff` → the Slack channel feeds
// the cell's "staff" session instead of main). This is the form birth's
// blob.channels carries through bind-cell-channels.sh.
//
// Exit 0 on success, 1 on bind failure, 2 on bad args.

import { bindChannel, parseChannelValue, SESSION_NAME_RE, type ChannelKind } from "../cli/lib/channels";

const [cell, channelArg] = process.argv.slice(2);
const { kind, session } = channelArg ? parseChannelValue(channelArg) : { kind: undefined, session: undefined };

if (!cell || (kind !== "slack" && kind !== "email")) {
  console.error("usage: bun scripts/bind-channel.ts <cell> <slack|email>[:<session>]");
  process.exit(2);
}
if (session && !SESSION_NAME_RE.test(session)) {
  console.error(`bad session name '${session}': must match ${SESSION_NAME_RE}`);
  process.exit(2);
}

try {
  const id = await bindChannel(cell, kind as ChannelKind, session);
  console.log(`bound ${kind} ${id} → ${cell}${session ? ` session=${session}` : ""}`);
} catch (e) {
  console.error(`bind-channel failed: ${e}`);
  process.exit(1);
}
