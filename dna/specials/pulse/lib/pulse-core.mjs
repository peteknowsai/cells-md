/**
 * pulse-core — the harness-neutral guts of pulse.
 *
 * Pulse no longer fires wakes itself. Linux cron does. Pulse's job is to
 * translate each cell's prose schedule into crontab lines and keep the
 * cell's block in /etc/cron.d/pulse-schedules in sync. The Linux cron
 * daemon evaluates the file every minute and runs the lines.
 *
 * That makes pulse-core a thin layer:
 *
 *   - begin / end                    a 5-minute sentinel so two ticks
 *                                    can't translate the same inbox
 *   - drainInbox                     surface new HEARTBEAT.md pushes
 *   - saveSchedule                   write pulse-cache/<cell>.json AND
 *                                    rewrite the cell's crontab block
 *   - forgetCell                     drop cache + crontab block when a
 *                                    cell is destroyed
 *   - bootstrapInbox                 first-run seeding from the vault
 *   - renderDigest                   refresh heartbeats.md (the digest
 *                                    is now schedule-only; cron owns the
 *                                    firing record)
 *   - syncCrontab                    rebuild /etc/cron.d/pulse-schedules
 *                                    from pulse-cache (one-time migration
 *                                    + a manual recovery handle)
 *
 * The LLM only ever reasons about one thing: parsing inbox prose into
 * cron items. Everything else is pure compute.
 *
 * Paths are injected via resolvePaths(), never derived from __dirname,
 * so the module runs unchanged whether it's imported by a pi extension
 * or executed by plain `node` on a claude-code cell. Build a PulsePaths
 * once at startup and thread it into every operation.
 *
 * Durable state (all under runtimeDir):
 *   pulse.json              {lastPulse, currentPulse}
 *   pulse-inbox/            HEARTBEAT.md pushes from cells
 *   pulse-inbox/processed/  drained inbox archive
 *   pulse-cache/<cell>.json parsed schedule per cell
 *   logs/pulse-trace.log    one line per operation
 *
 * System surface:
 *   /etc/cron.d/pulse-schedules  the crontab file cron reads
 *
 * Vault-readable surface (under stateDir):
 *   heartbeats.md   digest table (renderDigest)
 *
 * Public-facing surface (under siteDir):
 *   index.html      pulse.cells.md dashboard (renderDashboard)
 */

import { createHash } from "node:crypto";
import { parseCron, cronNext, cronPrev } from "./cron.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// ---------- tunables ----------

// How long a currentPulse sentinel is live before a new pulse steals it.
const SENTINEL_MAX_MS = 5 * 60_000;

// Per-fire log file each crontab line tees to — for forensics, not for pulse.
// The literal target string baked into cron entries: those lines run inside
// the pulse cell, where ~/.cells resolves to /root/.cells. Kept as a literal
// (not derived from runtimeDir) so saveSchedule produces correct lines even
// when invoked from a host-side test with an overridden runtimeDir.
const CRON_FIRE_LOG = "/root/.cells/logs/cron-fires.log";

// Read-side: same file when running on the pulse cell, but derived from
// runtimeDir so tests can point it at a fixture.
const cronFireLog = (p) => path.join(p.runtimeDir, "logs", "cron-fires.log");

// ---------- paths ----------

/**
 * @typedef {object} PulsePaths
 * @property {string} runtimeDir    pulse.json, pulse-inbox/, pulse-cache/, logs/
 * @property {string} stateDir      heartbeats.md (vault-readable surface)
 * @property {string} registryPath  cells.json (bootstrap source)
 * @property {string} vaultDir      cell HEARTBEAT.md mirror root (bootstrap source)
 * @property {string} cronFile      /etc/cron.d/pulse-schedules — the crontab file
 * @property {string} siteDir       site/public/ — the cell's web presence
 */

/**
 * Build a PulsePaths from explicit overrides, then environment, then
 * defaults. Every caller resolves once at startup and threads the result.
 *
 *   runtimeDir: opts.runtimeDir ?? $PULSE_RUNTIME_DIR ?? ~/.cells
 *   stateDir:   opts.stateDir   ?? $PULSE_STATE_DIR   ?? <runtimeDir>/state
 *   cronFile:   opts.cronFile   ?? $PULSE_CRON_FILE   ?? /etc/cron.d/pulse-schedules
 *   siteDir:    opts.siteDir    ?? $PULSE_SITE_DIR    ?? ~/site/public
 *
 * @param {Partial<PulsePaths>} [opts]
 * @returns {PulsePaths}
 */
export function resolvePaths(opts = {}) {
  const home = homedir();
  const cellsDir = path.join(home, ".cells");
  const runtimeDir = opts.runtimeDir ?? process.env.PULSE_RUNTIME_DIR ?? cellsDir;
  const stateDir = opts.stateDir ?? process.env.PULSE_STATE_DIR ?? path.join(runtimeDir, "state");
  const registryPath = opts.registryPath ?? path.join(cellsDir, "cells.json");
  const vaultDir = opts.vaultDir ?? path.join(home, "Obsidian", "cells");
  const cronFile = opts.cronFile ?? process.env.PULSE_CRON_FILE ?? "/etc/cron.d/pulse-schedules";
  const siteDir = opts.siteDir ?? process.env.PULSE_SITE_DIR ?? path.join(home, "site", "public");
  return { runtimeDir, stateDir, registryPath, vaultDir, cronFile, siteDir };
}

