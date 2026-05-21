/**
 * pulse-core.test.mjs — exercises the deterministic core against a scratch
 * runtime dir, verifying the lift out of pulse-tools is faithful: the
 * concurrency sentinel, inbox drain + no-op skip, schedule save + id
 * derivation + cron validation, daily-log bookkeeping, and digest render.
 *
 * No network and no `cells talk` — fireDue is checked only for shape, on a
 * daily schedule that isn't due in the last-60s window. Cron correctness
 * itself is pinned separately by cron.test.mjs.
 *
 *   node dna/specials/pulse/lib/pulse-core.test.mjs
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolvePaths, begin, end, drainInbox, saveSchedule,
  fireDue, bootstrapInbox, dailyLogDue, writeLogEntry, renderDigest,
} from "./pulse-core.mjs";

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) pass++;
  else { fail++; console.log("  x " + label); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-core-test-"));
const paths = resolvePaths({
  runtimeDir: path.join(tmp, "rt"),
  stateDir: path.join(tmp, "state"),
  registryPath: path.join(tmp, "cells.json"),
  vaultDir: path.join(tmp, "vault"),
});
const rt = paths.runtimeDir;

try {
  // --- begin / concurrency sentinel ---
  const b1 = begin(paths);
  check("begin: not skipped on a fresh run", b1.skip === false);
  check("begin: isFirstRun true with an empty cache", b1.isFirstRun === true);
  check("begin: pulse.json created", fs.existsSync(path.join(rt, "pulse.json")));
  check("begin: a held sentinel makes the next begin skip", begin(paths).skip === true);

  // --- drain inbox ---
  check("drain: empty inbox returns []", drainInbox(paths).length === 0);

  const inbox = path.join(rt, "pulse-inbox");
  const hbBody = "# Heartbeat\n\n- 08:00 daily — refresh the dataset.\n";
  const f1 = path.join(inbox, `testcell-${Date.now()}.md`);
  fs.writeFileSync(f1, hbBody);
  const drained = drainInbox(paths);
  check("drain: surfaces a dropped inbox file", drained.length === 1 && drained[0].cell === "testcell");

  // --- save schedule ---
  const saved = saveSchedule(paths, {
    cell: "testcell",
    items: [{ cron: "0 8 * * *", message: "refresh the dataset" }],
    sourcePath: drained[0].path,
  });
  check("saveSchedule: ok with one item", saved.ok === true && saved.count === 1);
  check("saveSchedule: cache file written", fs.existsSync(path.join(rt, "pulse-cache", "testcell.json")));
  check("saveSchedule: source archived to processed/",
    !fs.existsSync(f1) && fs.existsSync(path.join(inbox, "processed", path.basename(f1))));

  const badCron = saveSchedule(paths, { cell: "x", items: [{ cron: "99 99 * * *", message: "nope" }] });
  check("saveSchedule: rejects an invalid cron", badCron.ok === false);

  // --- no-op skip: identical content re-pushed is auto-archived, not returned ---
  const f2 = path.join(inbox, `testcell-${Date.now() + 5}.md`);
  fs.writeFileSync(f2, hbBody);
  const drained2 = drainInbox(paths);
  check("drain: unchanged content auto-skipped (hash match)",
    drained2.length === 0 && fs.existsSync(path.join(inbox, "processed", path.basename(f2))));

  // --- fire: a daily cron is not due in the last-60s window; shape only ---
  const fired = await fireDue(paths);
  check("fireDue: returns {fires,count}", Array.isArray(fired.fires) && typeof fired.count === "number");

  // --- daily log ---
  const dl1 = dailyLogDue(paths);
  check("dailyLogDue: needed=true when log.md is absent", dl1.needed === true && typeof dl1.today === "string");
  const wl = writeLogEntry(paths, { date: dl1.today, body: "Scratch entry for the test." });
  check("writeLogEntry: writes log.md", wl.ok === true && fs.existsSync(path.join(paths.stateDir, "log.md")));
  check("dailyLogDue: needed=false once today's entry exists", dailyLogDue(paths).needed === false);

  // --- digest ---
  const dig = renderDigest(paths);
  check("renderDigest: one cached row rendered", dig.rows === 1);
  const digOut = fs.readFileSync(path.join(paths.stateDir, "heartbeats.md"), "utf-8");
  check("renderDigest: digest names the cell", digOut.includes("testcell"));

  // --- bootstrap: missing registry → graceful no-op ---
  const boot = await bootstrapInbox(paths);
  check("bootstrapInbox: no-op when the registry is missing", boot.count === 0);

  // --- end releases the sentinel ---
  end(paths);
  const after = JSON.parse(fs.readFileSync(path.join(rt, "pulse.json"), "utf-8"));
  check("end: clears the currentPulse sentinel", after.currentPulse === null);
  check("end: stamps lastPulse", typeof after.lastPulse === "string");
  check("begin: works again once the sentinel is released", begin(paths).skip === false);
} catch (e) {
  fail++;
  console.log("  x unexpected throw: " + (e && e.stack ? e.stack : e));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`pulse-core.test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
