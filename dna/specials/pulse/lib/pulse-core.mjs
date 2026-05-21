/**
 * pulse-core — the harness-neutral guts of pulse.
 *
 * All of pulse's deterministic logic — the concurrency sentinel, inbox
 * drain, schedule cache, cron evaluation, firing, digest rendering, and
 * daily-log bookkeeping — with no harness coupling. pi wraps these as pi
 * tools (.pi/extensions/pulse-tools); claude-code drives them from a CLI
 * (bin/pulse-core) inside its /loop. One source of truth, two harnesses.
 *
 * Paths are injected via resolvePaths(), never derived from __dirname, so
 * the module runs unchanged whether it's imported by a pi extension or
 * executed by plain `node` on a claude-code cell. Build a PulsePaths once
 * at startup and thread it into every operation.
 *
 * Durable state (all under runtimeDir):
 *   pulse.json              {lastPulse, currentPulse, lastFire, log[]}
 *   pulse-inbox/            HEARTBEAT.md pushes from cells
 *   pulse-inbox/processed/  drained inbox archive
 *   pulse-cache/<cell>.json parsed schedule per cell
 *   logs/pulse-trace.log    one line per operation
 *   logs/fires.log          per-fire detail (rotated)
 *
 * Vault-readable surfaces (under stateDir):
 *   heartbeats.md   digest table (renderDigest)
 *   log.md          daily narrative (writeLogEntry)
 *
 * The LLM only ever touches two things, and both live in the *wrapper*,
 * not here: parsing inbox prose into a cron schedule, and writing the
 * daily-log paragraph. Every operation in this module is pure compute.
 *
 * Lifted verbatim from .pi/extensions/pulse-tools/index.ts — the logic is
 * unchanged; only the pi-tool registration and __dirname path resolution
 * were stripped out.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parseCron, cronNext, cronPrev } from "./cron.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// ---------- tunables ----------

// Window pulse looks back when deciding "is this cron item due now?"
const FIRE_WINDOW_MS = 60_000;
// How long a currentPulse sentinel is live before a new pulse steals it.
const SENTINEL_MAX_MS = 5 * 60_000;
// Cap on log[] entries kept in pulse.json (older roll out).
const LOG_MAX_ENTRIES = 500;
// fires.log rolls when it exceeds this size (one rotation, .1 archive).
const FIRES_LOG_MAX_BYTES = 5 * 1024 * 1024;
// Consecutive failures that flag a schedule as failing in the digest.
const FAILURE_STREAK_THRESHOLD = 3;

// In-well, fire scheduled wakes via proxy.cells.md/bridge/talk; on Mac
// (legacy), shell out to `cells talk`. Selected by CELLS_BRIDGE_URL.
const BRIDGE_URL = process.env.CELLS_BRIDGE_URL ?? null;

// ---------- paths ----------

/**
 * @typedef {object} PulsePaths
 * @property {string} runtimeDir    pulse.json, pulse-inbox/, pulse-cache/, logs/
 * @property {string} stateDir      heartbeats.md, log.md (vault-readable surface)
 * @property {string} registryPath  cells.json (bootstrap source)
 * @property {string} vaultDir      cell HEARTBEAT.md mirror root (bootstrap source)
 */

/**
 * Build a PulsePaths from explicit overrides, then environment, then
 * defaults. Every caller resolves once at startup and threads the result.
 *
 *   runtimeDir: opts.runtimeDir ?? $PULSE_RUNTIME_DIR ?? ~/.cells
 *   stateDir:   opts.stateDir   ?? $PULSE_STATE_DIR   ?? <runtimeDir>/state
 *
 * The pi wrapper passes stateDir derived from __dirname (keeping pi-pulse
 * byte-identical); the claude-code CLI lets it fall to env + defaults.
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
  return { runtimeDir, stateDir, registryPath, vaultDir };
}

// Sub-paths derived from a PulsePaths. Kept as functions so PulsePaths
// stays a plain data object that's trivial to construct and log.
const statePath = (p) => path.join(p.runtimeDir, "pulse.json");
const inboxDir = (p) => path.join(p.runtimeDir, "pulse-inbox");
const processedDir = (p) => path.join(inboxDir(p), "processed");
const cacheDir = (p) => path.join(p.runtimeDir, "pulse-cache");
const logsDir = (p) => path.join(p.runtimeDir, "logs");
const traceLog = (p) => path.join(logsDir(p), "pulse-trace.log");
const firesLog = (p) => path.join(logsDir(p), "fires.log");
const heartbeatsMd = (p) => path.join(p.stateDir, "heartbeats.md");
const logMd = (p) => path.join(p.stateDir, "log.md");

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
// re-parse, so lastFire keys stay stable.
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

// Local-TZ "today" for the daily-log header — rolls over at local midnight.
function localDate(d = new Date()) {
  return d.toLocaleDateString("en-CA");
}

// Append a trace line to logs/pulse-trace.log. Best-effort, never throws.
function appendTrace(p, line) {
  try {
    fs.mkdirSync(logsDir(p), { recursive: true });
    fs.appendFileSync(traceLog(p), `${new Date().toISOString()}  ${line}\n`);
  } catch { /* swallow — trace logging is best-effort */ }
}

