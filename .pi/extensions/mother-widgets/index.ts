/**
 * mother-widgets — UI widgets only the mother has.
 *
 * Lives in the mother's local `.pi/extensions/` (NOT the template, so
 * remote agents don't get it). Registers ambient UI elements that give the
 * mother at-a-glance awareness of the cells she manages.
 *
 * v1: a roster footer showing every cell's name + age. Refreshed on
 * session_start and turn_end so it stays current as you create/destroy.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REGISTRY_PATH = join(homedir(), ".cells", "cells.json");
const WIDGET_KEY = "mother-roster";

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
  return `${m}m`;
}

function loadRoster(): string[] {
  if (!existsSync(REGISTRY_PATH)) {
    return ["── cells ── (none yet)"];
  }
  let reg: Registry;
  try {
    reg = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return ["── cells ── (registry parse error)"];
  }
  const cells = reg.cells ?? [];
  if (cells.length === 0) {
    return ["── cells ── (none yet)"];
  }
  const summary = cells
    .map((c) => `${c.name} (${ageString(c.created_at)})`)
    .join("  ·  ");
  return [`── cells ── ${summary}`];
}

function refresh(ctx: any): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, loadRoster(), { placement: "belowEditor" });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("turn_end", (_event, ctx) => refresh(ctx));
}
