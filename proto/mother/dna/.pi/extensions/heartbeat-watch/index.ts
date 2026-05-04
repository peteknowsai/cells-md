/**
 * heartbeat-watch — push HEARTBEAT.md changes to pulse.
 *
 * Watches the agent's HEARTBEAT.md for writes. On change, POSTs the new
 * content to https://pulse.cells.md/heartbeat-changed. Pulse drains its
 * inbox each tick, re-interprets the prose schedule (LLM call), and updates
 * its cached cron table. Without this, pulse would have to poll every cell
 * over sprite_exec — wasteful and warms otherwise-hibernating sprites.
 *
 * Best-effort. On HTTP failure (subscriptions proxy down, transient network), log
 * and move on — pulse's bootstrap walk catches stragglers next time it
 * boots, so a missed event isn't catastrophic.
 *
 * Auth: shared CELLS_PROXY_SECRET, available on cells as MOTHER_SECRET (set
 * by configure-cell-proxy.sh into ~/.bashrc.d/site_proxy).
 *
 * Cell name: this cell's hostname, which by convention matches the cell
 * name in the registry (sprites.dev sprite name == cell name == agent name).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PULSE_URL = "https://pulse.cells.md/heartbeat-changed";
const DEBOUNCE_MS = 2000;
const HEARTBEAT_FILENAME = "HEARTBEAT.md";

function readSelfName(): string {
  // hostname matches the cell name by convention (set at sprite-create).
  // os.hostname() works under Node and Bun. Fall back to env, then "unknown".
  return os.hostname() || process.env.CELL_NAME || "unknown";
}

async function postHeartbeat(cell: string, content: string, secret: string): Promise<void> {
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
      console.error(`[heartbeat-watch] pulse rejected ${res.status}: ${body.slice(0, 100)}`);
      return;
    }
    console.log(`[heartbeat-watch] posted ${cell} HEARTBEAT.md (${content.length}B) -> pulse`);
  } catch (e) {
    console.error(`[heartbeat-watch] pulse unreachable: ${String(e).slice(0, 120)}`);
  }
}

export default function (pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    const heartbeatPath = path.join(ctx.cwd, HEARTBEAT_FILENAME);
    if (!fs.existsSync(heartbeatPath)) {
      console.error(`[heartbeat-watch] no ${heartbeatPath} — extension idle`);
      return;
    }

    const secret = process.env.MOTHER_SECRET;
    if (!secret) {
      console.error("[heartbeat-watch] MOTHER_SECRET not set — extension idle");
      return;
    }

    const cell = readSelfName();
    let timer: NodeJS.Timeout | null = null;

    fs.watch(heartbeatPath, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        timer = null;
        let content: string;
        try {
          content = fs.readFileSync(heartbeatPath, "utf-8");
        } catch (e) {
          console.error(`[heartbeat-watch] read ${heartbeatPath} failed: ${e}`);
          return;
        }
        await postHeartbeat(cell, content, secret);
      }, DEBOUNCE_MS);
    });

    console.log(`[heartbeat-watch] watching ${heartbeatPath} for cell ${cell}`);
  });
}
