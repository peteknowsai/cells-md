// Tests for the birth-time seal decision. Run with:
//   bun test cli/lib/hibernate-ready.test.ts

import { test, expect } from "bun:test";
import { needsSeal } from "./hibernate-ready";

test("already hibernate-ready → no seal", () => {
  expect(needsSeal(true)).toBe(false);
});

test("explicitly not hibernate-ready → seal", () => {
  expect(needsSeal(false)).toBe(true);
});

test("welld too old to report the field → seal (safe default)", () => {
  // The load-bearing case: a missing field must NOT be read as "ready".
  // Skipping a needed seal yields a cell that can never hibernate.
  expect(needsSeal(undefined)).toBe(true);
});
