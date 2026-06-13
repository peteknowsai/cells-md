// Cell registry — the ~/.cells/cells.json document listing every live
// cell. Single source of truth for the registry shape + its read/write,
// shared by the CLI (cells.ts), the proxy, and the harden harness so the
// schema isn't redefined per-file.
//
// Pure logic (parseRegistry, findCellIn) is separated from IO
// (loadRegistry, saveRegistry) so the parse/validate/find behavior is
// unit-testable against strings and arrays — no filesystem.

import { closeSync, existsSync, openSync, statSync, writeSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { REGISTRY_DIR, REGISTRY_LOCK_PATH, REGISTRY_PATH } from "./paths";

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
  // name, and the birth-start stale-warming cull (cullStaleWarming) reaps any
  // that outlive a plausible birth.
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
// These return a fresh cells[] for the caller to load → mutate → save. Wrap
// the load→mutate→save in mutateRegistry so the read-modify-write is atomic
// against concurrent writers: saveRegistry alone is atomic (tmp+rename, no torn
// file) but does NOT prevent a lost update, and the mother lock does NOT
// serialize these (it wraps only the LLM handoff). withRegistryLock (below) is
// the shared cross-process lock every cells.json writer takes.

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

// A "warming" entry only outlives its birth when that birth HARD-crashed
// (SIGKILL / power loss) between pre-register and promote/rollback — a clean
// failure rolls it back. Such an orphan is stale once it's older than any
// plausible birth. STALE_WARMING_MS is generous (15 min) so it never reaps a
// legitimately in-flight birth: the mother handoff times out well before this.
export const STALE_WARMING_MS = 15 * 60_000;

export function isStaleWarming(cell: Cell, now: number, maxAgeMs = STALE_WARMING_MS): boolean {
  if (cell.status !== "warming") return false;
  const born = new Date(cell.created_at).getTime();
  if (Number.isNaN(born)) return true; // unparseable timestamp on a warming entry → reap it
  return now - born > maxAgeMs;
}

// Drop warming entries left behind by a hard-crashed birth. Pure: the caller
// runs it inside mutateRegistry at birth start so orphans never accumulate.
export function cullStaleWarming(cells: Cell[], now: number, maxAgeMs = STALE_WARMING_MS): Cell[] {
  return cells.filter((c) => !isStaleWarming(c, now, maxAgeMs));
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

// ── Concurrency: the registry lock ───────────────────────────────────────

type LockHolder = { pid: number; startedAt: string };

async function readLockHolder(): Promise<LockHolder | null> {
  try {
    const h = JSON.parse(await readFile(REGISTRY_LOCK_PATH, "utf-8"));
    return typeof h?.pid === "number" ? h : null;
  } catch {
    return null;
  }
}

// Pure reclaim policy for a contended lock. `liveness` is the holder's pid
// probe ("dead" = ESRCH, "alive" = killable or EPERM, "unknown" = no holder to
// probe). Force-clear when: the holder is dead; or the lock file is malformed/
// empty and not brand-new (the 1s floor protects a lock mid-creation, before
// its pid is written); or a live holder has been wedged absurdly long (30s) —
// a last-ditch safety against a stuck holder that never released.
export const LOCK_STALE_HOLDER_MS = 30_000;
export const LOCK_MALFORMED_FLOOR_MS = 1_000;
export function shouldReclaimLock(
  holder: LockHolder | null,
  liveness: "alive" | "dead" | "unknown",
  now: number,
  malformedAgeMs: number,
): boolean {
  if (!holder) return malformedAgeMs > LOCK_MALFORMED_FLOOR_MS;
  if (liveness === "dead") return true;
  if (liveness === "alive") {
    const startedAt = new Date(holder.startedAt).getTime();
    if (Number.isNaN(startedAt)) return false; // unparseable → don't yank a live holder
    return now - startedAt > LOCK_STALE_HOLDER_MS;
  }
  return false; // unknown — couldn't probe; treat as alive and keep waiting
}

// Cooperative file lock around cells.json read-modify-write. An O_EXCL sentinel
// so two processes can't both hold it, holding the HOLDER's pid so a lock
// orphaned by a crashed holder is reclaimed the instant we notice the pid is
// dead — NOT after a 30s mtime wait (that gap let a contended-by-a-dead-holder
// acquire throw at 10s, which stranded births/kills mid-operation). A live but
// wedged holder (>30s) is still force-cleared as a last-ditch safety. Hold this
// ONLY for the brief load→mutate→save — never across the mother handoff (that's
// withMotherLock's job) — so births and operator edits (cells model/kill/
// project/chain) serialize their writes without blocking on each other's slow
// work.
export async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(REGISTRY_DIR, { recursive: true });
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    // Atomic create-or-fail (wx = O_CREAT|O_EXCL). Keep this its OWN try so an
    // EEXIST means "lock held" and nothing else — fn()'s own errors below must
    // never be mistaken for a contended acquire (that would double-run fn).
    let fd: number | null = null;
    try {
      fd = openSync(REGISTRY_LOCK_PATH, "wx");
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e; // a real FS error, not "already held"
    }
    if (fd !== null) {
      // Acquired. Stamp our pid for reclaim (best-effort), then run fn and
      // always release.
      try { writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
      catch { /* stamp is best-effort; an unstamped lock just reads as malformed */ }
      finally { closeSync(fd); }
      try {
        return await fn();
      } finally {
        try { await unlink(REGISTRY_LOCK_PATH); } catch { /* ignore */ }
      }
    }
    // Held by someone else — reclaim if that someone is dead or wedged.
    const holder = await readLockHolder();
    let liveness: "alive" | "dead" | "unknown" = "unknown";
    if (holder) {
      try {
        process.kill(holder.pid, 0); // probe liveness (signal 0 = no-op)
        liveness = "alive";
      } catch (err: any) {
        liveness = err?.code === "ESRCH" ? "dead" : "alive"; // ESRCH=gone; EPERM=exists
      }
    }
    let malformedAgeMs = 0;
    if (!holder) {
      try { malformedAgeMs = Date.now() - statSync(REGISTRY_LOCK_PATH).mtimeMs; }
      catch { malformedAgeMs = 0; /* vanished mid-check — don't reclaim, loop retries the claim */ }
    }
    if (shouldReclaimLock(holder, liveness, Date.now(), malformedAgeMs)) {
      try { await unlink(REGISTRY_LOCK_PATH); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`could not acquire registry lock at ${REGISTRY_LOCK_PATH} within 10s`);
}

// Atomic load → mutate → save under the registry lock. THE way to write
// cells.json: the mutator gets the freshly-loaded cells[] (no stale snapshot
// held across a slow operation outside the lock) and returns the next cells[].
// Returns the saved registry.
export async function mutateRegistry(mutator: (cells: Cell[]) => Cell[]): Promise<Registry> {
  return withRegistryLock(async () => {
    const reg = await loadRegistry();
    reg.cells = mutator(reg.cells);
    await saveRegistry(reg);
    return reg;
  });
}
