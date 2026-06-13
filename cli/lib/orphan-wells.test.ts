import { test, expect } from "bun:test";
import { findOrphanWells } from "./orphan-wells";

test("flags a welld well that no cell and no pool member owns", () => {
  const orphans = findOrphanWells({
    welldWells: ["cells-mother", "egg-aaaaaa", "egg-103bb1"],
    knownWells: ["cells-mother"],
    poolWells: ["egg-aaaaaa"],
  });
  expect(orphans).toEqual(["egg-103bb1"]);
});

test("no orphans when every well is accounted for", () => {
  const orphans = findOrphanWells({
    welldWells: ["cells-mother", "cells-zero-pulse", "egg-bbbbbb"],
    knownWells: ["cells-mother", "cells-zero-pulse"],
    poolWells: ["egg-bbbbbb"],
  });
  expect(orphans).toEqual([]);
});

test("a claimed egg mid-birth (in poolWells) is NOT an orphan", () => {
  // wellNameForCell can't resolve a pool-born cell's well until promote, but the
  // claimed egg is still in pool.json — poolWells must absorb it so it isn't flagged.
  const orphans = findOrphanWells({
    welldWells: ["egg-claimed1"],
    knownWells: [], // cell not resolvable yet
    poolWells: ["egg-claimed1"], // but the claimed egg is in the pool
  });
  expect(orphans).toEqual([]);
});

test("generous known aliases suppress false positives (egg-<hatched_from>)", () => {
  // A pool-born alive cell whose claimed egg was dropped from pool.json: the
  // caller adds `egg-<hatched_from>` as a generous alias so it's not an orphan.
  const orphans = findOrphanWells({
    welldWells: ["egg-deadbe"],
    knownWells: ["advisor-pete", "cells-advisor-pete", "egg-deadbe"],
    poolWells: [],
  });
  expect(orphans).toEqual([]);
});

test("de-duplicates and preserves welld order; ignores empties", () => {
  const orphans = findOrphanWells({
    welldWells: ["egg-z", "egg-a", "egg-z", "", "egg-a"],
    knownWells: [""],
    poolWells: [],
  });
  expect(orphans).toEqual(["egg-z", "egg-a"]);
});

test("empty inputs → no orphans", () => {
  expect(findOrphanWells({ welldWells: [], knownWells: [], poolWells: [] })).toEqual([]);
});
