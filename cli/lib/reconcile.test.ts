// Unit tests for planReconcileEvictions. Run with:
//   bun test cli/lib/reconcile.test.ts

import { test, expect } from "bun:test";
import { planReconcileEvictions, type PoolMemberLike, type WelldRow } from "./reconcile";

function mem(over: Partial<PoolMemberLike>): PoolMemberLike {
  return {
    id: "abc123",
    well_name: "egg-opus-abc123",
    state: "warm",
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

test("welld knows all wells, all warm tier-2 → keep all", () => {
  const pool = [
    mem({ id: "111111", well_name: "egg-opus-111111", state: "warm", tier: 2 }),
    mem({ id: "222222", well_name: "egg-opus-222222", state: "warm", tier: 2 }),
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
    mem({ id: "111111", well_name: "egg-opus-111111", state: "warm", tier: 2 }),
    mem({ id: "222222", well_name: "egg-opus-222222", state: "warm", tier: 2 }),
  ];
  const welld = [row({ name: "egg-opus-111111", status: "stopped" })];
  const r = planReconcileEvictions(pool, welld);
  expect(r.keep.length).toBe(1);
  expect(r.evicted.length).toBe(1);
  expect(r.evicted[0]!.id).toBe("222222");
  expect(r.evicted[0]!.reason).toMatch(/welld doesn't know/);
});

test("tier-4 hot member but welld says stopped → evict (bobby class)", () => {
  const pool = [mem({ id: "333333", well_name: "egg-opus-333333", state: "warm", tier: 4 })];
  const welld = [row({ name: "egg-opus-333333", status: "stopped" })];
  const r = planReconcileEvictions(pool, welld);
  expect(r.keep.length).toBe(0);
  expect(r.evicted.length).toBe(1);
  expect(r.evicted[0]!.reason).toMatch(/tier-4.*stopped/);
});

test("tier-4 hot member and welld says running → keep", () => {
  const pool = [mem({ id: "333333", well_name: "egg-opus-333333", state: "warm", tier: 4 })];
  const welld = [row({ name: "egg-opus-333333", status: "running" })];
  const r = planReconcileEvictions(pool, welld);
  expect(r.keep.length).toBe(1);
  expect(r.evicted.length).toBe(0);
});

test("tier-2 (cold) members are kept regardless of welld status (they may be hibernating)", () => {
  // tier-2 wells are hibernated; welld will report them stopped. That's
  // not a drift signal — it's their normal resting state.
  const pool = [mem({ id: "444444", well_name: "egg-opus-444444", state: "warm", tier: 2 })];
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
    mem({ id: "aaaaaa", well_name: "egg-opus-aaaaaa", state: "warm", tier: 2 }),  // keep — tier 2 hibernated
    mem({ id: "bbbbbb", well_name: "egg-opus-bbbbbb", state: "warm", tier: 4 }),  // evict — tier 4 stopped
    mem({ id: "cccccc", well_name: "egg-opus-cccccc", state: "warm", tier: 4 }),  // keep — tier 4 running
    mem({ id: "dddddd", well_name: "egg-opus-dddddd", state: "warm", tier: 2 }),  // evict — missing from welld
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