// Sub-paths derived from a PulsePaths. Kept as functions so PulsePaths
// stays a plain data object that's trivial to construct and log.
const statePath = (p) => path.join(p.runtimeDir, "pulse.json");
const inboxDir = (p) => path.join(p.runtimeDir, "pulse-inbox");
const processedDir = (p) => path.join(inboxDir(p), "processed");
const cacheDir = (p) => path.join(p.runtimeDir, "pulse-cache");
const logsDir = (p) => path.join(p.runtimeDir, "logs");
const traceLog = (p) => path.join(logsDir(p), "pulse-trace.log");
const heartbeatsMd = (p) => path.join(p.stateDir, "heartbeats.md");
const siteIndexHtml = (p) => path.join(p.siteDir, "index.html");

// ---------- helpers ----------

function ensureDirs(p) {
  for (const d of [p.runtimeDir, inboxDir(p), processedDir(p), cacheDir(p), p.stateDir, logsDir(p)]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

// Stable, human-readable id: slug from message + 6-char hash of
// (cron, normalized message). Same prose -> same id even after an LLM
// re-parse — keeps the cron block stable across translations.
function deriveId(cron, message) {
  const normMsg = message.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const slug = normMsg.replace(/\s+/g, "-").slice(0, 24).replace(/-+$/, "") || "wake";
  const hash = sha(cron + "\0" + normMsg).slice(0, 6);
  return `${slug}-${hash}`;
}

// Format an ISO timestamp as Pete-local short form ("2026-05-02 06:26:26").
function formatLocal(iso) {
  if (!iso || iso === "—") return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-CA", { hour12: false }).replace(",", "");
}

// Append a trace line to logs/pulse-trace.log. Best-effort, never throws.
function appendTrace(p, line) {
  try {
    fs.mkdirSync(logsDir(p), { recursive: true });
    fs.appendFileSync(traceLog(p), `${new Date().toISOString()}  ${line}\n`);
  } catch { /* swallow — trace logging is best-effort */ }
}

function readState(p) {
  if (!fs.existsSync(statePath(p))) {
    return { lastPulse: null, currentPulse: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(p), "utf-8"));
    return {
      lastPulse: raw.lastPulse ?? null,
      currentPulse: raw.currentPulse ?? null,
    };
  } catch {
    return { lastPulse: null, currentPulse: null };
  }
}

function writeState(p, state) {
  ensureDirs(p);
  const tmp = statePath(p) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath(p));
}

function listSchedules(p) {
  if (!fs.existsSync(cacheDir(p))) return [];
  const out = [];
  for (const f of fs.readdirSync(cacheDir(p))) {
    if (!f.endsWith(".json")) continue;
    const cell = f.replace(/\.json$/, "");
    try {
      const sched = JSON.parse(fs.readFileSync(path.join(cacheDir(p), f), "utf-8"));
      out.push({ cell, schedule: sched });
    } catch { /* skip corrupt */ }
  }
  return out;
}

// ---------- crontab management ----------

// Header lines for /etc/cron.d/pulse-schedules. Cron reads /etc/cron.d
// files with no shell profile sourced, so we need explicit SHELL + PATH
// and have to source cells-env.sh inside each line to pick up
// CELLS_PROXY_SECRET and friends.
const CRON_HEADER = [
  "# pulse-schedules — managed by pulse-core. Hand-edits will be overwritten.",
  "SHELL=/bin/bash",
  "PATH=/root/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin",
  "",
].join("\n");

const BLOCK_BEGIN = (cell) => `# BEGIN pulse:${cell}`;
const BLOCK_END = (cell) => `# END pulse:${cell}`;

// POSIX-safe single-quote a string for embedding in a shell command.
// Single-quote, replace each ' with '\'', single-quote.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Build one /etc/cron.d line. /etc/cron.d entries have a user field
// before the command (unlike user crontabs).
//
// Wraps `cells talk` in cron-fire.sh, which times the call end-to-end
// and emits an enriched JSON line per fire (latency_ms, exit, etc.) so
// the dashboard can spot slow/failed acks. cron-fire.sh handles its
// own >> log redirection.
function cronLine(cell, item) {
  const cmd =
    `. /etc/profile.d/cells-env.sh && ` +
    `/root/bin/cron-fire.sh ${shellQuote(cell)} ${shellQuote(item.id)} ${shellQuote(item.message)}`;
  // Per-cell-id label as a trailing comment for easier grep + audit.
  return `${item.cron} root ${cmd}  # ${cell}:${item.id}`;
}

// Read /etc/cron.d/pulse-schedules; if missing or unreadable, return the
// header so the caller starts from a known-good state.
function readCronFile(cronFile) {
  try {
    return fs.readFileSync(cronFile, "utf-8");
  } catch {
    return CRON_HEADER;
  }
}

