// Pool storage primitives — types, the V1 constants, and atomic
// load/save/lock over ~/.cells/pool.json.
//
// History: pool state used to be spread across three files reading
// pool.json each their own way (cells.ts with a migration shim;
// proxy.ts raw JSON.parse, no shim; harden-birth.ts roll-your-own, no
// shim). The shimless callers landed bugs after the 2026-05-22 warm→open
// rename and the 2026-05-13 uniform-pool signature change. This module is
// the single import point for any process that touches pool.json.
//
// Pure logic (parsePoolFile, countOpen) is separated from IO (loadPool,
// savePool) so the parse/migrate/filter behavior is unit-testable against
// strings and arrays — no filesystem, no temp dirs.

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { REGISTRY_DIR, POOL_PATH, POOL_LOCK_PATH, LEGACY_EGGS_JSON_PATH } from "./paths";

// Two-axis pool member state. `standing` (state) is pool membership —
// open = unclaimed, claimed = a birth has it, live = consumed by a
// living cell, culling = scheduled for removal. `power` is derived
// from `tier` (4 = running in RAM, 2 = hibernated on disk).
export type PoolMemberState = "open" | "claimed" | "live" | "culling";

export type PoolMember = {
  id: string;                  // 6-hex hash of variant signature
  well_name: string;           // egg-<modeltoken>-<id>
  variant_signature: string;   // canonical "v1:..." per cli/lib/variant-signature.ts
  state: PoolMemberState;
  born_at: string;
  claimed_at: string | null;
  claimed_by: string | null;   // cell name that hatched this egg
  max_age_at: string;          // born_at + 7 days; not enforced in Phase 1
  tier?: 2 | 4;                // optional in storage; V1 members carry it
};

export type PoolFile = { version: 1; members: PoolMember[] };

// V1 pool is uniform: every egg is identical (one generic shape baked
// from cell-base). Variant fan-out is V2 territory. This constant
// MUST match what bakePoolMember writes — never re-declare it in a
// consumer file.
export const V1_POOL_VARIANT_SIGNATURE = "v1-generic";

// V1 pool target depth — small on purpose. Eggs go stale as the system
// hardens; a deep pool means more stale eggs to reap. Birth tops the
// pool back up by one on its way out, so steady state holds at this
// value without a background refiller.
export const V1_POOL_TARGET_DEPTH = 5;

// V1 ships pure-hibernated: zero running eggs. Every claim falls
// through to a tier-2 egg, the birth flow /wake's it (~0.5s), mother
// runs the ritual on the SSH-ready VM. The "running pool" plumbing
// (hibernated→running promote, etc.) stays in the code dormant —
// target 0 makes it a no-op — so V2's variant pool can re-enable hot
// eggs without re-introducing the code.
export const V1_RUNNING_POOL_TARGET = 0;

// ── Pure logic (no IO — unit-testable against strings/arrays) ──────────

// Parse + envelope-validate a pool.json document. Throws on a malformed
// envelope so a corrupt file surfaces loudly rather than silently
// reading as an empty pool (which would look like "wipe the pool").
//
// Normalizes the legacy "warm" standing to "open" (the 2026-05-22 rename).
// This is NOT a deletable shim: nothing reaps legacy-state members — claim,
// refill, reconcile, and drain all filter for state === "open", and
// max_age_at is not enforced — so a stray "warm" would never be claimed,
// never culled, and refill would bake replacements while it lingers
// indefinitely. Cheap and idempotent; keep it as long as the on-disk
// format can carry a pre-rename value.
export function parsePoolFile(raw: string): PoolFile {
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || !Array.isArray(parsed.members)) {
    throw new Error("pool.json malformed (expected {version: 1, members: [...]})");
  }
  normalizeMembers(parsed.members);
  return parsed as PoolFile;
}

// Normalize legacy member state in place — the 2026-05-22 "warm" → "open"
// rename. Used by BOTH parsePoolFile and loadPool's eggs.json migration, so
// a legacy egg can't slip through the migration path still spelled "warm"
// (claim/refill/reconcile/drain all filter for "open", so a stray "warm"
// would be invisible until the next reparse). See parsePoolFile's note on
// why this is permanent, not a deletable shim.
function normalizeMembers(members: PoolMember[]): PoolMember[] {
  for (const m of members) {
    if ((m as any).state === "warm") (m as any).state = "open";
  }
  return members;
}

