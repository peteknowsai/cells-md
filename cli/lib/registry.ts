// Cell registry — the ~/.cells/cells.json document listing every live
// cell. Single source of truth for the registry shape + its read/write,
// shared by the CLI (cells.ts), the proxy, and the harden harness so the
// schema isn't redefined per-file.
//
// Pure logic (parseRegistry, findCellIn) is separated from IO
// (loadRegistry, saveRegistry) so the parse/validate/find behavior is
// unit-testable against strings and arrays — no filesystem.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { REGISTRY_DIR, REGISTRY_PATH } from "./paths";

export type Cell = {
  name: string;
  created_at: string;
  // Birth registers a cell straight as "alive" — mother's end-test has
  // already proven it works. "warming" is legacy (the retired async-tail
  // path); kept readable for older registry entries.
  status?: "warming" | "alive";
  // The egg id this cell hatched from (the hex suffix of egg-<id>).
  hatched_from?: string;
  // Which agent runtime the cell runs — host-bridge reads this to pick the
  // spawn path. Absent on older entries; default to "pi" at read time.
  harness?: "pi" | "claude-code" | "codex" | "hermes";
  // Model fallback chain (per-cell). First entry is the primary; pi-coding-agent
  // advances to the next entry on retry-exhaustion via the patch in
  // apply-pi-patches.sh. Mirrored here so harden-birth can verify the
  // birth pipeline wrote it correctly into the cell's settings.json.
  modelChain?: string[];
  // True for cells born via `cells birth-special` (mother, pulse). These are
  // pinned, baked from bespoke DNA in dna/specials/<name>/, and exempt from
  // `cells kill --all-but` sweeps unless explicitly named.
  special?: boolean;
  // Mirrors welld's auto_sleep_seconds=null state. Source of truth is welld;
  // this is a hint for `cells ls` / `cells doctor`.
  pinned?: boolean;
};

export type Registry = { cells: Cell[] };

// ── Pure logic (no IO) ─────────────────────────────────────────────────

// Parse + envelope-validate a cells.json document. Throws on a malformed
// envelope so a corrupt registry surfaces loudly rather than silently
// reading as zero cells (which would make the whole fleet "disappear"
// from list / doctor / talk).
export function parseRegistry(raw: string): Registry {
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.cells)) {
    throw new Error("cells.json malformed (expected {cells: [...]})");
  }
  return parsed as Registry;
}

export function findCellIn(cells: Cell[], name: string): Cell | undefined {
  return cells.find((c) => c.name === name);
}

// ── IO ─────────────────────────────────────────────────────────────────

export async function loadRegistry(): Promise<Registry> {
  if (!existsSync(REGISTRY_PATH)) return { cells: [] };
  return parseRegistry(await readFile(REGISTRY_PATH, "utf-8"));
}

// Tolerant read for display / discovery / mirror consumers (dashboard,
// peer list) that should degrade to an empty registry rather than throw
// on a missing or corrupt cells.json — a UI or peer-discovery endpoint
// shouldn't crash on a torn write. Authoritative mutation paths use
// loadRegistry, which surfaces corruption loudly.
export async function loadRegistrySafe(): Promise<Registry> {
  try {
    return await loadRegistry();
  } catch {
    return { cells: [] };
  }
}

export async function saveRegistry(reg: Registry): Promise<void> {
  await mkdir(REGISTRY_DIR, { recursive: true });
  // Atomic write: tmp + rename. A crash mid-write must not truncate
  // cells.json into a corrupt doc — parseRegistry throws on that, which
  // would make the whole fleet appear gone. Mirrors savePool.
  const tmp = REGISTRY_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(reg, null, 2));
  await rename(tmp, REGISTRY_PATH);
}

export async function findCell(name: string): Promise<Cell | undefined> {
  return findCellIn((await loadRegistry()).cells, name);
}
