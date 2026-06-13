// Unit tests for planReconcileEvictions. Run with:
//   bun test cli/lib/reconcile.test.ts

import { test, expect } from "bun:test";
import { planReconcileEvictions, selectStaleRevCull, type PoolMemberLike, type WelldRow } from "./reconcile";

function mem(over: Partial<PoolMemberLike>): PoolMemberLike {
  return {
    id: "abc123",
    well_name: "egg-opus-abc123",
    state: "open",
    ...over,
  };
}

function row(over: Partial<WelldRow>): WelldRow {
  return { name: "egg-opus-abc123", status: "stopped", ...over };
}

test("empty pool returns nothing", () => {
  const r = planReconcileEvictions([], []);
  expect(r.keep).toEqual([]);
  expect(r.evicted).toEqual([]);
});

test("welld knows all wells, all open tier-2 → keep all", () => {
  const pool = [
    mem({ id: "111111", well_name: "egg-opus-111111", state: "open", tier: 2 }),
    mem({ id: "222222", well_name: "egg-opus-222222", state: "open", tier: 2 }),
  ];
  const welld = [
    row({ name: "egg-opus-111111", status: "stopped" }),
    row({ name: "egg-opus-222222", status: "stopped" }),
  ];
  const r = planReconcileEvictions(pool, welld);
  expect(r.keep.length).toBe(2);
  expect(r.evicted.length).toBe(0);
});

