// Fleet index — the normalized "every cell, with where it lives and what
// state it's in" view that the `cells agents` cockpit renders. One place
// that merges the three Mac-side sources of fleet truth:
//
//   registry (~/.cells/cells.json)  → name, harness, model, project, special
//   pool     (~/.cells/pool.json)   → cell → well-name (egg-<id>) mapping
//   welld    (/dashboard/data)      → live power (running/stopped) + wedge + ip
//
// Pure logic (well-name resolution, model shortening, grouping, sorting,
// age formatting) is separated from IO (loadFleet, fetchWells) so the
// shaping behavior is unit-testable against plain arrays — no filesystem,
// no daemon. Mirrors the registry.ts / pool.ts split.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Cell, loadRegistrySafe } from "./registry";
import { type PoolMember, parsePoolFile } from "./pool";
import { POOL_PATH } from "./paths";

const WELL_API = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";

// ── Types ───────────────────────────────────────────────────────────────

// awake = welld reports the VM running; asleep = hibernated on disk;
// unknown = welld unreachable or the well isn't in welld's view yet.
export type Power = "awake" | "asleep" | "unknown";
// Mirrors welld's wedge field. "ok" is healthy; suspected/confirmed mean
// the well needs an operator's eyes — the cells analog of "needs input".
export type Health = "ok" | "suspected" | "confirmed";
export type Grouping = "project" | "state";

export type FleetCell = {
  name: string;
  project: string; // "" means unassigned
  harness: string;
  model: string; // short token, e.g. "opus-4-7" / "gpt-5.5"
  special: boolean;
  pinned: boolean;
  power: Power;
  health: Health;
  ip: string | null;
  ageMinutes: number;
  wellName: string;
  createdAt: string;
};

// A welld /dashboard/data well row — only the fields the fleet view reads.
type WellRow = {
  name: string;
  status?: string; // "running" | "stopped"
  runtime_state?: string; // "alive_running" | "hibernating" | ...
  wedge?: string; // "ok" | "suspected" | "confirmed"
  ip?: string | null;
};

// ── Pure logic (no IO) ────────────────────────────────────────────────────

// Cell → well-name. Same rules as lib/resolve.ts#wellNameForCell, but pure:
// the caller passes the already-loaded pool members so the cockpit resolves
// the whole fleet in-memory instead of re-reading the pool once per cell.
export function wellNameFor(cell: Pick<Cell, "name" | "special" | "hatched_from">, members: PoolMember[]): string {
  if (cell.special) return `cells-${cell.name}`;
  if (!cell.hatched_from) return cell.name;
  const m = members.find((e) => e.id === cell.hatched_from);
  return m?.well_name ?? cell.name;
}

// Friendly model token from a fallback chain entry. Entries look like
// "anthropic/claude-opus-4-7:high", "openai-codex/gpt-5.5:medium", or
// "claude-code:anthropic/claude-opus-4-7:high" (with a leading harness
// prefix). We want the model leaf: the colon-segment that carries the
// provider/model, then the part after the last "/".
export function shortModel(chain: string[] | undefined): string {
  const entry = chain?.[0] ?? "";
  if (!entry) return "?";
  const segs = entry.split(":");
  const provModel = segs.find((s) => s.includes("/")) ?? segs[0]!;
  const leaf = provModel.includes("/") ? provModel.slice(provModel.lastIndexOf("/") + 1) : provModel;
  return leaf || "?";
}

export function powerFromWell(well: WellRow | undefined): Power {
  if (!well) return "unknown";
  if (well.status === "running") return "awake";
  if (well.status === "stopped") return "asleep";
  return "unknown";
}

export function healthFromWell(well: WellRow | undefined): Health {
  const w = well?.wedge;
  return w === "suspected" || w === "confirmed" ? w : "ok";
}

export function ageMinutes(iso: string | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 60_000));
}

