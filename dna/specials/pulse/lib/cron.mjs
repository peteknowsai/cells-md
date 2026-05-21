/**
 * cron.mjs — a minimal, dependency-free 5-field cron evaluator.
 *
 * pulse-core needs three things from a cron string: validate it, find the
 * most recent occurrence before a time, and find the next occurrence after
 * one. The npm `cron-parser` does this, but it only exists in the repo root
 * (and as a transitive pi dependency) — not on a claude-code cell running
 * plain node. Keeping pulse-core on `node:` builtins only means it runs
 * unchanged on any harness, so the evaluator is vendored here.
 *
 * Scope: standard 5-field crontab — `minute hour dom month dow`. Each field
 * is `*`, a number, an `lo-hi` range, a comma list, or any of those with a
 * `/step`. Month names (jan..dec) and day names (sun..sat) are accepted;
 * day-of-week takes 0 or 7 for Sunday. Evaluation is in local time, matching
 * how pulse schedules ("local time on this Mac").
 *
 * Correctness is pinned by cron.test.mjs, which diffs prev()/next() against
 * cron-parser across a battery of (expression, date) cases.
 */

const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Upper bound on minute-stepping. ~9 years covers the widest gap a valid
// 5-field cron can have (Feb 29 across a skipped-leap century boundary).
const MAX_STEPS = 9 * 366 * 24 * 60;

// Replace alphabetic names in a field (month / day-of-week) with their
// numbers. Leaves a nameless field (`*`, `1-5`, …) untouched.
function applyNames(field, names) {
  return field.replace(/[a-z]+/gi, (m) => {
    const v = names[m.toLowerCase()];
    if (v === undefined) throw new Error(`unknown name "${m}"`);
    return String(v);
  });
}

// Parse one comma-separated cron field into a Set of allowed integers.
function parseField(field, min, max) {
  const allowed = new Set();
  for (const rawTerm of field.split(",")) {
    const term = rawTerm.trim();
    if (term === "") throw new Error(`empty term in "${field}"`);
    let body = term;
    let step = 1;
    const slash = body.indexOf("/");
    if (slash !== -1) {
      step = Number(body.slice(slash + 1));
      body = body.slice(0, slash);
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${term}"`);
    }
    let lo;
    let hi;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const bits = body.split("-");
      if (bits.length !== 2) throw new Error(`bad range "${term}"`);
      lo = Number(bits[0]);
      hi = Number(bits[1]);
    } else {
      lo = Number(body);
      // A bare number with a step runs from that number up to the field max.
      hi = slash !== -1 ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`bad term "${term}"`);
    if (lo < min || hi > max || lo > hi) throw new Error(`term "${term}" out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

/**
 * Parse a 5-field cron expression. Throws on anything malformed.
 * @param {string} expr
 */
export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`expected 5 cron fields, got ${fields.length}: "${expr}"`);
  }
  const [minute, hour, dom, month, dow] = fields;
  const dowSet = parseField(applyNames(dow, DOW_NAMES), 0, 7);
  if (dowSet.has(7)) dowSet.add(0); // cron: 0 and 7 both mean Sunday
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(applyNames(month, MONTH_NAMES), 1, 12),
    dow: dowSet,
    // Per Vixie cron: when BOTH dom and dow are restricted, a day matches if
    // EITHER matches. A field counts as restricted when it isn't a bare "*".
    domRestricted: dom.trim() !== "*",
    dowRestricted: dow.trim() !== "*",
  };
}

// Does a Date (read in local time) satisfy the parsed cron?
function matches(c, d) {
  if (!c.minute.has(d.getMinutes())) return false;
  if (!c.hour.has(d.getHours())) return false;
  if (!c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

/**
 * The next occurrence strictly after `from`, or null if none within range.
 * @param {string} expr
 * @param {Date} from
 * @returns {Date|null}
 */
export function cronNext(expr, from) {
  const c = parseCron(expr);
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  // Step in absolute time (60000 ms), never local-clock minutes — local
  // stepping stalls at the spring-forward DST gap.
  let ms = start.getTime() + 60_000; // strictly after `from`'s minute
  for (let i = 0; i < MAX_STEPS; i++) {
    const d = new Date(ms);
    if (matches(c, d)) return d;
    ms += 60_000;
  }
  return null;
}

/**
 * The most recent occurrence strictly before `from`, or null if none within
 * range. When `from` falls mid-minute, that minute's :00 counts as before it.
 * @param {string} expr
 * @param {Date} from
 * @returns {Date|null}
 */
export function cronPrev(expr, from) {
  const c = parseCron(expr);
  const start = new Date(from.getTime());
  const midMinute = start.getSeconds() !== 0 || start.getMilliseconds() !== 0;
  start.setSeconds(0, 0);
  // Step in absolute time (60000 ms), never local-clock minutes — local
  // stepping stalls at the spring-forward DST gap.
  let ms = start.getTime();
  if (!midMinute) ms -= 60_000; // `from` was exactly on a minute → strictly before
  for (let i = 0; i < MAX_STEPS; i++) {
    const d = new Date(ms);
    if (matches(c, d)) return d;
    ms -= 60_000;
  }
  return null;
}
