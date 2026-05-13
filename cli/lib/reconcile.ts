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
  state: string;          // PoolMemberState — "warm" | "claimed" | "live" | "culling"
  tier?: 2 | 4;           // optional in storage; v1 pool members carry it
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
    if (m.tier === 4 && m.state === "warm" && wd.status !== "running") {
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
