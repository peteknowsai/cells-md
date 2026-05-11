/**
 * pulse-tools — the deterministic guts of pulse.
 *
 * Pulse runs in print mode (`pi -p /pulse`) every 60s under launchd. Each
 * pulse is a fresh process; nothing persists in pi context. All durable state
 * is on disk under ~/.cells/:
 *
 *   pulse.json              runtime state (lastPulse, currentPulse, lastFire, log[])
 *   pulse-inbox/            files dropped by subscriptions proxy when cells push HEARTBEAT.md
 *   pulse-inbox/processed/  archive of drained inbox files
 *   pulse-cache/<cell>.json parsed schedule per cell ({items: [{id, cron, message}]})
 *
 * Vault-readable surfaces (under dna/proto/pulse/state/, mirrored by `cells sync pulse`):
 *
 *   heartbeats.md    table of every cell's schedule + last/next fire (rendered each pulse)
 *   log.md           LLM-written daily narrative (one entry per 24h, prepended)
 *
 * Tool boundary: the LLM only handles two things —
 *   1. parsing inbox prose into a JSON cron schedule (rare; only when an inbox entry exists),
 *   2. writing a one-paragraph daily log entry (rare; once per 24h).
 *
 * Everything else (cron eval, firing, state mutation, digest rendering) is
 * pure compute behind a tool boundary. Cheap pulses cost ~no tokens.
 */

import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// ---------- paths ----------

const HOME = homedir();
const CELLS_DIR = path.join(HOME, ".cells");
const STATE_PATH = path.join(CELLS_DIR, "pulse.json");
const INBOX_DIR = path.join(CELLS_DIR, "pulse-inbox");
const PROCESSED_DIR = path.join(INBOX_DIR, "processed");
const CACHE_DIR = path.join(CELLS_DIR, "pulse-cache");
const REGISTRY_PATH = path.join(CELLS_DIR, "cells.json");
const VAULT_DIR = path.join(HOME, "Obsidian", "cells");
const LOGS_DIR = path.join(CELLS_DIR, "logs");
const PULSE_TRACE_LOG = path.join(LOGS_DIR, "pulse-trace.log");
const FIRES_LOG = path.join(LOGS_DIR, "fires.log");

// pulse-tools lives at dna/proto/pulse/.pi/extensions/pulse-tools/index.ts;
// state/ is two dirs up.
const PULSE_ROOT = path.resolve(__dirname, "..", "..", "..");
const STATE_DIR = path.join(PULSE_ROOT, "state");
const HEARTBEATS_MD = path.join(STATE_DIR, "heartbeats.md");
const LOG_MD = path.join(STATE_DIR, "log.md");

// ---------- tunables ----------

// Window pulse looks back when deciding "is this cron item due now?"
// Matches launchd's StartInterval=60. If pulse is delayed past this, fires
// can be missed for sub-window-precision schedules.
const FIRE_WINDOW_MS = 60_000;

// How long a `currentPulse` sentinel is considered live before it's treated
// as a crashed-prior-pulse and stolen.
const SENTINEL_MAX_MS = 5 * 60_000;

// Cap log[] entries kept in pulse.json (older roll out; the daily log.md
// captures the narrative).
const LOG_MAX_ENTRIES = 500;

// fires.log rolls when it exceeds this size (one rotation, .1 archive).
const FIRES_LOG_MAX_BYTES = 5 * 1024 * 1024;

// Number of consecutive failures that flag a schedule as failing in the digest.
const FAILURE_STREAK_THRESHOLD = 3;

// ---------- types ----------

type ScheduleItem = { id: string; cron: string; message: string };
type Schedule = { items: ScheduleItem[]; updatedAt: string; contentHash?: string };

type LogEntry = { ts: string; cell: string; id: string; message: string; result: "ok" | "fail"; exit?: number };

type State = {
  lastPulse: string | null;
  currentPulse: string | null;
  lastFire: Record<string, string>; // key = "<cell>:<id>", value = ISO
  log: LogEntry[];
};

// ---------- helpers ----------

