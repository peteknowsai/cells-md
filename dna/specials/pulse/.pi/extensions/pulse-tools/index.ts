/**
 * pulse-tools — the pi-harness binding for pulse.
 *
 * Registers pulse's 9 operations as pi tools. The logic itself lives in
 * the harness-neutral core, lib/pulse-core.mjs — this file only builds the
 * PulsePaths and wraps each core call in pi's tool-content format. The
 * claude-code harness drives the same core through a CLI (bin/pulse-core).
 *
 * Pulse runs in print mode (`pi -p /pulse`); each pulse is a fresh process
 * and all durable state is on disk (see pulse-core.mjs for the layout).
 * The LLM only ever does two things — parse inbox prose into a cron
 * schedule, and write the daily-log paragraph; every tool here is
 * otherwise pure compute.
 */

import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import {
  resolvePaths,
  begin,
  end,
  drainInbox,
  saveSchedule,
  fireDue,
  bootstrapInbox,
  dailyLogDue,
  writeLogEntry,
  renderDigest,
} from "../../../lib/pulse-core.mjs";

// pulse-tools lives at dna/specials/pulse/.pi/extensions/pulse-tools/; the
// vault-readable state/ dir (heartbeats.md, log.md) is three levels up.
// runtimeDir, registry path and vault dir fall to pulse-core's env + ~
// defaults — keeping pi-pulse's resolution byte-identical to before.
const paths = resolvePaths({ stateDir: path.resolve(__dirname, "..", "..", "..", "state") });

function txt(text: string) {
  return { content: [{ type: "text", text }] };
}

export default function (pi: any) {
  // pulse_begin — concurrency check + state snapshot.
  pi.registerTool({
    name: "pulse_begin",
    label: "Begin pulse",
    description:
      "Start a pulse. Acquires the currentPulse sentinel (5-minute staleness window). Returns {skip, reason, isFirstRun, now}. If skip=true, stop immediately — a prior pulse is in flight.",
    parameters: Type.Object({}),
    async execute() {
      return txt(JSON.stringify(begin(paths)));
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
      end(paths);
      return txt("pulse ended");
    },
  });

  // drain_inbox — read all inbox entries; auto-skip no-op edits.
  pi.registerTool({
    name: "drain_inbox",
    label: "Drain inbox",
    description:
      "Read every file in ~/.cells/pulse-inbox/ (excluding processed/). Returns [{cell, content, path, ts}, ...]. Entries whose content hash matches the cell's existing pulse-cache (no-op edits) are auto-moved to processed/ and NOT returned — saves an LLM round-trip. The LLM only sees entries that need re-parsing.",
    parameters: Type.Object({}),
    async execute() {
      return txt(JSON.stringify(drainInbox(paths)));
    },
  });

  // save_schedule — write cache + atomically move source inbox file to processed/.
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
    async execute(_id: string, params: { cell: string; items: Array<{ id: string; cron: string; message: string }>; sourcePath?: string }) {
      const r = saveSchedule(paths, params);
      if (!r.ok) return txt(`✗ ${r.error}`);
      return txt(
        `✓ saved ${r.count} schedule item(s) for ${r.cell}` +
        (r.pruned > 0 ? ` (pruned ${r.pruned} stale lastFire key${r.pruned === 1 ? "" : "s"})` : ""),
      );
    },
  });

  // fire_due — eval cron against now, fire any due items, record.
  pi.registerTool({
    name: "fire_due",
    label: "Fire due wakes",
    description:
      "Evaluate every cached schedule against the last 60 seconds. For each item due AND not already fired this minute (lastFire check), shell out to `cells talk <cell> \"<message>\"` and append a log entry. Returns a summary of fires attempted.",
    parameters: Type.Object({}),
    async execute() {
      return txt(JSON.stringify(await fireDue(paths)));
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
      const r = await bootstrapInbox(paths);
      if (r.note) return txt(r.note);
      return txt(`✓ synthesized ${r.count} inbox entries from vault`);
    },
  });

  // daily_log_due — check whether log.md is missing today's entry.
  pi.registerTool({
    name: "daily_log_due",
    label: "Check daily log",
    description:
      "Returns {needed, today, fires}. If log.md already has an entry for today (LOCAL date — rolls over at midnight Pacific), needed=false. Otherwise needed=true and fires is the list of log entries from the last 24h to summarize. Call write_log_entry after composing a one-paragraph narrative.",
    parameters: Type.Object({}),
    async execute() {
      return txt(JSON.stringify(dailyLogDue(paths)));
    },
  });

  // write_log_entry — prepend a daily narrative entry to state/log.md.
  pi.registerTool({
    name: "write_log_entry",
    label: "Write daily log entry",
    description:
      "Prepend a daily narrative entry to dna/specials/pulse/state/log.md. body should be a short paragraph (~3-5 sentences) describing what happened in the prior 24h. Markdown, no leading H2 (the tool adds `## <date>`). The date is LOCAL — pass the value daily_log_due returned.",
    parameters: Type.Object({
      date: Type.String({ description: "YYYY-MM-DD (local TZ — value from daily_log_due.today)." }),
      body: Type.String({ description: "Markdown paragraph; no headers." }),
    }),
    async execute(_id: string, params: { date: string; body: string }) {
      const r = writeLogEntry(paths, params);
      return txt(`✓ logged ${r.date} (${r.bytes}B)`);
    },
  });

  // render_digest — write the heartbeats.md table.
  pi.registerTool({
    name: "render_digest",
    label: "Render heartbeats digest",
    description:
      "Write dna/specials/pulse/state/heartbeats.md — a markdown table of every cell's schedule, last-fire, next-fire. Pure compute over pulse-cache/ + state. Call at the end of each pulse.",
    parameters: Type.Object({}),
    async execute() {
      const r = renderDigest(paths);
      return txt(
        `✓ rendered ${r.rows} schedule rows, ${r.recent} recent fires` +
        (r.flagged ? `, ${r.flagged} flagged` : ""),
      );
    },
  });
}