// Append a per-fire entry to fires.log, capturing the side-channel reply.
// Rotates when oversized.
function appendFireLog(p, cell, id, message, r) {
  try {
    fs.mkdirSync(logsDir(p), { recursive: true });
    const fl = firesLog(p);
    if (fs.existsSync(fl)) {
      const stat = fs.statSync(fl);
      if (stat.size > FIRES_LOG_MAX_BYTES) {
        const rotated = fl + ".1";
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(fl, rotated);
      }
    }
    const head = `=== ${new Date().toISOString()}  ${cell}:${id}  ${r.ok ? "ok" : `fail exit=${r.exit}`} ===`;
    const body = [
      `> ${message}`,
      r.stdout && r.stdout.trim() ? `[stdout]\n${r.stdout.trim()}` : "",
      r.stderr && r.stderr.trim() ? `[stderr]\n${r.stderr.trim()}` : "",
    ].filter(Boolean).join("\n");
    fs.appendFileSync(fl, `${head}\n${body}\n\n`);
  } catch { /* best-effort */ }
}

// Count consecutive failures (newest-backwards) for a <cell>:<id> key.
function failureStreak(log, cell, id) {
  let n = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.cell !== cell || e.id !== id) continue;
    if (e.result === "ok") return n;
    n++;
  }
  return n;
}

function readState(p) {
  if (!fs.existsSync(statePath(p))) {
    return { lastPulse: null, currentPulse: null, lastFire: {}, log: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(p), "utf-8"));
    return {
      lastPulse: raw.lastPulse ?? null,
      currentPulse: raw.currentPulse ?? null,
      lastFire: raw.lastFire ?? {},
      log: Array.isArray(raw.log) ? raw.log : [],
    };
  } catch {
    return { lastPulse: null, currentPulse: null, lastFire: {}, log: [] };
  }
}

function writeState(p, state) {
  ensureDirs(p);
  if (state.log.length > LOG_MAX_ENTRIES) state.log = state.log.slice(-LOG_MAX_ENTRIES);
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

function shellOut(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ ok: code === 0, exit: code ?? -1, stdout, stderr }));
    proc.on("error", (e) => resolve({ ok: false, exit: -1, stdout, stderr: stderr || e.message }));
  });
}