function writeCronFile(cronFile, contents) {
  fs.mkdirSync(path.dirname(cronFile), { recursive: true });
  // /etc/cron.d entries must be mode 0644 and not have a "." in the
  // basename. We write atomically via tmp+rename — cron picks up the
  // file mtime on its next scan, no reload needed.
  const tmp = cronFile + ".tmp";
  fs.writeFileSync(tmp, contents);
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, cronFile);
}

// Strip an existing pulse:<cell> block. Returns {found, contents}.
function stripCellBlock(contents, cell) {
  const begin = BLOCK_BEGIN(cell);
  const end = BLOCK_END(cell);
  const lines = contents.split("\n");
  const out = [];
  let inBlock = false;
  let found = false;
  for (const line of lines) {
    if (line === begin) { inBlock = true; found = true; continue; }
    if (inBlock && line === end) { inBlock = false; continue; }
    if (inBlock) continue;
    out.push(line);
  }
  return { found, contents: out.join("\n") };
}

// Ensure contents starts with our header. Idempotent.
function ensureHeader(contents) {
  if (contents.startsWith("# pulse-schedules")) return contents;
  return CRON_HEADER + (contents.startsWith("\n") ? contents.slice(1) : contents);
}

// Rewrite the cell's block in /etc/cron.d/pulse-schedules. Atomic: tmp +
// rename so cron never sees a half-written file. Idempotent: items=[]
// removes the block entirely.
function installCrontabForCell(p, { cell, items }) {
  let contents = ensureHeader(readCronFile(p.cronFile));
  const stripped = stripCellBlock(contents, cell);
  contents = stripped.contents.replace(/\n+$/, "") + "\n";
  if (items.length > 0) {
    const block = [
      BLOCK_BEGIN(cell),
      ...items.map((it) => cronLine(cell, it)),
      BLOCK_END(cell),
      "",
    ].join("\n");
    contents += "\n" + block;
  }
  writeCronFile(p.cronFile, contents);
  return { ok: true, cell, count: items.length };
}

function removeCrontabForCell(p, { cell }) {
  const contents = readCronFile(p.cronFile);
  const { found, contents: stripped } = stripCellBlock(ensureHeader(contents), cell);
  if (!found) return { ok: true, cell, removed: false };
  writeCronFile(p.cronFile, stripped.replace(/\n+$/, "") + "\n");
  return { ok: true, cell, removed: true };
}

// ---------- operations ----------

/**
 * Start a pulse. Acquires the currentPulse sentinel (5-minute staleness
 * window). If skip=true, the caller must stop immediately — a prior pulse
 * is in flight — and must NOT call end(); the prior pulse will.
 *
 * @returns {{skip: boolean, reason?: string, isFirstRun: boolean, now: string}}
 */
export function begin(p) {
  ensureDirs(p);
  const state = readState(p);
  const now = new Date();
  const nowIso = now.toISOString();

  if (state.currentPulse) {
    const ageMs = now.getTime() - new Date(state.currentPulse).getTime();
    if (ageMs < SENTINEL_MAX_MS) {
      appendTrace(p, `begin skip — prior pulse in flight since ${state.currentPulse}`);
      return { skip: true, reason: `prior pulse in flight since ${state.currentPulse}`, isFirstRun: false, now: nowIso };
    }
    // Stale sentinel — prior pulse crashed. Take over.
    appendTrace(p, `begin steal stale sentinel age=${Math.round(ageMs / 1000)}s`);
  }

  const isFirstRun = !fs.existsSync(cacheDir(p)) || fs.readdirSync(cacheDir(p)).length === 0;
  state.currentPulse = nowIso;
  writeState(p, state);
  appendTrace(p, `begin firstRun=${isFirstRun}`);
  return { skip: false, isFirstRun, now: nowIso };
}

/**
 * Finalize a pulse. Clears the currentPulse sentinel and stamps lastPulse.
 * Always call this last, even if earlier steps no-oped.
 */
export function end(p) {
  const state = readState(p);
  state.currentPulse = null;
  state.lastPulse = new Date().toISOString();
  writeState(p, state);
  appendTrace(p, "end");
  return { ok: true };
}

/**
 * Read every inbox file (excluding processed/). Entries whose content hash
 * matches the cell's cached schedule (no-op edits) are auto-archived to
 * processed/ and NOT returned — the caller's LLM only sees entries that
 * genuinely need re-parsing.
 *
 * @returns {Array<{cell: string, content: string, path: string, ts: string}>}
 */
