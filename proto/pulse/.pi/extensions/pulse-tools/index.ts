/**
 * pulse-tools — the deterministic guts of pulse.
 *
 * Pulse runs in print mode (`pi -p /pulse`) every 60s under launchd. Each
 * pulse is a fresh process; nothing persists in pi context. All durable state
 * is on disk under ~/.cells/:
 *
 *   pulse.json              runtime state (lastPulse, currentPulse, lastFire, log[])
 *   pulse-inbox/            files dropped by mother proxy when cells push HEARTBEAT.md
 *   pulse-inbox/processed/  archive of drained inbox files
 *   pulse-cache/<cell>.json parsed schedule per cell ({items: [{id, cron, message}]})
 *
 * Vault-readable surfaces (under proto/pulse/state/, mirrored by `cells sync pulse`):
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

// pulse-tools lives at proto/pulse/.pi/extensions/pulse-tools/index.ts;
// state/ is two dirs up.
const PULSE_ROOT = path.resolve(__dirname, "..", "..", "..");
const STATE_DIR = path.join(PULSE_ROOT, "state");
const HEARTBEATS_MD = path.join(STATE_DIR, "heartbeats.md");
const LOG_MD = path.join(STATE_DIR, "log.md");

// ---------- types ----------

type ScheduleItem = { id: string; cron: string; message: string };
type Schedule = { items: ScheduleItem[]; updatedAt: string };

type LogEntry = { ts: string; cell: string; id: string; message: string; result: "ok" | "fail"; exit?: number };

type State = {
  lastPulse: string | null;
  currentPulse: string | null;
  lastFire: Record<string, string>; // key = "<cell>:<id>", value = ISO
  log: LogEntry[];
};

// ---------- helpers ----------

function ensureDirs(): void {
  for (const d of [CELLS_DIR, INBOX_DIR, PROCESSED_DIR, CACHE_DIR, STATE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
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
  // Cap log[] at 500 entries; older entries roll out (the daily log.md captures narrative).
  if (state.log.length > 500) state.log = state.log.slice(-500);
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
        if (ageMs < 5 * 60_000) {
          return txt(JSON.stringify({ skip: true, reason: `prior pulse in flight since ${state.currentPulse}`, isFirstRun: false, now: nowIso }));
        }
        // Stale sentinel — prior pulse crashed. Take over.
      }

      const isFirstRun = !fs.existsSync(CACHE_DIR) || fs.readdirSync(CACHE_DIR).length === 0;
      state.currentPulse = nowIso;
      writeState(state);
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
      return txt("pulse ended");
    },
  });

  // drain_inbox — read all inbox entries.
  pi.registerTool({
    name: "drain_inbox",
    label: "Drain inbox",
    description:
      "Read every file in ~/.cells/pulse-inbox/ (excluding processed/). Returns [{cell, content, path, ts}, ...]. Files are NOT moved — call mark_processed(paths) after save_schedule succeeds for each.",
    parameters: Type.Object({}),
    async execute() {
      ensureDirs();
      const entries: Array<{ cell: string; content: string; path: string; ts: string }> = [];
      for (const f of fs.readdirSync(INBOX_DIR)) {
        const full = path.join(INBOX_DIR, f);
        if (fs.statSync(full).isDirectory()) continue;
        // filename convention: <cell>-<ts-ms>.md
        const m = f.match(/^(.+)-(\d+)\.md$/);
        if (!m) continue;
        const cell = m[1];
        const ts = new Date(parseInt(m[2], 10)).toISOString();
        const content = fs.readFileSync(full, "utf-8");
        entries.push({ cell, content, path: full, ts });
      }
      // Oldest-first so a cell that pushed twice gets its newer schedule applied last.
      entries.sort((a, b) => a.ts.localeCompare(b.ts));
      return txt(JSON.stringify(entries));
    },
  });

  // save_schedule — write cache + atomically move source inbox file to processed/.
  pi.registerTool({
    name: "save_schedule",
    label: "Save parsed schedule",
    description:
      "Write a parsed schedule to ~/.cells/pulse-cache/<cell>.json AND move the source inbox file to processed/. Items must be {id, cron (5-field crontab), message}. The id should be a stable hash of (cron, message) — pick something deterministic so re-parses don't churn lastFire keys.",
    parameters: Type.Object({
      cell: Type.String(),
      items: Type.Array(Type.Object({
        id: Type.String(),
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
      const sched: Schedule = { items: params.items, updatedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(CACHE_DIR, `${params.cell}.json`), JSON.stringify(sched, null, 2));

      if (params.sourcePath && fs.existsSync(params.sourcePath)) {
        const dest = path.join(PROCESSED_DIR, path.basename(params.sourcePath));
        fs.renameSync(params.sourcePath, dest);
      }
      return txt(`✓ saved ${params.items.length} schedule item(s) for ${params.cell}`);
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
      // Window: last 60s up to now. Cron prev() within this window means "due now".
      const windowStart = new Date(now.getTime() - 60_000);

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
        }
      }

      writeState(state);
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
      return txt(`✓ synthesized ${count} inbox entries from vault`);
    },
  });

  // daily_log_due — check whether log.md is missing today's entry.
  pi.registerTool({
    name: "daily_log_due",
    label: "Check daily log",
    description:
      "Returns {needed, today, fires}. If log.md already has an entry for today (UTC date), needed=false. Otherwise needed=true and fires is the list of log entries from the last 24h to summarize. Call write_log_entry after composing a one-paragraph narrative.",
    parameters: Type.Object({}),
    async execute() {
      ensureDirs();
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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
      "Prepend a daily narrative entry to proto/pulse/state/log.md. body should be a short paragraph (~3-5 sentences) describing what happened in the prior 24h. Markdown, no leading H2 (the tool adds `## <date>`).",
    parameters: Type.Object({
      date: Type.String({ description: "YYYY-MM-DD (UTC)." }),
      body: Type.String({ description: "Markdown paragraph; no headers." }),
    }),
    async execute(_id: string, params: { date: string; body: string }) {
      ensureDirs();
      const existing = fs.existsSync(LOG_MD) ? fs.readFileSync(LOG_MD, "utf-8") : "# Pulse log\n\nDaily narrative, newest first. Written by pulse once per 24h.\n\n";
      // Find the insert point after the header preamble; preserve any preamble between # and the first ##.
      const headerMatch = existing.match(/^([\s\S]*?)(\n## |\n*$)/);
      const preamble = headerMatch ? headerMatch[1].trimEnd() + "\n\n" : existing;
      const rest = existing.slice(preamble.length);
      const entry = `## ${params.date}\n\n${params.body.trim()}\n\n`;
      fs.writeFileSync(LOG_MD, preamble + entry + rest);
      return txt(`✓ logged ${params.date} (${params.body.length}B)`);
    },
  });

  // render_digest — write the heartbeats.md table.
  pi.registerTool({
    name: "render_digest",
    label: "Render heartbeats digest",
    description:
      "Write proto/pulse/state/heartbeats.md — a markdown table of every cell's schedule, last-fire, next-fire. Pure compute over pulse-cache/ + state. Call at the end of each pulse.",
    parameters: Type.Object({}),
    async execute() {
      ensureDirs();
      const state = readState();
      const schedules = listSchedules();
      const now = new Date();

      const lines: string[] = [
        "# Heartbeats",
        "",
        `_Generated ${now.toISOString()} by pulse._`,
        "",
        "| cell | id | cron | message | last fire | next fire |",
        "|---|---|---|---|---|---|",
      ];

      const rows: Array<[string, string, string, string, string, string, number]> = [];
      for (const { cell, schedule } of schedules) {
        for (const item of schedule.items) {
          const key = `${cell}:${item.id}`;
          const last = state.lastFire[key] ?? "—";
          let next = "—";
          let nextMs = Number.MAX_SAFE_INTEGER;
          try {
            const cron = CronExpressionParser.parse(item.cron, { currentDate: now });
            const n = cron.next().toDate();
            next = n.toISOString();
            nextMs = n.getTime();
          } catch { /* invalid cron — leave dash */ }
          const msg = item.message.length > 60 ? item.message.slice(0, 57) + "..." : item.message;
          rows.push([cell, item.id, item.cron, msg.replace(/\|/g, "\\|"), last, next, nextMs]);
        }
      }
      // Sort by next fire (soonest first).
      rows.sort((a, b) => a[6] - b[6]);
      for (const r of rows) {
        lines.push(`| ${r[0]} | ${r[1]} | \`${r[2]}\` | ${r[3]} | ${r[4]} | ${r[5]} |`);
      }
      if (rows.length === 0) lines.push("| _(no schedules cached)_ | | | | | |");

      lines.push("", "## Recent fires (last 20)", "");
      const recent = state.log.slice(-20).reverse();
      if (recent.length === 0) {
        lines.push("_(none)_");
      } else {
        lines.push("| ts | cell | id | result |");
        lines.push("|---|---|---|---|");
        for (const e of recent) {
          lines.push(`| ${e.ts} | ${e.cell} | ${e.id} | ${e.result}${e.exit !== undefined ? ` (exit ${e.exit})` : ""} |`);
        }
      }

      fs.writeFileSync(HEARTBEATS_MD, lines.join("\n") + "\n");
      return txt(`✓ rendered ${rows.length} schedule rows, ${recent.length} recent fires`);
    },
  });
}
