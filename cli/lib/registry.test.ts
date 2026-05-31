import { test, expect } from "bun:test";
import { parseRegistry, findCellIn, type Cell } from "./registry";

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
