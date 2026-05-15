#!/usr/bin/env bun
//
// Bind a messaging channel to a cell — invoked by the birthing ritual
// (step 6) and runnable standalone. Thin wrapper over cli/lib/channels.ts.
//
// Usage: bun scripts/bind-channel.ts <cell> <slack|email>
//
// Exit 0 on success, 1 on bind failure, 2 on bad args.

import { bindChannel, type ChannelKind } from "../cli/lib/channels";

const [cell, kind] = process.argv.slice(2);
if (!cell || (kind !== "slack" && kind !== "email")) {
  console.error("usage: bun scripts/bind-channel.ts <cell> <slack|email>");
  process.exit(2);
}

try {
  const id = await bindChannel(cell, kind as ChannelKind);
  console.log(`bound ${kind} ${id} → ${cell}`);
} catch (e) {
  console.error(`bind-channel failed: ${e}`);
  process.exit(1);
}