// Interpret the pre-2026-05-13 legacy on-disk format ({ eggs: [...] }) as a
// current PoolFile ({ version: 1, members: [...] }). Pure so the migration's
// risk-bearing detail — normalizing legacy "warm" → "open" while reshaping —
// is unit-testable without the filesystem. This is the exact step that
// regressed once (the migration branch reshaped eggs→members but skipped the
// warm→open pass, so a migrated egg stayed invisibly "warm"); keep it here,
// covered, rather than inline in loadPool's IO. A missing/!array `eggs` key
// yields an empty pool — the same degrade-to-empty stance as a missing file.
export function parseLegacyEggs(raw: string): PoolFile {
  const legacy = JSON.parse(raw);
  const members = normalizeMembers(Array.isArray(legacy?.eggs) ? legacy.eggs : []);
  return { version: 1, members };
}

// Count V1 open pool members (uniform-pool only — variant-pool members
// would never satisfy variant_signature === V1_POOL_VARIANT_SIGNATURE).
export function countOpen(members: PoolMember[]): number {
  return members.filter(
    (e) => e.state === "open" && e.variant_signature === V1_POOL_VARIANT_SIGNATURE,
  ).length;
}

// ── IO ─────────────────────────────────────────────────────────────────

// Read pool.json. If it doesn't exist but the legacy eggs.json does
// (pre-2026-05-13 state on disk, no pool.json yet), migrate the legacy
// shape ({ eggs: [...] }) to { members: [...] } and write pool.json
// atomically, backing up the legacy file so a second run is idempotent.
export async function loadPool(): Promise<PoolFile> {
  if (!existsSync(POOL_PATH) && existsSync(LEGACY_EGGS_JSON_PATH)) {
    try {
      const migrated = parseLegacyEggs(await readFile(LEGACY_EGGS_JSON_PATH, "utf-8"));
      await mkdir(REGISTRY_DIR, { recursive: true });
      const tmp = POOL_PATH + ".tmp";
      await writeFile(tmp, JSON.stringify(migrated, null, 2));
      await rename(tmp, POOL_PATH);
      try { await rename(LEGACY_EGGS_JSON_PATH, LEGACY_EGGS_JSON_PATH + ".pre-pool-rename.bak"); } catch { /* best-effort */ }
      return migrated;
    } catch {
      // Migration failed; fall through to fresh-state on POOL_PATH miss.
    }
  }
  if (!existsSync(POOL_PATH)) return { version: 1, members: [] };
  try {
    return parsePoolFile(await readFile(POOL_PATH, "utf-8"));
  } catch (e) {
    // A missing file reads as empty; a malformed one surfaces.
    if ((e as any).code === "ENOENT") return { version: 1, members: [] };
    throw e;
  }
}

export async function savePool(file: PoolFile): Promise<void> {
  await mkdir(REGISTRY_DIR, { recursive: true });
  const tmp = POOL_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(file, null, 2));
  await rename(tmp, POOL_PATH);
}

// Cooperative file lock around pool.json read-modify-write. Uses an
// O_EXCL sentinel so two processes cannot both think they hold the lock.
// A caller waits up to 10s to acquire. A lock orphaned by a dead holder
// is force-cleared only once it is >30s old — so a caller that arrives
// within that window fails with a timeout rather than reclaiming it
// (the 10s acquire / 30s stale values are inherited from the original
// inline implementation; they don't compose into prompt dead-holder
// recovery for a single caller).
export async function withPoolLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(REGISTRY_DIR, { recursive: true });
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const acquired = await tryAcquireLock();
    if (acquired) {
      try {
        return await fn();
      } finally {
        try { await unlink(POOL_LOCK_PATH); } catch { /* ignore */ }
      }
    }
    // Stale-lock recovery: if the lock is older than 30s, force-clear it.
    try {
      const s = statSync(POOL_LOCK_PATH);
      if (Date.now() - s.mtimeMs > 30_000) {
        try { await unlink(POOL_LOCK_PATH); } catch { /* ignore */ }
      }
    } catch { /* lock vanished mid-check */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`could not acquire pool lock at ${POOL_LOCK_PATH} within 10s`);
}

async function tryAcquireLock(): Promise<boolean> {
  // Bun has no O_EXCL helper; use node:fs.openSync with the wx flag.
  try {
    const fs = await import("node:fs");
    const fd = fs.openSync(POOL_LOCK_PATH, "wx");
    fs.closeSync(fd);
    return true;
  } catch (e: any) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

export async function countOpenPoolMembers(): Promise<number> {
  return countOpen((await loadPool()).members);
}
