/**
 * pulse-core.test.mjs — exercises the deterministic core against a scratch
 * runtime dir + a fake cronFile under tmp. Covers:
 *   - the concurrency sentinel (begin/end)
 *   - inbox drain + no-op skip
 *   - saveSchedule writes pulse-cache AND installs the cell's crontab block
 *   - forgetCell removes both cache and crontab block
 *   - syncCrontab rebuilds the cron file from pulse-cache
 *   - cron lines escape single quotes correctly
 *   - renderDigest emits a schedule-only digest (no firing record)
 *
 * Cron correctness itself is pinned by cron.test.mjs.
 *
 *   node dna/specials/pulse/lib/pulse-core.test.mjs
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolvePaths, begin, end, drainInbox, saveSchedule, forgetCell,
  bootstrapInbox, syncCrontab, renderDigest,
  installCrontabForCell, removeCrontabForCell,
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
  cronFile: path.join(tmp, "pulse-schedules"),
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

  // --- save schedule: writes cache AND installs crontab ---
  const saved = saveSchedule(paths, {
    cell: "testcell",
    items: [{ cron: "0 8 * * *", message: "refresh the dataset" }],
    sourcePath: drained[0].path,
  });
  check("saveSchedule: ok with one item", saved.ok === true && saved.count === 1);
  check("saveSchedule: cache file written", fs.existsSync(path.join(rt, "pulse-cache", "testcell.json")));
  check("saveSchedule: source archived to processed/",
    !fs.existsSync(f1) && fs.existsSync(path.join(inbox, "processed", path.basename(f1))));

  const cron1 = fs.readFileSync(paths.cronFile, "utf-8");
  check("saveSchedule: crontab file has the header", cron1.startsWith("# pulse-schedules"));
  check("saveSchedule: crontab has BEGIN/END marker for the cell",
    cron1.includes("# BEGIN pulse:testcell") && cron1.includes("# END pulse:testcell"));
  check("saveSchedule: crontab line carries the cron spec + message",
    cron1.includes("0 8 * * * root") && cron1.includes("refresh the dataset"));
  check("saveSchedule: crontab line sources cells-env.sh",
    cron1.includes(". /etc/profile.d/cells-env.sh"));
  check("saveSchedule: crontab line tees to cron-fires.log",
    cron1.includes(">> /root/.cells/logs/cron-fires.log"));

  // --- replacing a cell's schedule replaces the block, not appends ---
  const f2 = path.join(inbox, `testcell-${Date.now() + 5}.md`);
  fs.writeFileSync(f2, "# Heartbeat\n\n- 09:00 daily — different message.\n");
  drainInbox(paths); // surfaces f2 (different hash)
  saveSchedule(paths, {
    cell: "testcell",
    items: [{ cron: "0 9 * * *", message: "different message" }],
    sourcePath: f2,
  });
  const cron2 = fs.readFileSync(paths.cronFile, "utf-8");
  const blocks = (cron2.match(/# BEGIN pulse:testcell/g) ?? []).length;
  check("saveSchedule: replacing a cell's schedule keeps one block", blocks === 1);
  check("saveSchedule: replaced block has the new spec", cron2.includes("0 9 * * *"));
  check("saveSchedule: replaced block dropped the old spec", !cron2.includes("0 8 * * *"));

  // --- saveSchedule: rejects invalid cron ---
  const badCron = saveSchedule(paths, { cell: "x", items: [{ cron: "99 99 * * *", message: "nope" }] });
  check("saveSchedule: rejects an invalid cron", badCron.ok === false);

  // --- no-op skip: identical content re-pushed is auto-archived, not returned ---
  const f3 = path.join(inbox, `testcell-${Date.now() + 10}.md`);
  fs.writeFileSync(f3, "# Heartbeat\n\n- 09:00 daily — different message.\n");
  const drained3 = drainInbox(paths);
  check("drain: unchanged content auto-skipped (hash match)",
    drained3.length === 0 && fs.existsSync(path.join(inbox, "processed", path.basename(f3))));

  // --- shell quoting: a message containing single quotes round-trips ---
  saveSchedule(paths, {
    cell: "quoter",
    items: [{ cron: "*/5 * * * *", message: "it's time to check in" }],
  });
  const cronQuote = fs.readFileSync(paths.cronFile, "utf-8");
  check("saveSchedule: single quotes in message are properly escaped",
    cronQuote.includes(`'it'\\''s time to check in'`));

  // --- empty items: saveSchedule still writes cache but block is removed ---
  saveSchedule(paths, { cell: "quoter", items: [] });
  const cronEmpty = fs.readFileSync(paths.cronFile, "utf-8");
  check("saveSchedule: empty items removes the cell's block",
    !cronEmpty.includes("# BEGIN pulse:quoter"));
  check("saveSchedule: quoter cache file still present",
    fs.existsSync(path.join(rt, "pulse-cache", "quoter.json")));

  // --- forgetCell: drops cache and crontab block ---
  installCrontabForCell(paths, { cell: "ghost", items: [{ id: "wake-aaaaaa", cron: "0 7 * * *", message: "morning" }] });
  fs.writeFileSync(path.join(rt, "pulse-cache", "ghost.json"), JSON.stringify({ items: [], updatedAt: "x" }));
  const forgot = forgetCell(paths, { cell: "ghost" });
  check("forgetCell: ok", forgot.ok === true);
  check("forgetCell: removed cache", forgot.hadSchedule === true && !fs.existsSync(path.join(rt, "pulse-cache", "ghost.json")));
  check("forgetCell: removed cron block", forgot.cronRemoved === true);
  const cronAfterForget = fs.readFileSync(paths.cronFile, "utf-8");
  check("forgetCell: cron file no longer mentions the ghost cell",
    !cronAfterForget.includes("# BEGIN pulse:ghost"));

  // --- forgetCell: idempotent on a cell that was never there ---
  const forgotMissing = forgetCell(paths, { cell: "nobody" });
  check("forgetCell: idempotent on missing cell",
    forgotMissing.ok === true && forgotMissing.hadSchedule === false && forgotMissing.cronRemoved === false);

  // --- syncCrontab: rebuilds the cron file from pulse-cache ---
  // Trash the cron file, then sync; every cached cell should be restored.
  fs.writeFileSync(paths.cronFile, "# garbage\n");
  const synced = syncCrontab(paths);
  check("syncCrontab: ok", synced.ok === true);
  const cronSynced = fs.readFileSync(paths.cronFile, "utf-8");
  check("syncCrontab: restored header", cronSynced.startsWith("# pulse-schedules"));
  // testcell has 1 item (the replaced schedule), quoter has 0 (empty items).
  check("syncCrontab: testcell block present", cronSynced.includes("# BEGIN pulse:testcell"));
  check("syncCrontab: quoter block absent (no items)", !cronSynced.includes("# BEGIN pulse:quoter"));

  // --- removeCrontabForCell: idempotent ---
  const r1 = removeCrontabForCell(paths, { cell: "testcell" });
  check("removeCrontabForCell: removed on first call", r1.removed === true);
  const r2 = removeCrontabForCell(paths, { cell: "testcell" });
  check("removeCrontabForCell: idempotent on second call", r2.removed === false);

  // --- digest ---
  // Re-sync so the digest has a row to render.
  syncCrontab(paths);
  const dig = renderDigest(paths);
  check("renderDigest: rows >= 1 after sync", dig.rows >= 1);
  const digOut = fs.readFileSync(path.join(paths.stateDir, "heartbeats.md"), "utf-8");
  check("renderDigest: digest names the cell", digOut.includes("testcell"));
  check("renderDigest: digest no longer has recent-fires section",
    !digOut.includes("## Recent fires"));

  // --- bootstrap: missing registry → graceful no-op ---
  const boot = await bootstrapInbox(paths);
  check("bootstrapInbox: no-op when the registry is missing", boot.count === 0);

  // --- end releases the sentinel ---
  end(paths);
  const after = JSON.parse(fs.readFileSync(path.join(rt, "pulse.json"), "utf-8"));
  check("end: clears the currentPulse sentinel", after.currentPulse === null);
  check("end: stamps lastPulse", typeof after.lastPulse === "string");
  check("end: pulse.json no longer carries lastFire/log",
    after.lastFire === undefined && after.log === undefined);
  check("begin: works again once the sentinel is released", begin(paths).skip === false);
} catch (e) {
  fail++;
  console.log("  x unexpected throw: " + (e && e.stack ? e.stack : e));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`pulse-core.test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
