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
  // Birth is two-phase against the registry: a cell is registered "warming"
  // BEFORE mother's end-test (the end-test's Anthropic call needs the proxy's
  // Max-policy gate to find the cell + its harness — see cli/lib/proxy-oauth.ts),
  // then promoted to "alive" once the ritual proves it, or removed on failure.
  // A leaked "warming" entry (birth HARD-crashed mid-ritual) is NON-authoritative:
  // the duplicate-name check ignores it (isNameTaken) and fleet readers
  // (doctor / peers / cockpit) skip it, so it can't wedge a name or raise a
  // phantom "cell can't talk" failure. It clears on the next birth/kill of that
  // name, and the steward's stale-warming cull reaps any that outlive a birth.
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
  // Free-form project label used to group the fleet in `cells agents`. The
  // Mac-side fleet index owns this (not the cell's in-VM IDENTITY.md) so the
  // cockpit can group / retag without waking a hibernated cell. Set at birth
  // with `--project`, changed later with `cells project <name> <project>` or
  // the in-view `r` retag. Absent → grouped under "unassigned".
  project?: string;
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

// ── Birth-lifecycle mutations (pure; the caller wraps load/save) ────────
// These return a fresh cells[] for the caller to load → mutate → save. NOTE on
// concurrency: registry writes are currently lock-free. saveRegistry is atomic
// (tmp+rename, so no torn file) but that does NOT prevent a lost update — and
// the mother lock does NOT serialize these (it wraps only the LLM handoff). So
// a concurrent operator write during a birth (cells model/kill/project/chain)
// can clobber the warming entry. A shared withRegistryLock around every
// cells.json read-modify-write is the durable fix (landing next).

// Register a cell as "warming" (mid-birth, before the end-test). Replaces any
// existing entry of the same name so a leaked warming entry from a crashed
// prior birth doesn't block the retry. The caller verifies no *alive* cell
// owns the name first (see isNameTaken).
export function upsertBirthingCell(cells: Cell[], entry: Omit<Cell, "status">): Cell[] {
  return [...cells.filter((c) => c.name !== entry.name), { ...entry, status: "warming" }];
}

// Promote a warming cell to "alive", patching any fields the birth retry loop
// changed (e.g. hatched_from points at the final egg). No-op if name absent.
export function promoteCell(cells: Cell[], name: string, patch: Partial<Cell> = {}): Cell[] {
  return cells.map((c) => (c.name === name ? { ...c, ...patch, status: "alive" as const } : c));
}

// Remove a cell — birth rollback, or kill.
export function removeCell(cells: Cell[], name: string): Cell[] {
  return cells.filter((c) => c.name !== name);
}

// Whether a name is taken by a *real* (alive) cell. A "warming" entry is a
// birth in flight or a leaked crash artifact — it does NOT reserve the name
// (otherwise a crashed birth would wedge the name forever). Births serialize,
// so a warming entry is never a concurrent birth of the same name.
export function isNameTaken(cells: Cell[], name: string): boolean {
  const c = findCellIn(cells, name);
  return !!c && c.status !== "warming";
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