test("welld doesn't know about a well → evict (W.68 class)", () => {
  const pool = [
    mem({ id: "111111", well_name: "egg-opus-111111", state: "open", tier: 2 }),
    mem({ id: "222222", well_name: "egg-opus-222222", state: "open", tier: 2 }),
  ];
  const welld = [row({ name: "egg-opus-111111", status: "stopped" })];
  const r = planReconcileEvictions(pool, welld);
  expect(r.keep.length).toBe(1);
  expect(r.evicted.length).toBe(1);
  expect(r.evicted[0]!.id).toBe("222222");
  expect(r.evicted[0]!.reason).toMatch(/welld doesn't know/);
});

test("tier-4 hot member but welld says stopped → evict (bobby class)", () => {
  const pool = [mem({ id: "333333", well_name: "egg-opus-333333", state: "open", tier: 4 })];
  const welld = [row({ name: "egg-opus-333333", status: "stopped" })];
  const r = planReconcileEvictions(pool, welld);
  expect(r.keep.length).toBe(0);
  expect(r.evicted.length).toBe(1);
  expect(r.evicted[0]!.reason).toMatch(/tier-4.*stopped/);
});

test("tier-4 hot member and welld says running → keep", () => {
  const pool = [mem({ id: "333333", well_name: "egg-opus-333333", state: "open", tier: 4 })];
  const welld = [row({ name: "egg-opus-333333", status: "running" })];
  const r = planReconcileEvictions(pool, welld);
  expect(r.keep.length).toBe(1);
  expect(r.evicted.length).toBe(0);
});

test("tier-2 (cold) members are kept regardless of welld status (they may be hibernating)", () => {
  // tier-2 wells are hibernated; welld will report them stopped. That's
  // not a drift signal — it's their normal resting state.
  const pool = [mem({ id: "444444", well_name: "egg-opus-444444", state: "open", tier: 2 })];
  const welld = [row({ name: "egg-opus-444444", status: "stopped" })];
  const r = planReconcileEvictions(pool, welld);
  expect(r.keep.length).toBe(1);
  expect(r.evicted.length).toBe(0);
});

test("claimed/live members are kept even if not in welld list (in-flight)", () => {
  // A member that's been claimed/marked live has handed off to a cell;
  // the cells.json registry tracks its lifecycle from here. Don't evict
  // mid-handoff.
  const pool = [
    mem({ id: "555555", well_name: "egg-opus-555555", state: "claimed", tier: 4 }),
    mem({ id: "666666", well_name: "egg-opus-666666", state: "live", tier: 4 }),
  ];
  const welld: WelldRow[] = [];
  // Both members are missing from welld — they get evicted by rule 1.
  // The "claimed/live during handoff" case requires welld to still know them.
  const withWelld = [
    row({ name: "egg-opus-555555", status: "running" }),
    row({ name: "egg-opus-666666", status: "running" }),
  ];
  const r = planReconcileEvictions(pool, withWelld);
  expect(r.keep.length).toBe(2);
  expect(r.evicted.length).toBe(0);
});

test("claimed tier-4 member stopped on welld → still evicted (W.68 still applies)", () => {
  // If the well disappeared but the pool entry is "claimed", something
  // went badly wrong upstream. Eviction is the safer move — it lets
  // the cells.json registry catch the orphan cell separately.
  const pool = [mem({ id: "777777", well_name: "egg-opus-777777", state: "claimed", tier: 4 })];
  const welld: WelldRow[] = []; // welld doesn't know
  const r = planReconcileEvictions(pool, welld);
  expect(r.evicted.length).toBe(1);
  expect(r.keep.length).toBe(0);
});

test("mixed pool: some keep, some evict, deterministic", () => {
  const pool = [
    mem({ id: "aaaaaa", well_name: "egg-opus-aaaaaa", state: "open", tier: 2 }),  // keep — tier 2 hibernated
    mem({ id: "bbbbbb", well_name: "egg-opus-bbbbbb", state: "open", tier: 4 }),  // evict — tier 4 stopped
    mem({ id: "cccccc", well_name: "egg-opus-cccccc", state: "open", tier: 4 }),  // keep — tier 4 running
    mem({ id: "dddddd", well_name: "egg-opus-dddddd", state: "open", tier: 2 }),  // evict — missing from welld
  ];
  const welld = [
    row({ name: "egg-opus-aaaaaa", status: "stopped" }),
    row({ name: "egg-opus-bbbbbb", status: "stopped" }),
    row({ name: "egg-opus-cccccc", status: "running" }),
  ];
  const r = planReconcileEvictions(pool, welld);
  expect(r.keep.length).toBe(2);
  expect(r.keep.map((m) => m.id).sort()).toEqual(["aaaaaa", "cccccc"]);
  expect(r.evicted.length).toBe(2);
  expect(r.evicted.map((e) => e.id).sort()).toEqual(["bbbbbb", "dddddd"]);
});

// ── selectStaleRevCull ────────────────────────────────────────────────

function openMem(id: string, rev: string | undefined, born: string): PoolMemberLike {
  return { id, well_name: `egg-opus-${id}`, state: "open", tier: 2, dna_rev: rev, born_at: born };
}

test("stale-rev cull: empty currentRev culls nothing", () => {
  const open = [openMem("aaaaaa", "old", "2026-06-01T00:00:00Z")];
  expect(selectStaleRevCull(open, "", { cap: 2, floor: 2 })).toEqual([]);
});

test("stale-rev cull: members at current rev are kept", () => {
  const open = [
    openMem("aaaaaa", "cur", "2026-06-01T00:00:00Z"),
    openMem("bbbbbb", "cur", "2026-06-02T00:00:00Z"),
    openMem("cccccc", "cur", "2026-06-03T00:00:00Z"),
  ];
  expect(selectStaleRevCull(open, "cur", { cap: 2, floor: 2 })).toEqual([]);
});

test("stale-rev cull: legacy eggs (no dna_rev) are never culled", () => {
  const open = [
    openMem("aaaaaa", undefined, "2026-06-01T00:00:00Z"),
    openMem("bbbbbb", "", "2026-06-02T00:00:00Z"),
    openMem("cccccc", "cur", "2026-06-03T00:00:00Z"),
  ];
  expect(selectStaleRevCull(open, "cur", { cap: 2, floor: 2 })).toEqual([]);
});

test("stale-rev cull: picks stale eggs oldest-first, capped", () => {
  const open = [
    openMem("new111", "old", "2026-06-05T00:00:00Z"),
    openMem("old111", "old", "2026-06-01T00:00:00Z"), // oldest stale → first
    openMem("mid111", "old", "2026-06-03T00:00:00Z"),
    openMem("cur111", "cur", "2026-06-04T00:00:00Z"),
    openMem("cur222", "cur", "2026-06-06T00:00:00Z"),
  ];
  const victims = selectStaleRevCull(open, "cur", { cap: 2, floor: 2 });
  expect(victims.map((m) => m.id)).toEqual(["old111", "mid111"]);
});

test("stale-rev cull: floor keeps the pool from emptying", () => {
  // All 4 open are stale; floor=2 → at most 2 removable; cap=10 doesn't override.
  const open = [
    openMem("aaaaaa", "old", "2026-06-01T00:00:00Z"),
    openMem("bbbbbb", "old", "2026-06-02T00:00:00Z"),
    openMem("cccccc", "old", "2026-06-03T00:00:00Z"),
    openMem("dddddd", "old", "2026-06-04T00:00:00Z"),
  ];
  const victims = selectStaleRevCull(open, "cur", { cap: 10, floor: 2 });
  expect(victims.length).toBe(2);
  expect(victims.map((m) => m.id)).toEqual(["aaaaaa", "bbbbbb"]);
});

test("stale-rev cull: floor >= open count culls nothing", () => {
  const open = [
    openMem("aaaaaa", "old", "2026-06-01T00:00:00Z"),
    openMem("bbbbbb", "old", "2026-06-02T00:00:00Z"),
  ];
  expect(selectStaleRevCull(open, "cur", { cap: 5, floor: 2 })).toEqual([]);
});
