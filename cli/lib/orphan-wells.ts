// orphan-wells — detect wells welld knows about that nothing in cells owns.
//
// The failure this catches: a half-finished birth, classically `bake-egg.sh`
// run standalone instead of through `cells birth` (the wrapper that owns the
// warming-register → promote dance). The egg gets imprinted + consumed from the
// pool, a configured well is left running, and the agent reports "born" — but
// nothing ever wrote it into cells.json. The well "looks born" yet is absent
// from `cells list`, an orphan holding RAM/disk that no command will ever reap.
//
// Detection is a set difference: welld's wells minus (every registered cell's
// well ∪ every pool member's well). It is deliberately ADVISORY — the known set
// is built GENEROUSLY by the caller (every naming convention a real cell's well
// could carry) so a live cell is never mistaken for an orphan. We would rather
// miss a true orphan than tell `doctor` a working cell is junk. Nothing
// auto-acts on this; a human reads the warning and decides.

export type OrphanInputs = {
  // Well names welld reports (GET /v1/wells).
  welldWells: string[];
  // Resolved well names for every registered cell, PLUS generous aliases —
  // wellNameForCell(name), `cells-<name>`, the bare name, and the stored `well`
  // (which for legacy cells is their real, pre-cold-boot well name).
  // Over-including here only suppresses orphan reports; it never causes a false one.
  knownWells: string[];
  // Deprecated — always [] now (the egg pool was removed). A well backing a
  // live cell is covered by knownWells.
  poolWells: string[];
};

// Returns the welld well names that match no known cell well and no pool member,
// de-duplicated and in welld's order. Empty input → empty result.
export function findOrphanWells(input: OrphanInputs): string[] {
  const known = new Set<string>();
  for (const w of input.knownWells) if (w) known.add(w);
  for (const w of input.poolWells) if (w) known.add(w);
  const seen = new Set<string>();
  const orphans: string[] = [];
  for (const w of input.welldWells) {
    if (!w || known.has(w) || seen.has(w)) continue;
    seen.add(w);
    orphans.push(w);
  }
  return orphans;
}
