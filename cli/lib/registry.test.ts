import { test, expect } from "bun:test";
import {
  parseRegistry,
  findCellIn,
  upsertBirthingCell,
  promoteCell,
  removeCell,
  isNameTaken,
  isStaleWarming,
  cullStaleWarming,
  STALE_WARMING_MS,
  shouldReclaimLock,
  LOCK_STALE_HOLDER_MS,
  type Cell,
} from "./registry";

function cell(over: Partial<Cell>): Cell {
  return { name: "alice", created_at: "2026-05-30T00:00:00Z", ...over };
}

// ── parseRegistry ──────────────────────────────────────────────────────

test("parseRegistry accepts a well-formed registry", () => {
  const raw = JSON.stringify({ cells: [cell({ name: "alice" }), cell({ name: "bob" })] });
  const r = parseRegistry(raw);
  expect(r.cells.length).toBe(2);
  expect(r.cells.map((c) => c.name)).toEqual(["alice", "bob"]);
});

test("parseRegistry accepts an empty cell list", () => {
  expect(parseRegistry(JSON.stringify({ cells: [] })).cells).toEqual([]);
});

test("parseRegistry throws when cells is missing", () => {
  // A registry doc with no cells array is corrupt — surfacing it beats
  // silently reading the whole fleet as gone.
  expect(() => parseRegistry(JSON.stringify({}))).toThrow(/malformed/);
});

test("parseRegistry throws when cells is not an array", () => {
  expect(() => parseRegistry(JSON.stringify({ cells: "nope" }))).toThrow(/malformed/);
});

test("parseRegistry throws on invalid JSON", () => {
  expect(() => parseRegistry("{not json")).toThrow();
});

test("parseRegistry throws on a null document", () => {
  expect(() => parseRegistry("null")).toThrow(/malformed/);
});

// ── findCellIn ─────────────────────────────────────────────────────────

test("findCellIn returns the matching cell", () => {
  const cells = [cell({ name: "alice" }), cell({ name: "bob" })];
  expect(findCellIn(cells, "bob")?.name).toBe("bob");
});

test("findCellIn returns undefined when no cell matches", () => {
  expect(findCellIn([cell({ name: "alice" })], "ghost")).toBeUndefined();
});

test("findCellIn returns undefined for an empty registry", () => {
  expect(findCellIn([], "alice")).toBeUndefined();
});

// ── birth-lifecycle mutations ──────────────────────────────────────────
// Two-phase birth: upsertBirthingCell (warming, before the end-test) →
// promoteCell (alive, on success) | removeCell (rollback, on failure).

test("upsertBirthingCell appends a warming entry carrying the harness", () => {
  const out = upsertBirthingCell([cell({ name: "alice", status: "alive" })], {
    name: "bob",
    created_at: "2026-06-13T00:00:00Z",
    harness: "claude-code",
    modelChain: ["claude-code:anthropic/claude-opus-4-8:high"],
  });
  expect(out.map((c) => c.name)).toEqual(["alice", "bob"]);
  expect(findCellIn(out, "bob")?.status).toBe("warming");
  expect(findCellIn(out, "bob")?.harness).toBe("claude-code");
});

test("upsertBirthingCell replaces a leaked warming entry of the same name (no duplicate)", () => {
  const cells = [cell({ name: "bob", status: "warming", hatched_from: "old" })];
  const out = upsertBirthingCell(cells, { name: "bob", created_at: "x", harness: "pi", hatched_from: "new" });
  expect(out.filter((c) => c.name === "bob").length).toBe(1);
  expect(findCellIn(out, "bob")?.hatched_from).toBe("new");
});

test("upsertBirthingCell does not mutate the input array", () => {
  const cells = [cell({ name: "alice" })];
  upsertBirthingCell(cells, { name: "bob", created_at: "x" });
  expect(cells.map((c) => c.name)).toEqual(["alice"]);
});

test("promoteCell flips warming → alive and patches fields the retry loop changed", () => {
  const out = promoteCell([cell({ name: "bob", status: "warming", hatched_from: "egg1" })], "bob", {
    hatched_from: "egg2",
  });
  expect(findCellIn(out, "bob")?.status).toBe("alive");
  expect(findCellIn(out, "bob")?.hatched_from).toBe("egg2");
});

test("promoteCell is a no-op when the name is absent", () => {
  const cells = [cell({ name: "alice", status: "alive" })];
  expect(promoteCell(cells, "ghost")).toEqual(cells);
});

test("removeCell drops the named cell (birth rollback)", () => {
  const cells = [cell({ name: "alice" }), cell({ name: "bob", status: "warming" })];
  expect(removeCell(cells, "bob").map((c) => c.name)).toEqual(["alice"]);
});

test("isNameTaken: an alive cell reserves the name", () => {
  expect(isNameTaken([cell({ name: "alice", status: "alive" })], "alice")).toBe(true);
});

test("isNameTaken: a warming entry does NOT reserve the name (leaked/in-flight birth)", () => {
  expect(isNameTaken([cell({ name: "bob", status: "warming" })], "bob")).toBe(false);
});

test("isNameTaken: a legacy entry with no status is a real cell → taken", () => {
  expect(isNameTaken([cell({ name: "alice" })], "alice")).toBe(true);
});

