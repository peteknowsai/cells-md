/**
 * mother-status — identity + stats widget for the mother agent.
 *
 * Shows: 🜨 mother · N children · last born: name (age)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REGISTRY_PATH = join(homedir(), ".cells", "cells.json");
const ACTIVITY_LOG = join(homedir(), "Projects", "cells", "state", "memory", "project_cells_activity.md");
const WIDGET_KEY = "mother-status";

type Cell = { name: string; created_at: string };
type Registry = { cells?: Cell[] };

function ageString(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "?";
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(ms / 86_400_000);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "just now";
}

function loadStatus(): string[] {
  let cells: Cell[] = [];
  if (existsSync(REGISTRY_PATH)) {
    try {
      const reg: Registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
      cells = reg.cells ?? [];
    } catch {
      return ["mother · (registry parse error)"];
    }
  }

  const n = cells.length;
  const childWord = n === 1 ? "child" : "children";
  const parts = [`mother`, `${n} ${childWord}`];

  if (n > 0) {
    const sorted = [...cells].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const eldest = sorted[0];
    const lastBorn = sorted[sorted.length - 1];
    parts.push(`eldest: ${eldest.name} (${ageString(eldest.created_at)})`);
    if (lastBorn.name !== eldest.name) {
      parts.push(`last born: ${lastBorn.name} (${ageString(lastBorn.created_at)})`);
    }
  }

  const deaths = countDeaths();
  if (deaths > 0) parts.push(`${deaths} dead`);

  return [parts.join("  ·  ")];
}

function refresh(ctx: any): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, loadStatus(), { placement: "belowEditor" });
}

function countDeaths(): number {
  if (!existsSync(ACTIVITY_LOG)) return 0;
  try {
    const text = readFileSync(ACTIVITY_LOG, "utf-8");
    return (text.match(/\bdestroyed\b/g) ?? []).length;
  } catch {
    return 0;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("turn_end", (_event, ctx) => refresh(ctx));
}
