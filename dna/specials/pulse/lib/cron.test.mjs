/**
 * cron.test.mjs — pins cron.mjs against the npm `cron-parser` reference.
 *
 * cron.mjs is vendored so pulse-core carries zero runtime deps; this test is
 * the safety net. It diffs the vendored evaluator's prev()/next() against
 * cron-parser across a battery of (expression, date) cases. cron-parser is a
 * dev-only oracle — present in the repo root, never shipped to a cell.
 *
 * Run from the repo so cron-parser resolves:
 *   node dna/specials/pulse/lib/cron.test.mjs
 */

import { CronExpressionParser } from "cron-parser";
import { cronNext, cronPrev, parseCron } from "./cron.mjs";

const EXPRS = [
  "* * * * *",
  "0 * * * *",
  "*/15 * * * *",
  "*/30 9-17 * * 1-5",
  "0 8 * * *",
  "30 6 * * 1-5",
  "0 0 1 * *",
  "0 12 * * 0",
  "0 0 * * 7",
  "0 9 * * 1",
  "5 0 * * 6",
  "15 3 1,15 * *",
  "0 22 * 1-3 *",
  "0 0 13 * 5",
  "0 0 29 2 *",
  "45 23 31 12 *",
  "0 0,6,12,18 * * *",
  "10-20 * * * *",
  "0 9 * * mon-fri",
  "0 0 1 jan,jul *",
];

const DATES = [
  "2026-05-20T10:30:45.123",
  "2026-05-20T10:30:00.000",
  "2026-01-01T00:00:00.000",
  "2026-12-31T23:59:30.000",
  "2026-02-27T12:00:00.000",
  "2024-02-28T23:59:00.000",
  "2026-06-30T18:45:10.000",
  "2027-03-01T00:00:00.000",
];

const iso = (d) => (d ? d.toISOString() : "null");

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

for (const expr of EXPRS) {
  for (const ds of DATES) {
    const from = new Date(ds);

    let refNext;
    let refPrev;
    try {
      refNext = CronExpressionParser.parse(expr, { currentDate: from }).next().toDate();
      refPrev = CronExpressionParser.parse(expr, { currentDate: from }).prev().toDate();
    } catch {
      skipped++; // cron-parser declined this case — nothing to compare against
      continue;
    }

    let mineNext;
    let minePrev;
    try {
      mineNext = cronNext(expr, from);
      minePrev = cronPrev(expr, from);
    } catch (e) {
      fail++;
      failures.push(`${expr} @ ${ds}: vendored threw — ${e.message}`);
      continue;
    }

    if (mineNext && mineNext.getTime() === refNext.getTime()) pass++;
    else { fail++; failures.push(`next  ${expr}  @ ${ds}: mine=${iso(mineNext)} ref=${iso(refNext)}`); }

    if (minePrev && minePrev.getTime() === refPrev.getTime()) pass++;
    else { fail++; failures.push(`prev  ${expr}  @ ${ds}: mine=${iso(minePrev)} ref=${iso(refPrev)}`); }
  }
}

// Malformed expressions must be rejected.
const BAD = ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * * * 9", "0 0 0 * *", "abc * * * *", "* * * 13 *"];
for (const expr of BAD) {
  let threw = false;
  try { parseCron(expr); } catch { threw = true; }
  if (threw) pass++;
  else { fail++; failures.push(`invalid "${expr}" was not rejected`); }
}

console.log(`cron.test: ${pass} passed, ${fail} failed, ${skipped} skipped`);
for (const f of failures) console.log("  x " + f);
process.exit(fail === 0 ? 0 : 1);
