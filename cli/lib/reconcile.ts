// Pool reconciliation — pure logic, no HTTP, no IO. Given the current
// pool snapshot and welld's wells list, decide what to evict and why.
//
// The HTTP wiring + lock + refill trigger lives in cells.ts (reconcilePool);
// this file is the testable kernel.
//
// Eviction rules:
//   1. **Missing in welld**: pool says we have a well; welld has no record.
//      The bundle is gone, hibernate.bin is gone — pool entry is a ghost.
//      (W.68 class: stale registry after manual cleanup, welld state-reset, etc.)
//   2. **Tier-4 hot member welld reports non-running**: we marked the member as
//      "hot/running" but welld says stopped (or other non-running state).
//      Tier-4 wells have no hibernate.bin, so /wake can't recover; /start
//      is unreliable post-welld-bounce. Evict and let refill bake fresh.
//      (Bobby class: today's stall.)

export type PoolMemberLike = {
  id: string;
  well_name: string;
  state: string;          // PoolMemberState — "open" | "claimed" | "live" | "culling"
  tier?: 2 | 4;           // optional in storage; v1 pool members carry it
  dna_rev?: string;       // runtime-DNA fingerprint baked into this egg (cli/lib/dna-rev.ts)
  born_at?: string;       // ISO; oldest-first ordering for the stale-rev cull
};

export type WelldRow = { name: string; status: string };

export type Eviction = {
  id: string;
  well_name: string;
  reason: string;
};

export function planReconcileEvictions<T extends PoolMemberLike>(
  pool: T[],
  welld: WelldRow[],
): { keep: T[]; evicted: Eviction[] } {
  const byName = new Map<string, { status: string }>();
  for (const w of welld) byName.set(w.name, { status: w.status });
  const keep: T[] = [];
  const evicted: Eviction[] = [];
  for (const m of pool) {
    const wd = byName.get(m.well_name);
    if (!wd) {
      evicted.push({ id: m.id, well_name: m.well_name, reason: "welld doesn't know this well" });
      continue;
    }
    if (m.tier === 4 && m.state === "open" && wd.status !== "running") {
      evicted.push({
        id: m.id,
        well_name: m.well_name,
        reason: `tier-4 hot member welld-status=${wd.status}`,
      });
      continue;
    }
    keep.push(m);
  }
  return { keep, evicted };
}

// Stale-rev cull selection (pure). Given the OPEN pool members and the
// repo's current runtime-DNA rev, pick which open eggs to retire because
// they carry old platform code. The IO (destroy + refill) lives in
// reconcilePool; this is the testable kernel.
//
// Policy, deliberately gentle:
//   - Only eggs with a NON-EMPTY dna_rev that differs from current are
//     stale. A missing/empty rev is a legacy egg baked before the field
//     existed — treated as UNKNOWN, never auto-culled. That avoids a
//     deploy-day mass-cull of the whole pool; legacy eggs age out as
//     births consume them and refill bakes current-rev replacements.
//   - Oldest first (born_at) — the same staleness proxy the over-target
//     cull uses.
//   - Never empty the pool: keep at least `floor` open members. Refill
//     backfills culled slots with current-rev eggs, so a big rev jump
//     rotates the pool over several reconcile passes instead of
//     blackholing births in one. `cap` bounds churn per pass.
export function selectStaleRevCull<T extends PoolMemberLike>(
  open: T[],
  currentRev: string,
  opts: { cap: number; floor: number },
): T[] {
  if (!currentRev) return []; // unknown current rev → never cull (can't compare)
  const stale = open
    .filter((m) => m.state === "open" && !!m.dna_rev && m.dna_rev !== currentRev)
    .sort((a, b) => Date.parse(a.born_at ?? "") - Date.parse(b.born_at ?? ""));
  const maxRemovable = Math.max(0, open.length - opts.floor);
  return stale.slice(0, Math.min(Math.max(0, opts.cap), maxRemovable));
}
