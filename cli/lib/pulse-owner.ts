// Pulse ownership — the single source of truth for "which pulse watches this
// cell's HEARTBEAT.md schedule." Pure functions over already-loaded registry
// rows, so the same answer is computed identically on every consumer:
//
//   - cli/proxy.ts  bridgeInboxPulse  — routes each /heartbeat-changed push to
//                                        exactly one pulse well (the partition).
//   - cli/cells.ts  kill / retag / birth-handoff / steward-reconcile.
//
// The in-well pulse-core NEVER computes ownership: a pulse well has no copy of
// the registry (only mother gets it, via /bridge/registry/read at runtime), so
// pulse-core is a dumb drainer of whatever the Mac seeds into its inbox. Keeping
// the resolver pure + Mac-only is what makes the partition exactly-once: there
// is no second resolver to drift out of sync. See docs on per-project pulse.

import { projectPulseName } from "./cell-name";

// The structural slice of a registry Cell this module needs. Declared
// structurally (not imported from ./registry) so the resolver stays free of
// the registry module's fs imports and is trivially unit-testable.
export type PulseOwnerCell = {
  name: string;
  status?: "warming" | "alive";
  special?: boolean;
  project?: string;
};

// The default global-pulse cell name. Callers that honour the CELLS_PULSE_CELL
// override pass it in as `globalPulse`; the resolver itself stays pure (no env
// reads) so its output is a function of its arguments alone.
export const GLOBAL_PULSE = "pulse";

// Which pulse owns a cell with the given project tag. A project's own pulse
// wins iff it is registered, `special`, and past the warming gate (mirrors
// motherFor's alive-check exactly); otherwise ownership falls back to the
// global pulse. A cell with no project is always owned by the global pulse.
//
// This is THE partition function: every cell resolves to exactly one owner, so
// every heartbeat lands in exactly one pulse inbox — no double-watch, no gap.
export function pulseOwner(
  project: string | undefined | null,
  cells: PulseOwnerCell[],
  globalPulse: string = GLOBAL_PULSE,
): string {
  if (project) {
    const pp = projectPulseName(project);
    const c = cells.find((x) => x.name === pp);
    if (c && c.special && c.status !== "warming") return pp;
  }
  return globalPulse;
}

// The cells a project's pulse is responsible for — used as the eviction set
// when a project pulse is BORN (forget these from the global pulse) and the
// re-seed set when it DIES (push these back to the global pulse). Every cell
// tagged with the project, except the pulse cell itself and any warming
// (mid-birth / leaked) entry. Pure so the birth/death handoffs and a unit test
// agree on the exact set.
export function projectScheduledCells(
  project: string,
  cells: PulseOwnerCell[],
): string[] {
  const self = projectPulseName(project);
  return cells
    .filter((c) => c.project === project && c.name !== self && c.status !== "warming")
    .map((c) => c.name);
}