test("isNameTaken: absent name is free", () => {
  expect(isNameTaken([cell({ name: "alice" })], "ghost")).toBe(false);
});

// ── stale-warming cull ─────────────────────────────────────────────────
// A "warming" entry only outlives its birth on a hard crash between
// pre-register and promote/rollback; the cull reaps orphans older than any
// plausible birth so they never accumulate.

const NOW = new Date("2026-06-13T12:00:00Z").getTime();
const FRESH = new Date(NOW - 30_000).toISOString(); // 30s old
const OLD = new Date(NOW - STALE_WARMING_MS - 60_000).toISOString(); // past threshold

test("isStaleWarming: a fresh warming entry (in-flight birth) is NOT stale", () => {
  expect(isStaleWarming(cell({ status: "warming", created_at: FRESH }), NOW)).toBe(false);
});

test("isStaleWarming: a warming entry older than the threshold is stale", () => {
  expect(isStaleWarming(cell({ status: "warming", created_at: OLD }), NOW)).toBe(true);
});

test("isStaleWarming: an alive cell is never stale, however old", () => {
  expect(isStaleWarming(cell({ status: "alive", created_at: OLD }), NOW)).toBe(false);
});

test("isStaleWarming: a legacy entry with no status is never stale", () => {
  expect(isStaleWarming(cell({ created_at: OLD }), NOW)).toBe(false);
});

test("isStaleWarming: a warming entry with an unparseable timestamp is reaped", () => {
  expect(isStaleWarming(cell({ status: "warming", created_at: "not-a-date" }), NOW)).toBe(true);
});

test("isStaleWarming: honors a custom maxAgeMs", () => {
  const oneMinOld = new Date(NOW - 60_000).toISOString();
  expect(isStaleWarming(cell({ status: "warming", created_at: oneMinOld }), NOW, 30_000)).toBe(true);
  expect(isStaleWarming(cell({ status: "warming", created_at: oneMinOld }), NOW, 120_000)).toBe(false);
});

test("cullStaleWarming drops only stale warming entries, keeping alive + in-flight", () => {
  const cells = [
    cell({ name: "alive-old", status: "alive", created_at: OLD }),
    cell({ name: "warming-fresh", status: "warming", created_at: FRESH }),
    cell({ name: "warming-orphan", status: "warming", created_at: OLD }),
    cell({ name: "legacy", created_at: OLD }),
  ];
  const out = cullStaleWarming(cells, NOW);
  expect(out.map((c) => c.name)).toEqual(["alive-old", "warming-fresh", "legacy"]);
});

test("cullStaleWarming does not mutate the input array", () => {
  const cells = [cell({ name: "warming-orphan", status: "warming", created_at: OLD })];
  cullStaleWarming(cells, NOW);
  expect(cells.length).toBe(1);
});

test("cullStaleWarming on an all-alive registry is a no-op", () => {
  const cells = [cell({ name: "a", status: "alive" }), cell({ name: "b", status: "alive" })];
  expect(cullStaleWarming(cells, NOW)).toEqual(cells);
});

// ── shouldReclaimLock (registry-lock reclaim policy) ───────────────────
// The load-bearing decision: when may a contended ~/.cells/.registry.lock be
// force-cleared? A dead holder → instantly (the fix for the strand findings);
// a malformed file → after a 1s floor; a live holder → only if wedged >30s.

const held = (over: Partial<{ pid: number; startedAt: string }> = {}) => ({
  pid: 999,
  startedAt: new Date(NOW - 1_000).toISOString(),
  ...over,
});

test("shouldReclaimLock: a dead holder is reclaimed immediately", () => {
  expect(shouldReclaimLock(held(), "dead", NOW, 0)).toBe(true);
});

test("shouldReclaimLock: a live holder is NOT reclaimed while fresh", () => {
  expect(shouldReclaimLock(held({ startedAt: new Date(NOW - 5_000).toISOString() }), "alive", NOW, 0)).toBe(false);
});

test("shouldReclaimLock: a live but wedged (>30s) holder is force-cleared", () => {
  const wedged = held({ startedAt: new Date(NOW - LOCK_STALE_HOLDER_MS - 1_000).toISOString() });
  expect(shouldReclaimLock(wedged, "alive", NOW, 0)).toBe(true);
});

test("shouldReclaimLock: unknown liveness (EPERM/no probe) waits, never reclaims a present holder", () => {
  const old = held({ startedAt: new Date(NOW - 60_000).toISOString() });
  expect(shouldReclaimLock(old, "unknown", NOW, 0)).toBe(false);
});

test("shouldReclaimLock: a malformed/empty lock file is reclaimed only past the 1s floor", () => {
  expect(shouldReclaimLock(null, "unknown", NOW, 500)).toBe(false); // brand-new, mid-creation
  expect(shouldReclaimLock(null, "unknown", NOW, 2_000)).toBe(true);
});

test("shouldReclaimLock: a live holder with an unparseable startedAt is left alone", () => {
  expect(shouldReclaimLock(held({ startedAt: "not-a-date" }), "alive", NOW, 0)).toBe(false);
});
