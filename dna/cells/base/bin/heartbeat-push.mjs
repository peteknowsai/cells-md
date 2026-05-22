#!/usr/bin/env node
/**
 * heartbeat-push — claude-code cell hook: push HEARTBEAT.md to pulse.
 *
 * The claude-code-harness counterpart to the pi `heartbeat-watch` extension.
 * pi cells watch HEARTBEAT.md with fs.watch from inside a pi session; a
 * claude-code cell can't run a pi extension, so this fires from
 * .claude/settings.json hooks instead:
 *
 *   PostToolUse (Write|Edit|MultiEdit) — the agent edited a file; push if
 *                                        that file was HEARTBEAT.md.
 *   SessionStart                       — the cell woke; re-push the current
 *                                        schedule so pulse re-syncs.
 *
 * Either way it POSTs {cell, content, ts} to proxy.cells.md/heartbeat-changed,
 * byte-for-byte the same payload the pi extension sends. Pulse hash-dedupes,
 * so a redundant push costs nothing.
 *
 * Best-effort: every failure logs to stderr and exits 0 — a missed push is
 * not fatal (pulse's bootstrap walk catches stragglers, and the next edit or
 * wake pushes again). It must never block the agent.
 *
 * Auth: shared CELLS_PROXY_SECRET from the cell environment — the same
 * secret the subscriptions proxy and the pi extension use.
 *
 * ES module (.mjs): the explicit extension keeps this script's module mode
 * independent of whatever package.json sits above it on a given cell.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// PULSE_HEARTBEAT_URL overrides the endpoint (used by the end-to-end test).
const PULSE_URL = process.env.PULSE_HEARTBEAT_URL ?? "https://proxy.cells.md/heartbeat-changed";

function log(msg) {
  process.stderr.write(`[heartbeat-push] ${msg}\n`);
}

async function main() {
  // Claude Code delivers the hook payload as JSON on stdin.
  let payload = {};
  try {
    const raw = fs.readFileSync(0, "utf-8");
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    /* no / non-JSON stdin — fall through to an unconditional push */
  }

  // On a tool-use hook, only push when HEARTBEAT.md itself was the file
  // written. On SessionStart (no tool_input) push unconditionally to
  // re-sync the schedule after a hibernation wake. Fail closed: if the
  // payload shape is unexpected, skip rather than push on every edit.
  if (payload.hook_event_name === "PostToolUse") {
    const fp = (payload.tool_input && payload.tool_input.file_path) || "";
    if (!fp.endsWith("HEARTBEAT.md")) return;
  }

  // Hooks run from the project root; CLAUDE_PROJECT_DIR is the cell root.
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  if (!fs.existsSync(heartbeatPath)) {
    log(`no ${heartbeatPath} — nothing to push`);
    return;
  }

  const secret = process.env.CELLS_PROXY_SECRET;
  if (!secret) {
    log("CELLS_PROXY_SECRET not set — skipping push");
    return;
  }

  // CELL_NAME (set in the cell environment at birth) is the authoritative
  // registry name. Hostname is only a fallback — on claude-code cells it is
  // often the egg id (e.g. "egg-0f7d66"), which pulse cannot `cells talk`.
  const cell = process.env.CELL_NAME || os.hostname() || "unknown";
  const content = fs.readFileSync(heartbeatPath, "utf-8");

  try {
    const res = await fetch(PULSE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
        "x-cell-name": cell,
      },
      body: JSON.stringify({ cell, content, ts: new Date().toISOString() }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`pulse rejected ${res.status}: ${body.slice(0, 100)}`);
      return;
    }
    log(`pushed ${cell} HEARTBEAT.md (${content.length}B) -> pulse`);
  } catch (e) {
    log(`pulse unreachable: ${String(e).slice(0, 120)}`);
  }
}

main().catch((e) => log(`unexpected: ${String(e).slice(0, 120)}`));