async function fireViaBridge(cell, message) {
  const secret = process.env.CELLS_PROXY_SECRET ?? process.env.OPENAI_CODEX_API_KEY ?? "";
  try {
    const r = await fetch(`${BRIDGE_URL}/talk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ cell, message }),
    });
    if (!r.ok) return { ok: false, exit: r.status, stdout: "", stderr: await r.text() };
    return { ok: true, exit: 0, stdout: "", stderr: "" };
  } catch (e) {
    return { ok: false, exit: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
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
 * Write a parsed schedule to pulse-cache/<cell>.json AND move the source
 * inbox file to processed/. Items are {cron, message} (any id is ignored —
 * the tool derives a deterministic slug+hash so the same prose always
 * yields the same id). lastFire entries for ids no longer scheduled are
 * pruned. Returns {ok:false, error} on an invalid cron string.
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

  // Prune lastFire entries for this cell whose ids are no longer scheduled.
  const state = readState(p);
  const activeKeys = new Set(items.map((it) => `${cell}:${it.id}`));
  const cellPrefix = `${cell}:`;
  let pruned = 0;
  for (const k of Object.keys(state.lastFire)) {
    if (k.startsWith(cellPrefix) && !activeKeys.has(k)) {
      delete state.lastFire[k];
      pruned++;
    }
  }
  if (pruned > 0) writeState(p, state);

  if (sourcePath && fs.existsSync(sourcePath)) {
    fs.renameSync(sourcePath, path.join(processedDir(p), path.basename(sourcePath)));
  }
  appendTrace(p, `save_schedule cell=${cell} items=${items.length} pruned=${pruned}`);
  return { ok: true, cell, count: items.length, pruned };
}

/**
 * Evaluate every cached schedule against the last FIRE_WINDOW_MS. For each
 * item due AND not already fired this minute, fire it (bridge in-well,
 * `cells talk` on Mac) and record the result.
 *
 * @returns {Promise<{fires: Array<object>, count: number}>}
 */
export async function fireDue(p) {
  const state = readState(p);
  const schedules = listSchedules(p);
  const now = new Date();
  const windowStart = new Date(now.getTime() - FIRE_WINDOW_MS);

  const fires = [];

  for (const { cell, schedule } of schedules) {
    for (const item of schedule.items) {
      let fireTime = null;
      try {
        const prev = cronPrev(item.cron, now);
        if (prev && prev >= windowStart && prev <= now) fireTime = prev;
      } catch { continue; }

      if (!fireTime) continue;

      const key = `${cell}:${item.id}`;
      const last = state.lastFire[key];
      // Don't double-fire the same scheduled instant.
      if (last && new Date(last).getTime() === fireTime.getTime()) continue;

      const r = BRIDGE_URL
        ? await fireViaBridge(cell, item.message)
        : await shellOut("cells", ["talk", cell, item.message]);
      const result = r.ok ? "ok" : "fail";
      state.lastFire[key] = fireTime.toISOString();
      state.log.push({
        ts: now.toISOString(),
        cell, id: item.id, message: item.message,
        result, ...(r.ok ? {} : { exit: r.exit }),
      });
      fires.push({ cell, id: item.id, message: item.message, result, ...(r.ok ? {} : { exit: r.exit }) });
      appendFireLog(p, cell, item.id, item.message, r);
    }
  }

  writeState(p, state);
  appendTrace(p, `fire_due fires=${fires.length}`);
  return { fires, count: fires.length };
}

/**
 * First-run only: walk the registry, read each cell's HEARTBEAT.md from
 * the vault mirror, and synthesize an inbox entry for each. Idempotent.
 *
 * @returns {Promise<{count: number, note?: string}>}
 */
export async function bootstrapInbox(p) {
  ensureDirs(p);
  if (!fs.existsSync(p.registryPath)) return { count: 0, note: "registry missing; nothing to bootstrap" };
  const reg = JSON.parse(fs.readFileSync(p.registryPath, "utf-8"));
  const cells = reg.cells ?? [];
  let count = 0;
  for (const c of cells) {
    const hb = path.join(p.vaultDir, c.name, "HEARTBEAT.md");
    if (!fs.existsSync(hb)) continue;
    const content = fs.readFileSync(hb, "utf-8");
    const ts = Date.now();
    fs.writeFileSync(path.join(inboxDir(p), `${c.name}-${ts}.md`), content);
    count++;
    // Spread timestamps so sort order is stable.
    await new Promise((r) => setTimeout(r, 2));
  }
  appendTrace(p, `bootstrap_inbox synthesized=${count}`);
  return { count };
}

/**
 * Whether log.md is missing today's entry (today = LOCAL date). When
 * needed, returns the last 24h of fires for the caller's LLM to summarize.
 *
 * @returns {{needed: boolean, today: string, fires?: Array<object>}}
 */
export function dailyLogDue(p) {
  ensureDirs(p);
  const today = localDate();
  let existing = "";
  if (fs.existsSync(logMd(p))) existing = fs.readFileSync(logMd(p), "utf-8");
  const hasToday = new RegExp(`^## ${today}\\b`, "m").test(existing);
  if (hasToday) return { needed: false, today };

  const state = readState(p);
  const cutoff = Date.now() - 24 * 3600_000;
  const fires = state.log.filter((e) => new Date(e.ts).getTime() >= cutoff);
  return { needed: true, today, fires };
}

/**
 * Prepend a daily narrative entry to stateDir/log.md. body is a short
 * markdown paragraph with no headers (the H2 date is added here).
 *
 * @param {PulsePaths} p
 * @param {{date: string, body: string}} params
 */
export function writeLogEntry(p, { date, body }) {
  ensureDirs(p);
  const existing = fs.existsSync(logMd(p))
    ? fs.readFileSync(logMd(p), "utf-8")
    : "# Pulse log\n\nDaily narrative, newest first. Written by pulse once per 24h (local time).\n\n";
  // Preserve any preamble between the H1 and the first H2.
  const headerMatch = existing.match(/^([\s\S]*?)(\n## |\n*$)/);
  const preamble = headerMatch ? headerMatch[1].trimEnd() + "\n\n" : existing;
  const rest = existing.slice(preamble.length);
  const entry = `## ${date}\n\n${body.trim()}\n\n`;
  fs.writeFileSync(logMd(p), preamble + entry + rest);
  appendTrace(p, `write_log_entry date=${date} bytes=${body.length}`);
  return { ok: true, date, bytes: body.length };
}

/**
 * Rewrite stateDir/heartbeats.md — a markdown table of every cell's
 * schedule, last-fire, next-fire, plus the recent-20 fires. Pure compute
 * over the cache + state.
 *
 * @returns {{rows: number, flagged: number, recent: number}}
 */
export function renderDigest(p) {
  ensureDirs(p);
  const state = readState(p);
  const schedules = listSchedules(p);
  const now = new Date();

  const lines = [
    "# Heartbeats",
    "",
    `_Generated ${formatLocal(now.toISOString())} (local) · ${now.toISOString()} (UTC)._`,
    "",
    "| cell | id | cron | message | last fire | next fire |",
    "|---|---|---|---|---|---|",
  ];

  // Row: [cellLabel, id, cron, message, lastFire, nextFire, nextMs]
  const rows = [];
  let flagged = 0;
  for (const { cell, schedule } of schedules) {
    for (const item of schedule.items) {
      const key = `${cell}:${item.id}`;
      const last = state.lastFire[key] ?? null;
      let nextLocal = "—";
      let nextMs = Number.MAX_SAFE_INTEGER;
      try {
        const n = cronNext(item.cron, now);
        if (n) {
          nextLocal = formatLocal(n.toISOString());
          nextMs = n.getTime();
        }
      } catch { /* invalid cron — leave dash */ }
      const streak = failureStreak(state.log, cell, item.id);
      const flag = streak >= FAILURE_STREAK_THRESHOLD ? ` ⚠️×${streak}` : "";
      if (flag) flagged++;
      const msg = item.message.length > 60 ? item.message.slice(0, 57) + "..." : item.message;
      rows.push([`${cell}${flag}`, item.id, item.cron, msg.replace(/\|/g, "\\|"), formatLocal(last), nextLocal, nextMs]);
    }
  }
  // Sort by next fire (soonest first).
  rows.sort((a, b) => a[6] - b[6]);
  for (const r of rows) {
    lines.push(`| ${r[0]} | ${r[1]} | \`${r[2]}\` | ${r[3]} | ${r[4]} | ${r[5]} |`);
  }
  if (rows.length === 0) lines.push("| _(no schedules cached)_ | | | | | |");

  if (flagged > 0) {
    lines.push("", `> ⚠️ ${flagged} schedule(s) failing repeatedly (${FAILURE_STREAK_THRESHOLD}+ consecutive fails). Check \`logs/fires.log\`.`);
  }

  lines.push("", "## Recent fires (last 20)", "");
  const recent = state.log.slice(-20).reverse();
  if (recent.length === 0) {
    lines.push("_(none)_");
  } else {
    lines.push("| time | cell | id | result |", "|---|---|---|---|");
    for (const e of recent) {
      lines.push(`| ${formatLocal(e.ts)} | ${e.cell} | ${e.id} | ${e.result}${e.exit !== undefined ? ` (exit ${e.exit})` : ""} |`);
    }
  }

  fs.writeFileSync(heartbeatsMd(p), lines.join("\n") + "\n");
  appendTrace(p, `render_digest rows=${rows.length} flagged=${flagged} recent=${recent.length}`);
  return { rows: rows.length, flagged, recent: recent.length };
}