function ensureDirs(): void {
  for (const d of [CELLS_DIR, INBOX_DIR, PROCESSED_DIR, CACHE_DIR, STATE_DIR, LOGS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Stable, human-readable id. Slug from message + 6-char hash of (cron, normalized message).
// Same prose -> same id even after LLM re-parse, so lastFire keys stay stable.
function deriveId(cron: string, message: string): string {
  const normMsg = message.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const slug = normMsg.replace(/\s+/g, "-").slice(0, 24).replace(/-+$/, "") || "wake";
  const hash = sha(cron + "\0" + normMsg).slice(0, 6);
  return `${slug}-${hash}`;
}

// Format an ISO timestamp as Pete-local short form for human-facing surfaces.
// Example: "2026-05-02 06:26:26" (system local TZ; macOS handles DST).
function formatLocal(iso: string | null | undefined): string {
  if (!iso || iso === "—") return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  // en-CA gives "YYYY-MM-DD, HH:MM:SS" with hour24; replace the comma for readability.
  return d.toLocaleString("en-CA", { hour12: false }).replace(",", "");
}

// Local-TZ "today" date for the daily log header. Rolls over at midnight local
// (not 5pm PT like UTC would).
function localDate(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD
}

// Append a trace line to ~/.cells/logs/pulse-trace.log. One line per call;
// best-effort, never throws.
function appendTrace(line: string): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(PULSE_TRACE_LOG, `${new Date().toISOString()}  ${line}\n`);
  } catch { /* swallow — trace logging is best-effort */ }
}

// Append a per-fire entry to fires.log (captures the side-channel pi reply
// that would otherwise be discarded). Rotates when oversized.
function appendFireLog(cell: string, id: string, message: string, r: { ok: boolean; exit: number; stdout: string; stderr: string }): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    if (fs.existsSync(FIRES_LOG)) {
      const stat = fs.statSync(FIRES_LOG);
      if (stat.size > FIRES_LOG_MAX_BYTES) {
        const rotated = FIRES_LOG + ".1";
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(FIRES_LOG, rotated);
      }
    }
    const head = `=== ${new Date().toISOString()}  ${cell}:${id}  ${r.ok ? "ok" : `fail exit=${r.exit}`} ===`;
    const body = [
      `> ${message}`,
      r.stdout.trim() ? `[stdout]\n${r.stdout.trim()}` : "",
      r.stderr.trim() ? `[stderr]\n${r.stderr.trim()}` : "",
    ].filter(Boolean).join("\n");
    fs.appendFileSync(FIRES_LOG, `${head}\n${body}\n\n`);
  } catch { /* best-effort */ }
}

// Count consecutive failures (newest-backwards) for a given <cell>:<id> key.
// Stops at the first success (or list end). Used to flag failing schedules.
function failureStreak(log: LogEntry[], cell: string, id: string): number {
  let n = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.cell !== cell || e.id !== id) continue;
    if (e.result === "ok") return n;
    n++;
  }
  return n;
}

function readState(): State {
  if (!fs.existsSync(STATE_PATH)) {
    return { lastPulse: null, currentPulse: null, lastFire: {}, log: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
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

function writeState(state: State): void {
  ensureDirs();
  if (state.log.length > LOG_MAX_ENTRIES) state.log = state.log.slice(-LOG_MAX_ENTRIES);
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

function listSchedules(): Array<{ cell: string; schedule: Schedule }> {
  if (!fs.existsSync(CACHE_DIR)) return [];
  const out: Array<{ cell: string; schedule: Schedule }> = [];
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (!f.endsWith(".json")) continue;
    const cell = f.replace(/\.json$/, "");
    try {
      const sched = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf-8"));
      out.push({ cell, schedule: sched });
    } catch { /* skip corrupt */ }
  }
  return out;
}

function shellOut(cmd: string, args: string[]): Promise<{ ok: boolean; exit: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, exit: code ?? -1, stdout, stderr });
    });
    proc.on("error", (e) => {
      resolve({ ok: false, exit: -1, stdout, stderr: stderr || e.message });
    });
  });
}

function txt(text: string) {
  return { content: [{ type: "text", text }] };
}

// ---------- extension ----------