export function formatAge(min: number): string {
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Power sort rank: awake first, then asleep, then unknown.
function powerRank(p: Power): number {
  return p === "awake" ? 0 : p === "asleep" ? 1 : 2;
}

// Within any group: operators (special/pinned) first, then awake before
// asleep, then alphabetical. Stable, total order — no surprises on refresh.
export function sortCells(cells: FleetCell[]): FleetCell[] {
  return [...cells].sort((a, b) => {
    const ap = a.special || a.pinned ? 0 : 1;
    const bp = b.special || b.pinned ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const pr = powerRank(a.power) - powerRank(b.power);
    if (pr !== 0) return pr;
    return a.name.localeCompare(b.name);
  });
}

export type FleetGroup = {
  key: string;
  label: string;
  kind: "operators" | "project" | "state";
  cells: FleetCell[];
};

// Group the fleet for display. Operators (special/pinned — mother, pulse)
// always float into their own group at the top regardless of grouping mode,
// because they're the always-on machinery, not project work. The rest split
// by project (unassigned last) or by power state.
export function groupFleet(cells: FleetCell[], grouping: Grouping): FleetGroup[] {
  const operators = cells.filter((c) => c.special || c.pinned);
  const rest = cells.filter((c) => !(c.special || c.pinned));
  const groups: FleetGroup[] = [];

  if (operators.length) {
    groups.push({ key: "__operators", label: "operators", kind: "operators", cells: sortCells(operators) });
  }

  if (grouping === "project") {
    const byProj = new Map<string, FleetCell[]>();
    for (const c of rest) {
      const k = c.project.trim();
      const arr = byProj.get(k);
      if (arr) arr.push(c);
      else byProj.set(k, [c]);
    }
    const keys = [...byProj.keys()].sort((a, b) => {
      if (a === "") return 1; // unassigned sinks to the bottom
      if (b === "") return -1;
      return a.localeCompare(b);
    });
    for (const k of keys) {
      groups.push({
        key: k || "__unassigned",
        label: k || "unassigned",
        kind: "project",
        cells: sortCells(byProj.get(k)!),
      });
    }
  } else {
    for (const p of ["awake", "asleep", "unknown"] as Power[]) {
      const cs = rest.filter((c) => c.power === p);
      if (cs.length) groups.push({ key: p, label: p, kind: "state", cells: sortCells(cs) });
    }
  }

  return groups;
}

// Flatten grouped fleet into display rows: a header row per group followed
// by its cell rows. The cockpit walks `kind === "cell"` rows for selection.
export type FleetRow =
  | { kind: "header"; group: FleetGroup }
  | { kind: "cell"; cell: FleetCell; group: FleetGroup };

export function flattenRows(groups: FleetGroup[]): FleetRow[] {
  const rows: FleetRow[] = [];
  for (const g of groups) {
    rows.push({ kind: "header", group: g });
    for (const c of g.cells) rows.push({ kind: "cell", cell: c, group: g });
  }
  return rows;
}

export type FleetCounts = { total: number; awake: number; asleep: number; projects: number };

export function fleetCounts(cells: FleetCell[]): FleetCounts {
  const projects = new Set<string>();
  let awake = 0;
  let asleep = 0;
  for (const c of cells) {
    if (c.power === "awake") awake++;
    else if (c.power === "asleep") asleep++;
    if (!c.special && !c.pinned && c.project.trim()) projects.add(c.project.trim());
  }
  return { total: cells.length, awake, asleep, projects: projects.size };
}

// ── IO ─────────────────────────────────────────────────────────────────

async function loadPoolSafe(): Promise<PoolMember[]> {
  try {
    return parsePoolFile(await readFile(POOL_PATH, "utf-8")).members;
  } catch {
    return [];
  }
}

// GET welld /dashboard/data. Returns null (not []) on any failure so the
// caller can distinguish "welld unreachable → power unknown" from "welld up,
// zero wells". Short timeout: the cockpit polls this and must stay snappy.
async function fetchWells(): Promise<WellRow[] | null> {
  let token: string;
  try {
    token = (await readFile(join(homedir(), ".wells", "token"), "utf-8")).trim();
  } catch {
    return null;
  }
  try {
    const r = await fetch(`${WELL_API}/dashboard/data`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { wells?: WellRow[] };
    return data?.wells ?? [];
  } catch {
    return null;
  }
}

export type FleetSnapshot = { cells: FleetCell[]; welldReachable: boolean };

export async function loadFleet(): Promise<FleetSnapshot> {
  const [reg, members, wells] = await Promise.all([loadRegistrySafe(), loadPoolSafe(), fetchWells()]);
  const welldReachable = wells !== null;
  const byWell = new Map<string, WellRow>((wells ?? []).map((w) => [w.name, w]));

  const cells: FleetCell[] = reg.cells.map((c) => {
    const wellName = wellNameFor(c, members);
    const well = byWell.get(wellName);
    return {
      name: c.name,
      project: c.project?.trim() || "",
      harness: c.harness ?? "pi",
      model: shortModel(c.modelChain),
      special: !!c.special,
      pinned: !!c.pinned,
      power: welldReachable ? powerFromWell(well) : "unknown",
      health: healthFromWell(well),
      ip: well?.ip ?? null,
      ageMinutes: ageMinutes(c.created_at),
      wellName,
      createdAt: c.created_at,
    };
  });

  return { cells, welldReachable };
}