export function drainInbox(p) {
  ensureDirs(p);
  const entries = [];
  let skipped = 0;
  for (const f of fs.readdirSync(inboxDir(p))) {
    const full = path.join(inboxDir(p), f);
    if (fs.statSync(full).isDirectory()) continue;
    // filename convention: <cell>-<ts-ms>.md
    const m = f.match(/^(.+)-(\d+)\.md$/);
    if (!m) continue;
    const cell = m[1];
    const ts = new Date(parseInt(m[2], 10)).toISOString();
    const content = fs.readFileSync(full, "utf-8");

    // No-op skip: cache exists and its contentHash matches — nothing new.
    const cachePath = path.join(cacheDir(p), `${cell}.json`);
    if (fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        if (cached.contentHash && cached.contentHash === sha(content)) {
          fs.renameSync(full, path.join(processedDir(p), path.basename(full)));
          skipped++;
          continue;
        }
      } catch { /* corrupt cache — fall through and let the caller re-parse */ }
    }

    entries.push({ cell, content, path: full, ts });
  }
  // Oldest-first so a cell that pushed twice gets its newer schedule last.
  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  appendTrace(p, `drain_inbox returned=${entries.length} skipped_unchanged=${skipped}`);
  return entries;
}

/**
 * Write a parsed schedule to pulse-cache/<cell>.json AND install the
 * cell's block in /etc/cron.d/pulse-schedules. Items are {cron, message}
 * (any id is ignored — the tool derives a deterministic slug+hash so the
 * same prose always yields the same id). Also moves the source inbox
 * file to processed/. Returns {ok:false, error} on an invalid cron string.
 *
 * @param {PulsePaths} p
 * @param {{cell: string, items: Array<{cron: string, message: string}>, sourcePath?: string}} params
 */
export function saveSchedule(p, { cell, items: rawItems, sourcePath }) {
  ensureDirs(p);
  // Validate every cron string before writing.
  for (const item of rawItems) {
    try {
      parseCron(item.cron);
    } catch (e) {
      return { ok: false, error: `invalid cron "${item.cron}" for ${cell} — ${e.message}` };
    }
  }

  // Derive deterministic ids from (cron, normalized message).
  const items = rawItems.map((it) => ({
    id: deriveId(it.cron, it.message),
    cron: it.cron,
    message: it.message,
  }));

  // Hash the source inbox content so drainInbox can short-circuit future
  // no-op pushes for this cell.
  let contentHash;
  if (sourcePath && fs.existsSync(sourcePath)) {
    try {
      contentHash = sha(fs.readFileSync(sourcePath, "utf-8"));
    } catch { /* ignore — degrades to always re-parsing for this cell */ }
  }

  const sched = { items, updatedAt: new Date().toISOString(), ...(contentHash ? { contentHash } : {}) };
  fs.writeFileSync(path.join(cacheDir(p), `${cell}.json`), JSON.stringify(sched, null, 2));

  // Push the schedule into cron. Best-effort: if /etc/cron.d isn't
  // writable (running under tests outside root, dev box, etc.) we still
  // want save-schedule to succeed — the cache is the source of truth and
  // syncCrontab can replay later. So we catch and surface the error in
  // the result rather than aborting the save.
  let cronErr;
  try {
    installCrontabForCell(p, { cell, items });
  } catch (e) {
    cronErr = e instanceof Error ? e.message : String(e);
  }

  if (sourcePath && fs.existsSync(sourcePath)) {
    fs.renameSync(sourcePath, path.join(processedDir(p), path.basename(sourcePath)));
  }
  appendTrace(p, `save_schedule cell=${cell} items=${items.length}${cronErr ? ` cron_err=${cronErr}` : ""}`);
  return { ok: true, cell, count: items.length, ...(cronErr ? { cronError: cronErr } : {}) };
}

/**
 * Drop all schedule state for a cell — used when the cell is destroyed so
 * pulse stops trying to wake a ghost. Idempotent: returns ok:true with zeros
 * even when there was nothing to forget.
 *
 *   - deletes pulse-cache/<cell>.json (the schedule cache)
 *   - removes the cell's block from /etc/cron.d/pulse-schedules
 *   - removes <cell>-*.md files from the live inbox and processed/ archive
 *     so the dead cell can't surface again on a future drain
 *
 * @returns {{ok: true, cell: string, hadSchedule: boolean, cronRemoved: boolean, removedInbox: number, removedProcessed: number}}
 */
export function forgetCell(p, { cell }) {
  ensureDirs(p);
  const cachePath = path.join(cacheDir(p), `${cell}.json`);
  const hadSchedule = fs.existsSync(cachePath);
  if (hadSchedule) fs.unlinkSync(cachePath);

  let cronRemoved = false;
  let cronErr;
  try {
    const r = removeCrontabForCell(p, { cell });
    cronRemoved = !!r.removed;
  } catch (e) {
    cronErr = e instanceof Error ? e.message : String(e);
  }

  const filePrefix = `${cell}-`;
  let removedInbox = 0;
  let removedProcessed = 0;
  for (const [dir, isProcessed] of [[inboxDir(p), false], [processedDir(p), true]]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(filePrefix) || !name.endsWith(".md")) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
        if (isProcessed) removedProcessed++; else removedInbox++;
      } catch { /* best-effort */ }
    }
  }

  appendTrace(p, `forget_cell cell=${cell} hadSchedule=${hadSchedule} cronRemoved=${cronRemoved} removedInbox=${removedInbox} removedProcessed=${removedProcessed}${cronErr ? ` cron_err=${cronErr}` : ""}`);
  return { ok: true, cell, hadSchedule, cronRemoved, removedInbox, removedProcessed, ...(cronErr ? { cronError: cronErr } : {}) };
}

