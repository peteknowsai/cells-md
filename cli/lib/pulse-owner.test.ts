import { test, expect } from "bun:test";
import { pulseOwner, projectScheduledCells, type PulseOwnerCell } from "./pulse-owner";

// A registry fixture: a live project pulse for "zero", plus assorted cells.
const liveZeroPulse: PulseOwnerCell = { name: "zero-pulse", special: true, status: "alive", project: "zero" };
const warmingZeroPulse: PulseOwnerCell = { name: "zero-pulse", special: true, status: "warming", project: "zero" };
const strayZeroPulse: PulseOwnerCell = { name: "zero-pulse", status: "alive", project: "zero" }; // not special

// ── pulseOwner ─────────────────────────────────────────────────────────

test("a cell with no project is always owned by the global pulse", () => {
  expect(pulseOwner(undefined, [liveZeroPulse])).toBe("pulse");
  expect(pulseOwner(null, [liveZeroPulse])).toBe("pulse");
  expect(pulseOwner("", [liveZeroPulse])).toBe("pulse");
});

test("a project with a live project-pulse is owned by it", () => {
  expect(pulseOwner("zero", [liveZeroPulse])).toBe("zero-pulse");
});

test("falls back to global when the project-pulse is absent", () => {
  expect(pulseOwner("zero", [])).toBe("pulse");
  expect(pulseOwner("paonia", [liveZeroPulse])).toBe("pulse"); // different project
});

test("a warming project-pulse does NOT own yet — still global", () => {
  expect(pulseOwner("zero", [warmingZeroPulse])).toBe("pulse");
});

test("a non-special cell named <project>-pulse is NOT selected as owner", () => {
  // Defends against a stray pool cell that happens to be named like a pulse.
  expect(pulseOwner("zero", [strayZeroPulse])).toBe("pulse");
});

test("honours a CELLS_PULSE_CELL-style global override for the fallback", () => {
  expect(pulseOwner("zero", [], "pulse-2")).toBe("pulse-2");
  expect(pulseOwner(undefined, [liveZeroPulse], "pulse-2")).toBe("pulse-2");
  // ...but never overrides a real project owner:
  expect(pulseOwner("zero", [liveZeroPulse], "pulse-2")).toBe("zero-pulse");
});

// ── exactly-once partition invariant ───────────────────────────────────

test("every cell resolves to exactly one owner well (no double-watch, no gap)", () => {
  const fleet: PulseOwnerCell[] = [
    liveZeroPulse,
    { name: "zero-abstractor", project: "zero" },
    { name: "zero-clerk", project: "zero" },
    { name: "paonia-clerk", project: "paonia" }, // project with no live pulse
    { name: "advisor-pete" }, // no project
  ];
  const owners = fleet
    .filter((c) => c.name !== "zero-pulse") // the pulse itself isn't watched
    .map((c) => pulseOwner(c.project, fleet));
  expect(owners).toEqual(["zero-pulse", "zero-pulse", "pulse", "pulse"]);
  // each cell mapped to exactly one (non-empty) owner:
  expect(owners.every((o) => o === "zero-pulse" || o === "pulse")).toBe(true);
});

// ── projectScheduledCells (eviction set on birth = re-seed set on death) ─

test("projectScheduledCells: the project's cells, minus the pulse itself", () => {
  const fleet: PulseOwnerCell[] = [
    { name: "zero-pulse", special: true, status: "alive", project: "zero" },
    { name: "zero-abstractor", status: "alive", project: "zero" },
    { name: "zero-clerk", status: "alive", project: "zero" },
    { name: "paonia-clerk", status: "alive", project: "paonia" },
    { name: "advisor-pete", status: "alive" },
  ];
  expect(projectScheduledCells("zero", fleet).sort()).toEqual(["zero-abstractor", "zero-clerk"]);
});

test("projectScheduledCells: warming entries are excluded (mid-birth / leaked)", () => {
  const fleet: PulseOwnerCell[] = [
    { name: "zero-abstractor", status: "alive", project: "zero" },
    { name: "zero-halfborn", status: "warming", project: "zero" },
  ];
  expect(projectScheduledCells("zero", fleet)).toEqual(["zero-abstractor"]);
});

test("projectScheduledCells: empty when the project has no cells", () => {
  expect(projectScheduledCells("ghost", [{ name: "advisor-pete" }])).toEqual([]);
});
