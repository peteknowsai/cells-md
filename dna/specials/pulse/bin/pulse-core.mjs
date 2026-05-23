#!/usr/bin/env node
/**
 * pulse-core — CLI over the pulse-core operations.
 *
 * The claude-code-harness counterpart to the pi `pulse-tools` extension:
 * pulse's /pulse skill runs a tick by shelling out to these subcommands. Every
 * command prints its result as JSON on stdout; errors go to stderr with a
 * non-zero exit. `save-schedule` and `write-log` read their JSON argument
 * from stdin — the rest take no input.
 *
 * Paths come from pulse-core's resolvePaths(): $PULSE_RUNTIME_DIR and
 * $PULSE_STATE_DIR, defaulting under ~/.cells.
 *
 *   pulse-core.mjs begin|drain|fire|bootstrap|daily-log-check|render|end
 *   echo '{"cell":"x","items":[{"cron":"0 8 * * *","message":"…"}],"sourcePath":"…"}' | pulse-core.mjs save-schedule
 *   echo '{"date":"2026-05-20","body":"…"}' | pulse-core.mjs write-log
 */

import * as fs from "node:fs";
import {
  resolvePaths, begin, end, drainInbox, saveSchedule, forgetCell,
  fireDue, bootstrapInbox, dailyLogDue, writeLogEntry, renderDigest,
} from "../lib/pulse-core.mjs";

const USAGE = "usage: pulse-core.mjs begin|drain|save-schedule|forget <cell>|fire|bootstrap|daily-log-check|write-log|render|end";

// save-schedule / write-log take a JSON argument piped on stdin.
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
    case "fire": result = await fireDue(paths); break;
    case "bootstrap": result = await bootstrapInbox(paths); break;
    case "daily-log-check": result = dailyLogDue(paths); break;
    case "render": result = renderDigest(paths); break;
    case "save-schedule": result = saveSchedule(paths, readStdinJSON()); break;
    case "write-log": result = writeLogEntry(paths, readStdinJSON()); break;
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