/**
 * Rebuild /etc/cron.d/pulse-schedules from every pulse-cache/<cell>.json.
 * Used at first install and as a manual recovery handle. Idempotent.
 *
 * @returns {{ok: true, cells: number, items: number}}
 */
export function syncCrontab(p) {
  ensureDirs(p);
  // Reset the file to header-only, then re-install every cached cell.
  writeCronFile(p.cronFile, CRON_HEADER);
  const schedules = listSchedules(p);
  let items = 0;
  for (const { cell, schedule } of schedules) {
    const itemsForCell = (schedule.items ?? []).map((it) => ({
      id: it.id ?? deriveId(it.cron, it.message),
      cron: it.cron,
      message: it.message,
    }));
    installCrontabForCell(p, { cell, items: itemsForCell });
    items += itemsForCell.length;
  }
  appendTrace(p, `sync_crontab cells=${schedules.length} items=${items}`);
  return { ok: true, cells: schedules.length, items };
}

/**
 * No-op. Seeding is MAC-DRIVEN, not in-well.
 *
 * This once walked the registry (~/.cells/cells.json) + the Obsidian vault to
 * synthesize a first-run inbox. But neither exists inside a pulse well — only
 * mother gets the registry, via /bridge/registry/read at runtime — so it has
 * always returned 0 in production. A pulse is seeded entirely by the Mac: the
 * proxy pushes each cell's HEARTBEAT.md into the owning pulse's inbox on every
 * change (cli/proxy.ts bridgeInboxPulse), and the Mac re-seeds on a
 * project-pulse birth/death/retag handoff (cli/cells.ts).
 *
 * Keeping it a hard no-op (rather than a registry walk) is load-bearing for
 * per-project pulse: if a registry ever DID appear in a pulse well, the old
 * walk would seed the ENTIRE fleet into THIS pulse — and a project pulse would
 * then double-fire every cell. The Mac is the sole ownership authority; the
 * in-well pulse only ever drains what it was handed.
 *
 * @returns {Promise<{count: number, note: string}>}
 */
export async function bootstrapInbox(p) {
  ensureDirs(p);
  appendTrace(p, `bootstrap_inbox noop (seeding is Mac-driven)`);
  return { count: 0, note: "no-op: seeding is Mac-driven (proxy push + birth/death handoff)" };
}

/**
 * Rewrite stateDir/heartbeats.md — a markdown table of every cell's
 * schedule + next-fire time. Pure compute over the cache. Cron now owns
 * the firing record, so there is no recent-fires section here; for fire
 * forensics, tail /root/.cells/logs/cron-fires.log on the pulse cell.
 *
 * @returns {{rows: number}}
 */
export function renderDigest(p) {
  ensureDirs(p);
  const schedules = listSchedules(p);
  const now = new Date();

  const lines = [
    "# Heartbeats",
    "",
    `_Generated ${formatLocal(now.toISOString())} (local) · ${now.toISOString()} (UTC)._`,
    "",
    "_Cron fires these — see \`/root/.cells/logs/cron-fires.log\` on the pulse cell for the firing record._",
    "",
    "| cell | id | cron | message | next fire |",
    "|---|---|---|---|---|",
  ];

  // Row: [cell, id, cron, message, nextFire, nextMs]
  const rows = [];
  for (const { cell, schedule } of schedules) {
    for (const item of schedule.items) {
      let nextLocal = "—";
      let nextMs = Number.MAX_SAFE_INTEGER;
      try {
        const n = cronNext(item.cron, now);
        if (n) {
          nextLocal = formatLocal(n.toISOString());
          nextMs = n.getTime();
        }
      } catch { /* invalid cron — leave dash */ }
      const msg = item.message.length > 60 ? item.message.slice(0, 57) + "..." : item.message;
      rows.push([cell, item.id, item.cron, msg.replace(/\|/g, "\\|"), nextLocal, nextMs]);
    }
  }
  // Sort by next fire (soonest first).
  rows.sort((a, b) => a[5] - b[5]);
  for (const r of rows) {
    lines.push(`| ${r[0]} | ${r[1]} | \`${r[2]}\` | ${r[3]} | ${r[4]} |`);
  }
  if (rows.length === 0) lines.push("| _(no schedules cached)_ | | | | |");

  fs.writeFileSync(heartbeatsMd(p), lines.join("\n") + "\n");
  appendTrace(p, `render_digest rows=${rows.length}`);
  return { rows: rows.length };
}

