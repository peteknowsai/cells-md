// Unit tests for the pure fleet-shaping logic (no IO). loadFleet itself
// touches the registry/pool/welld and is covered by the live smoke test;
// here we pin the deterministic shaping: well-name resolution, model
// shortening, power/health mapping, grouping, and sort order.

import { expect, test, describe } from "bun:test";
import {
  type FleetCell,
  type Power,
  wellNameFor,
  shortModel,
  powerFromWell,
  healthFromWell,
  formatAge,
  sortCells,
  groupFleet,
  flattenRows,
  fleetCounts,
} from "./fleet";

// Compact factory for test fleet cells — override only what a case cares about.
function cell(name: string, over: Partial<FleetCell> = {}): FleetCell {
  return {
    name,
    project: "",
    harness: "pi",
    model: "gpt-5.5",
    special: false,
    pinned: false,
    power: "asleep" as Power,
    health: "ok",
    ip: null,
    ageMinutes: 0,
    wellName: name,
    createdAt: "2026-05-22T00:00:00.000Z",
    ...over,
  };
}

describe("wellNameFor", () => {
  test("special cell → cells-<name>", () => {
    expect(wellNameFor({ name: "mother", special: true }, [])).toBe("cells-mother");
  });
  test("pool-hatched cell → the pool member's well_name", () => {
    const members = [{ id: "c5e25a", well_name: "egg-c5e25a", variant_signature: "", state: "live", born_at: "", claimed_at: null, claimed_by: "delta-market", max_age_at: "" } as any];
    expect(wellNameFor({ name: "delta-market", hatched_from: "c5e25a" }, members)).toBe("egg-c5e25a");
  });
  test("hatched_from with no matching pool member → falls back to cell name", () => {
    expect(wellNameFor({ name: "ghost", hatched_from: "deadbe" }, [])).toBe("ghost");
  });
  test("legacy cell (no hatched_from, not special) → cell name", () => {
    expect(wellNameFor({ name: "bob" }, [])).toBe("bob");
  });
});

describe("shortModel", () => {
  test("provider/model:priority → model leaf", () => {
    expect(shortModel(["anthropic/claude-opus-4-7:high"])).toBe("claude-opus-4-7");
  });
  test("harness:provider/model:priority → model leaf", () => {
    expect(shortModel(["claude-code:anthropic/claude-opus-4-7:high"])).toBe("claude-opus-4-7");
  });
  test("openai-codex chain", () => {
    expect(shortModel(["openai-codex/gpt-5.5:medium"])).toBe("gpt-5.5");
  });
  test("bare token", () => {
    expect(shortModel(["opus"])).toBe("opus");
  });
  test("empty / undefined → ?", () => {
    expect(shortModel(undefined)).toBe("?");
    expect(shortModel([])).toBe("?");
  });
});

describe("powerFromWell / healthFromWell", () => {
  test("running → awake, stopped → asleep", () => {
    expect(powerFromWell({ name: "x", status: "running" })).toBe("awake");
    expect(powerFromWell({ name: "x", status: "stopped", runtime_state: "hibernating" })).toBe("asleep");
  });
  test("missing well → unknown", () => {
    expect(powerFromWell(undefined)).toBe("unknown");
  });
  test("wedge maps through, defaults ok", () => {
    expect(healthFromWell({ name: "x", wedge: "confirmed" })).toBe("confirmed");
    expect(healthFromWell({ name: "x", wedge: "suspected" })).toBe("suspected");
    expect(healthFromWell({ name: "x" })).toBe("ok");
    expect(healthFromWell(undefined)).toBe("ok");
  });
});

describe("formatAge", () => {
  test("buckets", () => {
    expect(formatAge(0)).toBe("now");
    expect(formatAge(5)).toBe("5m");
    expect(formatAge(59)).toBe("59m");
    expect(formatAge(60)).toBe("1h");
    expect(formatAge(150)).toBe("2h");
    expect(formatAge(60 * 24)).toBe("1d");
    expect(formatAge(60 * 24 * 11)).toBe("11d");
  });
});

describe("sortCells", () => {
  test("operators first, then awake before asleep, then alphabetical", () => {
    const out = sortCells([
      cell("zebra", { power: "awake" }),
      cell("apple", { power: "asleep" }),
      cell("mom", { special: true, pinned: true, power: "awake" }),
      cell("beta", { power: "awake" }),
    ]).map((c) => c.name);
    expect(out).toEqual(["mom", "beta", "zebra", "apple"]);
  });
});

describe("groupFleet", () => {
  const fleet = [
    cell("mother", { special: true, pinned: true, power: "awake" }),
    cell("delta-market", { project: "homezero", power: "awake" }),
    cell("delta-research", { project: "homezero", power: "asleep" }),
    cell("paonia-feed", { project: "paonia", power: "asleep" }),
    cell("bob", { project: "", power: "asleep" }),
  ];

  test("by project: operators first, projects alpha, unassigned last", () => {
    const groups = groupFleet(fleet, "project");
    expect(groups.map((g) => g.label)).toEqual(["operators", "homezero", "paonia", "unassigned"]);
    // operators group holds only the special cell
    expect(groups[0]!.cells.map((c) => c.name)).toEqual(["mother"]);
    // homezero awake-first
    expect(groups[1]!.cells.map((c) => c.name)).toEqual(["delta-market", "delta-research"]);
  });

  test("by state: operators float out; rest split awake/asleep", () => {
    const groups = groupFleet(fleet, "state");
    expect(groups.map((g) => g.label)).toEqual(["operators", "awake", "asleep"]);
    expect(groups.find((g) => g.label === "awake")!.cells.map((c) => c.name)).toEqual(["delta-market"]);
    expect(groups.find((g) => g.label === "asleep")!.cells.map((c) => c.name)).toEqual(["bob", "delta-research", "paonia-feed"]);
  });

  test("empty fleet → no groups", () => {
    expect(groupFleet([], "project")).toEqual([]);
  });
});

describe("flattenRows + fleetCounts", () => {
  test("flatten emits a header then its cells, in group order", () => {
    const groups = groupFleet([cell("mother", { special: true }), cell("a", { project: "p" })], "project");
    const rows = flattenRows(groups);
    expect(rows.map((r) => (r.kind === "header" ? `#${r.group.label}` : r.cell.name))).toEqual([
      "#operators",
      "mother",
      "#p",
      "a",
    ]);
  });

  test("counts: total/awake/asleep + distinct project count (operators excluded)", () => {
    const counts = fleetCounts([
      cell("mother", { special: true, pinned: true, power: "awake", project: "" }),
      cell("a", { project: "homezero", power: "awake" }),
      cell("b", { project: "homezero", power: "asleep" }),
      cell("c", { project: "paonia", power: "asleep" }),
    ]);
    expect(counts).toEqual({ total: 4, awake: 2, asleep: 2, projects: 2 });
  });
});
