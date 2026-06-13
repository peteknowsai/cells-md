import { test, expect } from "bun:test";
import {
  parseRegistry,
  findCellIn,
  upsertBirthingCell,
  promoteCell,
  removeCell,
  isNameTaken,
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