// ---------- dashboard ----------

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// "5m ago", "2h ago", "—" if no input
function relTime(iso, now) {
  if (!iso) return "—";
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Parse one line of cron-fires.log.
//
// Two formats coexist on this log:
//   Legacy (raw `cells talk` output): {"ok":true,"command":"talk","data":{"corr_id":"…","sent_to":"<cell>"}}
//   Enriched (cron-fire.sh wrapper):  {"v":1,"cell":"<cell>","id":"<schedule-id>","start_ms":…,"end_ms":…,"latency_ms":…,"exit":<int>,"talk":{…}}
//
// Returns a normalized record or null if the line is unparseable.
function parseFireLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }

  // Enriched format — has a version + latency.
  if (j?.v === 1 && typeof j.start_ms === "number") {
    const corr = j?.talk?.data?.corr_id ?? null;
    return {
      v: 1,
      cell: j.cell ?? j?.talk?.data?.sent_to ?? "?",
      id: j.id ?? null,
      ts: new Date(j.start_ms).toISOString(),
      latency_ms: typeof j.latency_ms === "number" ? j.latency_ms : null,
      exit: typeof j.exit === "number" ? j.exit : null,
      ok: j.exit === 0,
      corr: corr ? String(corr).slice(-10) : "",
    };
  }

  // Legacy format — ULID gives us approximate fire time, no latency.
  if (j?.command === "talk" && j?.data) {
    const corr = j.data.corr_id ?? null;
    return {
      v: 0,
      cell: j.data.sent_to ?? "?",
      id: null,
      ts: ulidTime(corr),
      latency_ms: null,
      exit: j.ok ? 0 : null,
      ok: !!j.ok,
      corr: corr ? String(corr).slice(-10) : "",
    };
  }

  return null;
}

function readFireLog(p) {
  let raw;
  try { raw = fs.readFileSync(cronFireLog(p), "utf8"); } catch { return []; }
  const records = [];
  for (const line of raw.split(/\n+/)) {
    if (!line.trim()) continue;
    const rec = parseFireLine(line);
    if (rec) records.push(rec);
  }
  return records;
}

function readRecentFires(p, maxLines = 20) {
  const all = readFireLog(p);
  return all.slice(-maxLines).reverse();
}

// For each scheduled item, find its most recent expected fire time
// (via cronPrev) and check whether the fire log carries a matching
// entry within ±matchWindowMs. Used by the dashboard to flag misses.
//
// Returns the same `rows` shape it was given, with each row enriched:
//   lastExpected: ISO | null
//   lastActual:   ISO | null  (timestamp from log, if matched)
//   matchedFire:  Fire | null
//   status:       "fired" | "missed" | "pending" | "none"
//
// "pending" means the last expected fire is so recent (within
// pendingWindowMs) that the cron line may still be running. "none"
// means the cron expression is invalid or has never had a fire yet.
function annotateSchedulesWithStatus(rows, fires, now, opts = {}) {
  const matchWindow = opts.matchWindowMs ?? 5 * 60_000;
  const pendingWindow = opts.pendingWindowMs ?? 3 * 60_000;
  const annotated = [];
  for (const r of rows) {
    let lastExpected = null;
    try {
      const prev = cronPrev(r.cron, now);
      if (prev) lastExpected = prev;
    } catch { /* invalid cron */ }

    let matched = null;
    if (lastExpected) {
      const lo = lastExpected.getTime() - matchWindow;
      const hi = lastExpected.getTime() + matchWindow;
      for (const f of fires) {
        if (f.cell !== r.cell) continue;
        if (!f.ts) continue;
        const t = new Date(f.ts).getTime();
        if (t >= lo && t <= hi) { matched = f; break; }
      }
    }

    let status;
    if (!lastExpected) status = "none";
    else if (matched) status = "fired";
    else if (now.getTime() - lastExpected.getTime() < pendingWindow) status = "pending";
    else status = "missed";

    annotated.push({
      ...r,
      lastExpected: lastExpected ? lastExpected.toISOString() : null,
      lastActual: matched?.ts ?? null,
      matchedFire: matched,
      status,
    });
  }
  return annotated;
}

// Decode the timestamp from a ULID's first 10 base32 chars (Crockford).
// Returns null on malformed input.
function ulidTime(ulid) {
  if (typeof ulid !== "string" || ulid.length < 10) return null;
  const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ms = 0;
  for (let i = 0; i < 10; i++) {
    const c = ALPHA.indexOf(ulid[i].toUpperCase());
    if (c < 0) return null;
    ms = ms * 32 + c;
  }
  return new Date(ms).toISOString();
}

/**
 * Render the pulse.cells.md status dashboard.
 *
 * Reads current pulse state, schedules, inbox depth, and recent
 * cron-fires log entries, then writes a self-contained HTML file at
 * <siteDir>/index.html. The cell's site server already debounce-
 * publishes any change under public/ up to the Worker, so dropping a
 * new file here propagates to pulse.cells.md within a second or two.
 *
 * Static page — all dynamic content is baked in at render time. The
 * skill calls this once per tick (after `render`) so the page reflects
 * the latest pulse state with no client-side fetches.
 */