export default function (pi: any) {
  // pulse_begin — concurrency check + state snapshot.
  pi.registerTool({
    name: "pulse_begin",
    label: "Begin pulse",
    description:
      "Start a pulse. Acquires the currentPulse sentinel (5-minute staleness window). Returns {skip, reason, isFirstRun, now}. If skip=true, stop immediately — a prior pulse is in flight.",
    parameters: Type.Object({}),
    async execute() {
      ensureDirs();
      const state = readState();
      const now = new Date();
      const nowIso = now.toISOString();

      if (state.currentPulse) {
        const ageMs = now.getTime() - new Date(state.currentPulse).getTime();
        if (ageMs < SENTINEL_MAX_MS) {
          appendTrace(`begin skip — prior pulse in flight since ${state.currentPulse}`);
          return txt(JSON.stringify({ skip: true, reason: `prior pulse in flight since ${state.currentPulse}`, isFirstRun: false, now: nowIso }));
        }
        // Stale sentinel — prior pulse crashed. Take over.
        appendTrace(`begin steal stale sentinel age=${Math.round(ageMs / 1000)}s`);
      }

      const isFirstRun = !fs.existsSync(CACHE_DIR) || fs.readdirSync(CACHE_DIR).length === 0;
      state.currentPulse = nowIso;
      writeState(state);
      appendTrace(`begin firstRun=${isFirstRun}`);
      return txt(JSON.stringify({ skip: false, isFirstRun, now: nowIso }));
    },
  });

  // pulse_end — clear sentinel, update lastPulse.
  pi.registerTool({
    name: "pulse_end",
    label: "End pulse",
    description:
      "Finalize a pulse. Clears the currentPulse sentinel and stamps lastPulse. Always call this last, even if earlier steps no-oped.",
    parameters: Type.Object({}),
    async execute() {
      const state = readState();
      state.currentPulse = null;
      state.lastPulse = new Date().toISOString();
      writeState(state);
      appendTrace("end");
      return txt("pulse ended");
    },
  });

  // drain_inbox — read all inbox entries; auto-skip ones whose content matches
  // the cached parse (no-op edits, e.g. saving HEARTBEAT.md unchanged).
  pi.registerTool({
    name: "drain_inbox",
    label: "Drain inbox",
    description:
      "Read every file in ~/.cells/pulse-inbox/ (excluding processed/). Returns [{cell, content, path, ts}, ...]. Entries whose content hash matches the cell's existing pulse-cache (no-op edits) are auto-moved to processed/ and NOT returned — saves an LLM round-trip. The LLM only sees entries that need re-parsing.",
    parameters: Type.Object({}),
    async execute() {
      ensureDirs();
      const entries: Array<{ cell: string; content: string; path: string; ts: string }> = [];
      let skipped = 0;
      for (const f of fs.readdirSync(INBOX_DIR)) {
        const full = path.join(INBOX_DIR, f);
        if (fs.statSync(full).isDirectory()) continue;
        // filename convention: <cell>-<ts-ms>.md
        const m = f.match(/^(.+)-(\d+)\.md$/);
        if (!m) continue;
        const cell = m[1];
        const ts = new Date(parseInt(m[2], 10)).toISOString();
        const content = fs.readFileSync(full, "utf-8");

        // No-op skip: if a cache exists for this cell and its contentHash matches,
        // there's nothing new to parse. Move directly to processed/.
        const cachePath = path.join(CACHE_DIR, `${cell}.json`);
        if (fs.existsSync(cachePath)) {
          try {
            const cached: Schedule = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
            if (cached.contentHash && cached.contentHash === sha(content)) {
              const dest = path.join(PROCESSED_DIR, path.basename(full));
              fs.renameSync(full, dest);
              skipped++;
              continue;
            }
          } catch { /* corrupt cache — fall through and let the LLM re-parse */ }
        }

        entries.push({ cell, content, path: full, ts });
      }
      // Oldest-first so a cell that pushed twice gets its newer schedule applied last.
      entries.sort((a, b) => a.ts.localeCompare(b.ts));
      appendTrace(`drain_inbox returned=${entries.length} skipped_unchanged=${skipped}`);
      return txt(JSON.stringify(entries));
    },
  });

  // save_schedule — write cache + atomically move source inbox file to processed/.
  // The id you pass is treated as a hint; the tool replaces it with a
  // deterministic slug+hash derived from (cron, normalized message) so
  // lastFire keys stay stable across LLM re-parses.
  pi.registerTool({
    name: "save_schedule",
    label: "Save parsed schedule",
    description:
      "Write a parsed schedule to ~/.cells/pulse-cache/<cell>.json AND move the source inbox file to processed/. Items must be {id, cron (5-field crontab), message}. The tool overrides id with a deterministic slug+hash of (cron, normalized message), so don't worry about id uniqueness or stability — same prose always yields the same id. lastFire entries for ids no longer in the schedule are pruned automatically.",
    parameters: Type.Object({
      cell: Type.String(),
      items: Type.Array(Type.Object({
        id: Type.String({ description: "Hint slug; ignored — the tool derives a stable id from (cron, message)." }),
        cron: Type.String({ description: "5-field crontab (min hour dom mon dow), local time." }),
        message: Type.String(),
      })),
      sourcePath: Type.Optional(Type.String({ description: "Inbox file path to move to processed/. Optional for bootstrap entries." })),
    }),
    async execute(_id: string, params: { cell: string; items: ScheduleItem[]; sourcePath?: string }) {
      ensureDirs();
      // Validate every cron string before writing.
      for (const item of params.items) {
        try { CronExpressionParser.parse(item.cron); }
        catch (e) { return txt(`✗ invalid cron "${item.cron}" for ${params.cell}:${item.id} — ${(e as Error).message}`); }
      }

      // Override LLM-provided ids with deterministic ones.
      const items: ScheduleItem[] = params.items.map((it) => ({
        id: deriveId(it.cron, it.message),
        cron: it.cron,
        message: it.message,
      }));

      // Hash the source inbox content (if given) so drain_inbox can short-circuit
      // future no-op pushes for this cell.
      let contentHash: string | undefined;
      if (params.sourcePath && fs.existsSync(params.sourcePath)) {
        try {
          contentHash = sha(fs.readFileSync(params.sourcePath, "utf-8"));
        } catch { /* ignore — degrades to always re-parsing for this cell */ }
      }

      const sched: Schedule = { items, updatedAt: new Date().toISOString(), ...(contentHash ? { contentHash } : {}) };
      fs.writeFileSync(path.join(CACHE_DIR, `${params.cell}.json`), JSON.stringify(sched, null, 2));

      // Prune lastFire entries for this cell whose ids are no longer scheduled.
      // Stops state from accumulating orphan keys when schedules are removed.
      const state = readState();
      const activeKeys = new Set(items.map((it) => `${params.cell}:${it.id}`));
      const cellPrefix = `${params.cell}:`;
      let pruned = 0;
      for (const k of Object.keys(state.lastFire)) {
        if (k.startsWith(cellPrefix) && !activeKeys.has(k)) {
          delete state.lastFire[k];
          pruned++;
        }
      }
      if (pruned > 0) writeState(state);

      if (params.sourcePath && fs.existsSync(params.sourcePath)) {
        const dest = path.join(PROCESSED_DIR, path.basename(params.sourcePath));
        fs.renameSync(params.sourcePath, dest);
      }
      appendTrace(`save_schedule cell=${params.cell} items=${items.length} pruned=${pruned}`);
      return txt(`✓ saved ${items.length} schedule item(s) for ${params.cell}` + (pruned > 0 ? ` (pruned ${pruned} stale lastFire key${pruned === 1 ? "" : "s"})` : ""));
    },
  });

  // fire_due — eval cron against now, fire any due items via `cells talk`, record.
  pi.registerTool({
    name: "fire_due",
    label: "Fire due wakes",
    description:
      "Evaluate every cached schedule against the last 60 seconds. For each item due AND not already fired this minute (lastFire check), shell out to `cells talk <cell> \"<message>\"` and append a log entry. Returns a summary of fires attempted.",
    parameters: Type.Object({}),
    async execute() {
      const state = readState();
      const schedules = listSchedules();
      const now = new Date();
      const windowStart = new Date(now.getTime() - FIRE_WINDOW_MS);

      const fires: Array<{ cell: string; id: string; message: string; result: "ok" | "fail"; exit?: number }> = [];

      for (const { cell, schedule } of schedules) {
        for (const item of schedule.items) {
          let fireTime: Date | null = null;
          try {
            const cron = CronExpressionParser.parse(item.cron, { currentDate: now });
            const prev = cron.prev().toDate();
            if (prev >= windowStart && prev <= now) fireTime = prev;
          } catch { continue; }

          if (!fireTime) continue;

          const key = `${cell}:${item.id}`;
          const last = state.lastFire[key];
          // Don't double-fire the same scheduled instant.
          if (last && new Date(last).getTime() === fireTime.getTime()) continue;

          const r = await shellOut("cells", ["talk", cell, item.message]);
          const result: "ok" | "fail" = r.ok ? "ok" : "fail";
          state.lastFire[key] = fireTime.toISOString();
          state.log.push({
            ts: now.toISOString(),
            cell, id: item.id, message: item.message,
            result, ...(r.ok ? {} : { exit: r.exit }),
          });
          fires.push({ cell, id: item.id, message: item.message, result, ...(r.ok ? {} : { exit: r.exit }) });
          // Capture the side-channel pi's stdout/stderr so the agent's reply isn't lost.
          appendFireLog(cell, item.id, item.message, r);
        }
      }

      writeState(state);
      appendTrace(`fire_due fires=${fires.length}`);
      return txt(JSON.stringify({ fires, count: fires.length }));
    },
  });

  // bootstrap_inbox — first-run; walk vault and synthesize inbox entries.
  pi.registerTool({
    name: "bootstrap_inbox",
    label: "Bootstrap inbox from vault",
    description:
      "First-run only: walk ~/.cells/cells.json, read each cell's HEARTBEAT.md from the vault mirror, and synthesize an inbox entry for each. Used when pulse-cache/ is empty (fresh install). Idempotent.",
    parameters: Type.Object({}),
    async execute() {
      ensureDirs();
      if (!fs.existsSync(REGISTRY_PATH)) return txt("registry missing; nothing to bootstrap");
      const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
      const cells: Array<{ name: string }> = reg.cells ?? [];
      let count = 0;
      for (const c of cells) {
        const hb = path.join(VAULT_DIR, c.name, "HEARTBEAT.md");
        if (!fs.existsSync(hb)) continue;
        const content = fs.readFileSync(hb, "utf-8");
        const ts = Date.now();
        const dest = path.join(INBOX_DIR, `${c.name}-${ts}.md`);
        fs.writeFileSync(dest, content);
        count++;
        // Spread timestamps so sort order is stable.
        await new Promise((r) => setTimeout(r, 2));
      }
      appendTrace(`bootstrap_inbox synthesized=${count}`);
      return txt(`✓ synthesized ${count} inbox entries from vault`);
    },
  });

  // daily_log_due — check whether log.md is missing today's entry.
  // "Today" = local-TZ date (rolls over at midnight Pacific, not 5pm).
  pi.registerTool({
    name: "daily_log_due",
    label: "Check daily log",
    description:
      "Returns {needed, today, fires}. If log.md already has an entry for today (LOCAL date — rolls over at midnight Pacific), needed=false. Otherwise needed=true and fires is the list of log entries from the last 24h to summarize. Call write_log_entry after composing a one-paragraph narrative.",
    parameters: Type.Object({}),
    async execute() {
      ensureDirs();
      const today = localDate();
      let existing = "";
      if (fs.existsSync(LOG_MD)) existing = fs.readFileSync(LOG_MD, "utf-8");
      const hasToday = new RegExp(`^## ${today}\\b`, "m").test(existing);
      if (hasToday) return txt(JSON.stringify({ needed: false, today }));

      const state = readState();
      const cutoff = Date.now() - 24 * 3600_000;
      const fires = state.log.filter((e) => new Date(e.ts).getTime() >= cutoff);
      return txt(JSON.stringify({ needed: true, today, fires }));
    },
  });

  // write_log_entry — prepend a daily narrative entry to state/log.md.
  pi.registerTool({
    name: "write_log_entry",
    label: "Write daily log entry",
    description:
      "Prepend a daily narrative entry to dna/proto/pulse/state/log.md. body should be a short paragraph (~3-5 sentences) describing what happened in the prior 24h. Markdown, no leading H2 (the tool adds `## <date>`). The date is LOCAL — pass the value daily_log_due returned.",
    parameters: Type.Object({
      date: Type.String({ description: "YYYY-MM-DD (local TZ — value from daily_log_due.today)." }),
      body: Type.String({ description: "Markdown paragraph; no headers." }),
    }),
    async execute(_id: string, params: { date: string; body: string }) {
      ensureDirs();
      const existing = fs.existsSync(LOG_MD) ? fs.readFileSync(LOG_MD, "utf-8") : "# Pulse log\n\nDaily narrative, newest first. Written by pulse once per 24h (local time).\n\n";
      // Find the insert point after the header preamble; preserve any preamble between # and the first ##.
      const headerMatch = existing.match(/^([\s\S]*?)(\n## |\n*$)/);
      const preamble = headerMatch ? headerMatch[1].trimEnd() + "\n\n" : existing;
      const rest = existing.slice(preamble.length);
      const entry = `## ${params.date}\n\n${params.body.trim()}\n\n`;
      fs.writeFileSync(LOG_MD, preamble + entry + rest);
      appendTrace(`write_log_entry date=${params.date} bytes=${params.body.length}`);
      return txt(`✓ logged ${params.date} (${params.body.length}B)`);
    },
  });

  // render_digest — write the heartbeats.md table.
  pi.registerTool({
    name: "render_digest",
    label: "Render heartbeats digest",
    description:
      "Write dna/proto/pulse/state/heartbeats.md — a markdown table of every cell's schedule, last-fire, next-fire. Pure compute over pulse-cache/ + state. Call at the end of each pulse.",
    parameters: Type.Object({}),
    async execute() {
      ensureDirs();
      const state = readState();
      const schedules = listSchedules();
      const now = new Date();

      const lines: string[] = [
        "# Heartbeats",
        "",
        `_Generated ${formatLocal(now.toISOString())} (local) · ${now.toISOString()} (UTC)._`,
        "",
        "| cell | id | cron | message | last fire | next fire |",
        "|---|---|---|---|---|---|",
      ];

      type Row = [string, string, string, string, string, string, number, number];
      const rows: Row[] = [];
      let flagged = 0;
      for (const { cell, schedule } of schedules) {
        for (const item of schedule.items) {
          const key = `${cell}:${item.id}`;
          const last = state.lastFire[key] ?? null;
          let nextLocal = "—";
          let nextMs = Number.MAX_SAFE_INTEGER;
          try {
            const cron = CronExpressionParser.parse(item.cron, { currentDate: now });
            const n = cron.next().toDate();
            nextLocal = formatLocal(n.toISOString());
            nextMs = n.getTime();
          } catch { /* invalid cron — leave dash */ }
          const streak = failureStreak(state.log, cell, item.id);
          const flag = streak >= FAILURE_STREAK_THRESHOLD ? ` ⚠️×${streak}` : "";
          if (flag) flagged++;
          const cellLabel = `${cell}${flag}`;
          const msg = item.message.length > 60 ? item.message.slice(0, 57) + "..." : item.message;
          rows.push([cellLabel, item.id, item.cron, msg.replace(/\|/g, "\\|"), formatLocal(last), nextLocal, nextMs, streak]);
        }
      }
      // Sort by next fire (soonest first).
      rows.sort((a, b) => a[6] - b[6]);
      for (const r of rows) {
        lines.push(`| ${r[0]} | ${r[1]} | \`${r[2]}\` | ${r[3]} | ${r[4]} | ${r[5]} |`);
      }
      if (rows.length === 0) lines.push("| _(no schedules cached)_ | | | | | |");

      if (flagged > 0) {
        lines.push("", `> ⚠️ ${flagged} schedule(s) failing repeatedly (${FAILURE_STREAK_THRESHOLD}+ consecutive fails). Check \`~/.cells/logs/fires.log\`.`);
      }

      lines.push("", "## Recent fires (last 20)", "");
      const recent = state.log.slice(-20).reverse();
      if (recent.length === 0) {
        lines.push("_(none)_");
      } else {
        lines.push("| time | cell | id | result |");
        lines.push("|---|---|---|---|");
        for (const e of recent) {
          lines.push(`| ${formatLocal(e.ts)} | ${e.cell} | ${e.id} | ${e.result}${e.exit !== undefined ? ` (exit ${e.exit})` : ""} |`);
        }
      }

      fs.writeFileSync(HEARTBEATS_MD, lines.join("\n") + "\n");
      appendTrace(`render_digest rows=${rows.length} flagged=${flagged} recent=${recent.length}`);
      return txt(`✓ rendered ${rows.length} schedule rows, ${recent.length} recent fires${flagged ? `, ${flagged} flagged` : ""}`);
    },
  });
}
