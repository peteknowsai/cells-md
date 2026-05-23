#!/usr/bin/env node
/**
 * pulse-core — CLI over the pulse-core operations.
 *
 * The claude-code-harness counterpart to the pi `pulse-tools` extension:
 * pulse's /pulse skill runs a tick by shelling out to these subcommands.
 * Every command prints its result as JSON on stdout; errors go to stderr
 * with a non-zero exit. `save-schedule` reads its JSON argument from
 * stdin — the rest take no input (except `forget`, which takes a cell
 * name as argv).
 *
 * Paths come from pulse-core's resolvePaths(): $PULSE_RUNTIME_DIR,
 * $PULSE_STATE_DIR, $PULSE_CRON_FILE, defaulting under ~/.cells with the
 * crontab at /etc/cron.d/pulse-schedules.
 *
 *   pulse-core.mjs begin|drain|bootstrap|render|sync-crontab|end
 *   pulse-core.mjs forget <cell>
 *   echo '{"cell":"x","items":[{"cron":"0 8 * * *","message":"…"}],"sourcePath":"…"}' | pulse-core.mjs save-schedule
 */

import * as fs from "node:fs";
import {
  resolvePaths, begin, end, drainInbox, saveSchedule, forgetCell,
  bootstrapInbox, syncCrontab, renderDigest,
} from "../lib/pulse-core.mjs";

const USAGE = "usage: pulse-core.mjs begin|drain|save-schedule|forget <cell>|bootstrap|sync-crontab|render|end";

// save-schedule takes a JSON argument piped on stdin.
function readStdinJSON() {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf-8"); } catch { raw = ""; }
  if (!raw.trim()) {
    process.stderr.write("pulse-core: this command expects a JSON argument on stdin\n");
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`pulse-core: invalid JSON on stdin — ${e.message}\n`);
    process.exit(2);
  }
}

const cmd = process.argv[2];
const paths = resolvePaths();

let result;
try {
  switch (cmd) {
    case "begin": result = begin(paths); break;
    case "end": result = end(paths); break;
    case "drain": result = drainInbox(paths); break;
    case "bootstrap": result = await bootstrapInbox(paths); break;
    case "sync-crontab": result = syncCrontab(paths); break;
    case "render": result = renderDigest(paths); break;
    case "save-schedule": result = saveSchedule(paths, readStdinJSON()); break;
    case "forget": {
      const cell = process.argv[3];
      if (!cell) { process.stderr.write(`pulse-core forget: missing cell argument\n${USAGE}\n`); process.exit(2); }
      result = forgetCell(paths, { cell });
      break;
    }
    default:
      process.stderr.write(`pulse-core: unknown command ${cmd ? `"${cmd}"` : "(none)"}\n${USAGE}\n`);
      process.exit(2);
  }
} catch (e) {
  process.stderr.write(`pulse-core ${cmd}: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exit(1);
}

process.stdout.write(JSON.stringify(result) + "\n");