export function renderDashboard(p) {
  ensureDirs(p);
  const now = new Date();
  const state = readState(p);
  const lastPulse = state.lastPulse ?? null;
  const currentPulse = state.currentPulse ?? null;

  const schedules = listSchedules(p);
  const rows = [];
  for (const { cell, schedule } of schedules) {
    for (const item of schedule.items) {
      let next = null;
      let nextMs = Number.MAX_SAFE_INTEGER;
      try {
        const n = cronNext(item.cron, now);
        if (n) { next = n; nextMs = n.getTime(); }
      } catch { /* invalid cron */ }
      rows.push({ cell, id: item.id, cron: item.cron, message: item.message, next, nextMs });
    }
  }
  rows.sort((a, b) => a.nextMs - b.nextMs);

  let inboxDepth = 0;
  try {
    inboxDepth = fs.readdirSync(inboxDir(p))
      .filter((f) => f.endsWith(".md") && !f.startsWith("."))
      .length;
  } catch { /* inbox dir absent → 0 */ }

  // All fire-log records for missed-fire matching; recent slice for the table.
  const allFires = readFireLog(p);
  const fires = allFires.slice(-20).reverse();
  const cellCount = new Set(rows.map((r) => r.cell)).size;

  const annotatedRows = annotateSchedulesWithStatus(rows, allFires, now);
  const missedCount = annotatedRows.filter((r) => r.status === "missed").length;

  const html = renderDashboardHTML({
    now, lastPulse, currentPulse, rows: annotatedRows, fires, inboxDepth, cellCount, missedCount,
  });

  const out = siteIndexHtml(p);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  appendTrace(p, `render_dashboard rows=${rows.length} fires=${fires.length} inbox=${inboxDepth} missed=${missedCount}`);
  return { rows: rows.length, fires: fires.length, inbox: inboxDepth, cells: cellCount, missed: missedCount };
}

function statusBadge(status) {
  if (status === "fired")   return `<span class="badge ok">✓ fired</span>`;
  if (status === "missed")  return `<span class="badge missed">✗ missed</span>`;
  if (status === "pending") return `<span class="badge pending">· pending</span>`;
  return `<span class="badge dim">—</span>`;
}

