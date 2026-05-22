// The seal decision for birth's hibernate-ready guard (hibernation model,
// invariant 4 — docs/proposals/hibernation-model.html). Kept pure and apart
// from the welld I/O in cells.ts so the decision can be tested in isolation.

/**
 * Given welld's reported `hibernate_ready` for a freshly-claimed well, decide
 * whether birth must seal it before registering the cell.
 *
 *   true       already sealed — no-op.
 *   false      rotted in the pool, or a path that never sealed — seal it.
 *   undefined  welld is too old to report the field at all — seal anyway.
 *
 * The fallback for `undefined` is deliberate: skipping a seal we needed
 * produces a live cell that can never hibernate (the bug invariant 4 exists
 * to kill), whereas sealing one that was already sealed costs only a halt +
 * restart. When unsure, seal — it's the strictly safe direction.
 */
export function needsSeal(hibernateReady: boolean | undefined): boolean {
  return hibernateReady !== true;
}
