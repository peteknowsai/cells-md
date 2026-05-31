import { test, expect } from "bun:test";
import { formatBorn, cellRows } from "./status-rows";

// ── formatBorn ─────────────────────────────────────────────────────────

test("formatBorn renders an ISO timestamp as 'YYYY-MM-DD HH:MM'", () => {
  expect(formatBorn("2026-04-30T05:29:45.393Z")).toBe("2026-04-30 05:29");
});

test("formatBorn returns '?' for undefined / empty / non-string input", () => {
  expect(formatBorn(undefined)).toBe("?");
  expect(formatBorn("")).toBe("?");
  // A non-string created_at must not throw on .slice — regression guard.
  expect(formatBorn(123 as unknown)).toBe("?");
  expect(formatBorn({} as unknown)).toBe("?");
  expect(formatBorn(null as unknown)).toBe("?");
});

// ── cellRows (the status-page tolerance) ───────────────────────────────

test("cellRows projects well-formed cells to {name, born}", () => {
  const rows = cellRows([
    { name: "alpha", created_at: "2026-04-30T05:29:45.393Z" },
    { name: "beta", created_at: "2026-05-01T12:00:00.000Z" },
  ]);
  expect(rows).toEqual([
    { name: "alpha", born: "2026-04-30 05:29" },
    { name: "beta", born: "2026-05-01 12:00" },
  ]);
});

test("cellRows drops malformed entries instead of throwing (Codex P3 pin)", () => {
  // A null cell, a missing name, and a non-string created_at must not 500
  // the status page — each bad entry drops its row, the good ones render.
  const rows = cellRows([
    null,
    { name: "good", created_at: "2026-04-30T05:29:45.393Z" },
    { name: "badts", created_at: 123 },     // non-string ts → born "?"
    { created_at: "2026-04-30T05:29:45.393Z" }, // no name → dropped
    "nope",                                  // not an object → dropped
  ]);
  expect(rows).toEqual([
    { name: "good", born: "2026-04-30 05:29" },
    { name: "badts", born: "?" },
  ]);
});

test("cellRows returns [] for a missing born timestamp", () => {
  expect(cellRows([{ name: "noborn" }])).toEqual([{ name: "noborn", born: "?" }]);
});

test("cellRows returns [] for a non-array argument", () => {
  expect(cellRows(undefined)).toEqual([]);
  expect(cellRows(null)).toEqual([]);
  expect(cellRows({ cells: [] })).toEqual([]);
});