function formatLatency(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function latencyClass(ms) {
  if (ms == null) return "dim";
  if (ms > 120_000) return "slow";  // >2min — talk likely hit timeout
  if (ms > 30_000)  return "warn";  // >30s — sluggish but ok
  return "";
}

function renderDashboardHTML({ now, lastPulse, currentPulse, rows, fires, inboxDepth, cellCount, missedCount }) {
  const generated = formatLocal(now.toISOString());
  const lastPulseRel = relTime(lastPulse, now);

  const scheduleRows = rows.map((r) => {
    const lastActualCell = r.matchedFire?.ts
      ? `${htmlEscape(formatLocal(r.matchedFire.ts))}${r.matchedFire.latency_ms != null ? ` <span class="dim">(${htmlEscape(formatLatency(r.matchedFire.latency_ms))})</span>` : ""}`
      : (r.lastExpected ? `<span class="dim">expected ${htmlEscape(formatLocal(r.lastExpected))}</span>` : "—");
    return `
    <tr class="${r.status === "missed" ? "err" : ""}">
      <td>${statusBadge(r.status)}</td>
      <td><b>${htmlEscape(r.cell)}</b></td>
      <td><code>${htmlEscape(r.cron)}</code></td>
      <td class="num">${r.next ? htmlEscape(formatLocal(r.next.toISOString())) : "—"}</td>
      <td class="num">${lastActualCell}</td>
      <td>${htmlEscape(r.message)}</td>
    </tr>`;
  }).join("");

  const fireRows = fires.map((f) => `
    <tr class="${f.ok ? "" : "err"}">
      <td class="num">${f.ts ? htmlEscape(formatLocal(f.ts)) : "—"}</td>
      <td><b>${htmlEscape(f.cell)}</b></td>
      <td class="num ${latencyClass(f.latency_ms)}">${htmlEscape(formatLatency(f.latency_ms))}</td>
      <td>${f.ok ? "ok" : "fail"}</td>
      <td class="dim"><code>${htmlEscape(f.corr)}</code></td>
    </tr>`).join("");

  const tickStatus = currentPulse ? `tick in flight since ${formatLocal(currentPulse)}` : `idle`;

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pulse</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A7%AC%3C/text%3E%3C/svg%3E">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif;
         max-width: 960px; margin: 2.5em auto; padding: 0 1.25em;
         color: #ddd; background: #111; }
  h1 { font-size: 1.8em; margin: 0 0 0.1em; }
  h2 { font-size: 1.1em; margin: 2.2em 0 0.5em; color: #fff; border-bottom: 1px solid #333; padding-bottom: 0.3em; }
  .sub { color: #888; margin: 0 0 1.8em; font-size: 0.9em; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
           gap: 0.6em; margin: 1.5em 0 0.5em; }
  .stat { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px;
          padding: 0.7em 0.9em; }
  .stat .k { font-size: 0.75em; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat .v { font-size: 1.3em; color: #fff; margin-top: 0.2em; font-variant-numeric: tabular-nums; }
  .stat .v.sm { font-size: 1em; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { padding: 0.45em 0.6em; text-align: left; border-bottom: 1px solid #222; vertical-align: top; }
  th { color: #999; font-weight: normal; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; color: #ccc; }
  td.dim { color: #777; }
  tr.err td { color: #f88; }
  td.warn { color: #fc6; }
  td.slow { color: #f88; }
  .badge { display: inline-block; padding: 0.05em 0.55em; border-radius: 999px;
           font-size: 0.78em; letter-spacing: 0.02em; white-space: nowrap;
           border: 1px solid currentColor; }
  .badge.ok { color: #6f9; }
  .badge.missed { color: #f88; }
  .badge.pending { color: #fc6; }
  .badge.dim { color: #555; }
  code { background: #8881; padding: 0.1em 0.4em; border-radius: 3px; font-size: 0.92em; }
  .empty { color: #666; font-style: italic; padding: 0.6em; }
  pre.diagram { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px;
                padding: 1em 1.2em; overflow-x: auto; color: #ccc;
                font: 12.5px/1.45 ui-monospace, "SF Mono", Menlo, monospace; }
  .prose { color: #bbb; }
  .prose code { color: #ddd; }
  a { color: #6cf; }
</style>
<body>
  <h1>🧬 pulse</h1>
  <p class="sub">Family scheduler. Compiles each cell's <code>HEARTBEAT.md</code> into a crontab. Linux cron fires; pulse just keeps the file in sync. Generated ${htmlEscape(generated)}.</p>

  <div class="stats">
    <div class="stat"><div class="k">last tick</div><div class="v">${htmlEscape(lastPulseRel)}</div></div>
    <div class="stat"><div class="k">scheduled</div><div class="v">${rows.length} <span style="color:#888;font-size:0.7em">across ${cellCount} cells</span></div></div>
    <div class="stat"><div class="k">inbox</div><div class="v">${inboxDepth}</div></div>
    <div class="stat"><div class="k">${missedCount > 0 ? "<span style='color:#f88'>misses (24h)</span>" : "misses (24h)"}</div><div class="v ${missedCount > 0 ? "" : "sm"}" style="${missedCount > 0 ? "color:#f88" : ""}">${missedCount}</div></div>
  </div>

  <h2>active schedules</h2>
  ${rows.length === 0 ? '<div class="empty">no schedules cached — fleet is quiet.</div>' : `
  <table>
    <thead><tr><th>status</th><th>cell</th><th>cron (mountain)</th><th>next fire</th><th>last fire</th><th>message</th></tr></thead>
    <tbody>${scheduleRows}</tbody>
  </table>`}

  <h2>recent fires</h2>
  ${fires.length === 0 ? '<div class="empty">nothing fired yet.</div>' : `
  <table>
    <thead><tr><th>time</th><th>cell</th><th>latency</th><th>result</th><th>corr</th></tr></thead>
    <tbody>${fireRows}</tbody>
  </table>`}

  <h2>how pulse works</h2>
  <pre class="diagram">fleet cell edits HEARTBEAT.md
   │  (PostToolUse hook)
   ▼
proxy /heartbeat-changed
   │
   ▼
~/.cells/pulse-inbox/  ← Mac-side queue, survives pulse hibernating
   │  every ~60s
   ▼
[cells-pulse cell] claude --print runs the pulse skill:
   drain inbox → translate prose → cron lines
   save-schedule → writes /etc/cron.d/pulse-schedules
   render → refresh state/heartbeats.md digest
   render-dashboard → writes this page
   │
   ▼
/etc/cron.d/pulse-schedules  ← Linux cron evaluates every minute
   │  matched lines fire
   ▼
cron-fire.sh wraps:  cells talk --await &lt;cell&gt; "&lt;msg&gt;"
   │  times the call, logs latency + exit code
   ▼
/root/.cells/logs/cron-fires.log</pre>

  <div class="prose">
    <p><b>Push for schedule updates, pull for firing.</b> When a cell edits its <code>HEARTBEAT.md</code>, a hook pushes the change to pulse via the proxy. Pulse drains that inbox every ~60s, parses prose like <i>"every weekday at 8am"</i> into a 5-field crontab line, and writes it into <code>/etc/cron.d/pulse-schedules</code>. From there Linux <b>cron</b> is the fire engine — pulse is just the prose-to-cron compiler.</p>

    <p><b>Cron is evaluated in Mountain time.</b> Pulse's cell is pinned to <code>America/Denver</code>, so <code>0 8 * * *</code> means 8am MDT/MST and DST is handled by the OS. Prose with explicit UTC times gets converted.</p>

    <p><b>State survives hibernation.</b> The inbox is Mac-side (<code>~/.cells/pulse-inbox/</code>); cells can push schedule updates even while pulse-cc is asleep, and pulse drains the backlog when it wakes. Per-cell parsed schedules live at <code>pulse-cache/&lt;cell&gt;.json</code>; the firing record is the cron-fires log inside the pulse cell.</p>

    <p><b>Latency is the cell's response time.</b> <code>cells talk</code> waits for the receiving cell to actually <i>ack</i> the message (default 180s timeout). A small latency means the cell was running and responsive. A latency near 180s usually means the talk timed out — the cell may have been hibernating and failed to wake. The "missed" status above means cron should have fired but no log entry showed up at all.</p>

    <p class="sub" style="margin-top:2em"><a href="https://mother.cells.md/">← fleet</a></p>
  </div>
</body>
`;
}

// Exported for tests + the CLI's sync-crontab subcommand.
export { installCrontabForCell, removeCrontabForCell };
