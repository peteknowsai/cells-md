// SwiftBar plugin renderer. Emits SwiftBar's text format on stdout.
//
// Title bar: 🧬 <alive-count>
// Dropdown: one line per cell, each with a submenu of actions.
//
// Status sources:
//   ~/.cells/cells.json   — registry (cell → hatched_from + special flag)
//   ~/.cells/pool.json    — pool (hatched_from → well_name)
//   `well list`            — well status (running | stopped)
//
// Actions for each cell route through Ghostty:
//   Open shell  → cells shell <name>
//   Open TUI    → cells tui <name>
//   Open site   → https://<name>.cells.md (browser, not Ghostty)

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Deploy status from ~/.cells/logs/birth-postwork/<name>.log:
//   "done"    — log has "post-birth done"
//   "running" — log exists, no done marker
//   ""        — no log (legacy birth before post-birth split)
function postBirthStatus(name: string): "done" | "running" | "" {
  const logPath = join(homedir(), ".cells", "logs", "birth-postwork", `${name}.log`);
  if (!existsSync(logPath)) return "";
  try {
    const txt = readFileSync(logPath, "utf-8");
    if (txt.includes("post-birth done")) return "done";
    return "running";
  } catch {
    return "";
  }
}

// A helper script on disk does the heavy lifting: launches Ghostty, holds the
// window open after the command exits so we can see error output. SwiftBar
// just passes the cells subcommand + name as positional args — no shell
// quoting nightmares, no spaces-in-params problems. The helper is installed
// by `cells menubar install` and carries the absolute path to the cells CLI.
const RUN_HELPER = `${process.env.HOME}/.cells/menubar/run.sh`;
const BROWSER_PREFIX = "https://";
const WELL_BASE = "cells.md";

type Cell = {
  name: string;
  hatched_from?: string;
  special?: boolean;
  harness?: string;
};

type PoolMember = {
  id: string;
  well_name: string;
};

type WellStatus = "running" | "stopped" | "unknown";

async function loadCells(): Promise<Cell[]> {
  try {
    const txt = await readFile(join(homedir(), ".cells", "cells.json"), "utf8");
    return (JSON.parse(txt).cells ?? []) as Cell[];
  } catch {
    return [];
  }
}

async function loadPool(): Promise<PoolMember[]> {
  try {
    const txt = await readFile(join(homedir(), ".cells", "pool.json"), "utf8");
    return (JSON.parse(txt).members ?? []) as PoolMember[];
  } catch {
    return [];
  }
}

function wellNameFor(cell: Cell, pool: PoolMember[]): string {
  if (cell.special) return `cells-${cell.name}`;
  if (!cell.hatched_from) return cell.name;
  const m = pool.find((p) => p.id === cell.hatched_from);
  return m?.well_name ?? cell.name;
}

async function loadWellStatuses(): Promise<Map<string, WellStatus>> {
  const map = new Map<string, WellStatus>();
  try {
    const proc = Bun.spawn(["well", "list"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    // Lines look like: "egg-833480    running  192.168.64.205  23h"
    for (const line of out.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const [name, status] = parts;
      if (!name) continue;
      const s: WellStatus = status === "running" ? "running" : status === "stopped" ? "stopped" : "unknown";
      map.set(name, s);
    }
  } catch {
    // well CLI missing or failed — every cell will appear unknown
  }
  return map;
}

// SwiftBar params are positional: param1, param2, param3… one shell-arg each.
// Values must NOT contain spaces — SwiftBar passes them through verbatim, so
// `cells shell foo` needs to land as three separate paramN entries, not one.
function ghosttyExec(cmd: string[]): string {
  // SwiftBar passes each param verbatim, but it splits the whole `shell=…
  // param1=… param2=…` line on whitespace — so values with spaces get
  // chopped. We delegate to a helper script on disk that handles
  // hold-open-on-exit + the Ghostty launch. Each cmd[] entry becomes its
  // own paramN, no quoting required.
  const params: string[] = [`shell=${RUN_HELPER}`];
  cmd.forEach((arg, i) => params.push(`param${i + 1}=${arg}`));
  params.push("terminal=false");
  return params.join(" ");
}

function cellLine(
  cell: Cell,
  well: string,
  status: WellStatus,
): string[] {
  const isAlive = status === "running";
  const dot = isAlive ? "🟢" : status === "stopped" ? "⚪" : "🟡";
  const color = isAlive ? "color=#5ec27a" : "color=#888888";
  const harness = cell.harness ?? "pi";
  // Deploy chip: ⏳ while post-birth tasks are running, nothing once "done"
  // or for legacy cells. Only surface when actively in-flight, so the bar
  // doesn't get noisy with green checkmarks on every cell.
  const deploy = postBirthStatus(cell.name);
  const deployChip = deploy === "running" ? " ⏳" : "";
  const title = `${dot} ${cell.name}${deployChip} | ${color} size=13 font=Menlo`;

  const shellAction = ghosttyExec(["shell", cell.name]);
  const tuiAction = ghosttyExec(["tui", cell.name]);
  const siteAction = `href=${BROWSER_PREFIX}${cell.name}.${WELL_BASE}`;
  const deployLine = deploy
    ? ` · deploy ${deploy}`
    : "";

  return [
    title,
    `-- Open shell | ${shellAction}`,
    `-- Open TUI in Ghostty | ${tuiAction}`,
    `-- Open site | ${siteAction}`,
    `-----`,
    `-- ${harness} · well ${well} · ${status}${deployLine} | color=#888888 size=11`,
  ];
}

async function main() {
  const [cells, pool, statuses] = await Promise.all([
    loadCells(),
    loadPool(),
    loadWellStatuses(),
  ]);

  const enriched = cells
    .map((c) => {
      const well = wellNameFor(c, pool);
      const status = statuses.get(well) ?? "unknown";
      return { cell: c, well, status };
    })
    .sort((a, b) => {
      // Alive first, then by name.
      const aAlive = a.status === "running" ? 0 : 1;
      const bAlive = b.status === "running" ? 0 : 1;
      if (aAlive !== bAlive) return aAlive - bAlive;
      return a.cell.name.localeCompare(b.cell.name);
    });

  const aliveCount = enriched.filter((e) => e.status === "running").length;

  const out: string[] = [];
  out.push(`🧬 ${aliveCount}`);
  out.push("---");

  if (enriched.length === 0) {
    out.push("no cells | color=#888888");
  } else {
    for (const e of enriched) {
      out.push(...cellLine(e.cell, e.well, e.status));
    }
  }

  out.push("---");
  out.push(`Open dashboard | ${ghosttyExec(["dashboard"])}`);
  out.push(`Birth new cell… | ${ghosttyExec(["birth"])}`);
  out.push("Refresh | refresh=true");

  console.log(out.join("\n"));
}

await main();
