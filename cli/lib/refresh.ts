// `cells refresh` — update a LIVING cell's infrastructure from current DNA.
//
// Until 2026-06-11, DNA improvements only reached newborn cells; live cells
// ran whatever they were born with, forever. That gap caused three real
// incidents in one week (bob's stale supervisor, mother's pre-substitution
// settings, advisor-pete's missing lib module). Refresh closes it.
//
// The hard part is the boundary between what the platform owns and what
// the cell owns. Refresh divides every path into three classes:
//
//   sync       — platform infrastructure. Created or updated freely, never
//                deleted: site/server.ts, lib/, bin/, scripts/, site/package.json.
//   if-present — capability config. The CELL's enabled set decides; refresh
//                updates a dir only when the cell already has it, and never
//                adds or removes one: .pi/extensions/<n>, .pi/skills/<n>,
//                .claude/skills/<n>, .pi/prompts. (This rule also makes
//                specials safe automatically: mother's stripped well-tools
//                isn't on her well, so it never comes back via refresh.)
//   never      — cell-owned identity and state. Refresh must not touch:
//                anatomy MDs (SOUL, IDENTITY, MEMORY, HEARTBEAT, …),
//                settings.json (both harness trees), package.json,
//                site/public/, state/, sessions, .tmux.conf.
//
// Pure logic (path classification, overlay resolution, plan building) lives
// here with tests; cmdRefresh in cells.ts does the IO (tar pipe, backup,
// restart, health check, rollback). Mirrors the registry.ts split.

// Platform-owned roots, relative to the agent root. Files under these are
// pushed unconditionally (create + update; deletion is never automatic).
export const SYNC_ROOTS = ["site/server.ts", "site/package.json", "lib/", "bin/", "scripts/"] as const;

// Capability roots — each immediate child dir is a unit the cell opted
// into (or had stripped). Update-if-present, keyed on the child name.
export const IF_PRESENT_ROOTS = [".pi/extensions/", ".pi/skills/", ".claude/skills/", ".pi/prompts/"] as const;

// Cell-owned paths refresh must never write, even if a DNA file exists at
// the same relative path. Checked as exact match or directory prefix.
export const NEVER_PATHS = [
  "SOUL.md",
  "IDENTITY.md",
  "MEMORY.md",
  "HEARTBEAT.md",
  "CONTACTS.md",
  "TOOLS.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CELLS.md",
  "package.json",
  ".tmux.conf",
  ".pi/settings.json",
  ".claude/settings.json",
  "site/public/",
  "state/",
  ".pi/agent/",
] as const;

export type RefreshClass = "sync" | "if-present" | "never" | "outside";

// Classify one DNA-relative path. "outside" = not part of the refresh
// surface at all (e.g. docs/, random top-level files) — skipped silently.
export function classifyPath(rel: string): { cls: RefreshClass; unit?: string } {
  for (const n of NEVER_PATHS) {
    if (rel === n || (n.endsWith("/") && rel.startsWith(n))) return { cls: "never" };
  }
  for (const s of SYNC_ROOTS) {
    if (rel === s || (s.endsWith("/") && rel.startsWith(s))) return { cls: "sync" };
  }
  for (const r of IF_PRESENT_ROOTS) {
    if (rel.startsWith(r)) {
      const rest = rel.slice(r.length);
      // .pi/prompts is flat files; extensions/skills are unit dirs.
      const unit = r === ".pi/prompts/" ? ".pi/prompts" : r + rest.split("/")[0];
      return { cls: "if-present", unit };
    }
  }
  return { cls: "outside" };
}

// Overlay resolution: base DNA provides the floor, the special's dir wins
// for any path it also defines (same order birth-special pushes them).
// Input maps are rel-path → absolute source path.
export function overlay(
  base: Map<string, string>,
  special: Map<string, string> | null,
): Map<string, string> {
  if (!special) return new Map(base);
  const out = new Map(base);
  for (const [rel, abs] of special) out.set(rel, abs);
  return out;
}

export type RefreshPlan = {
  // rel path → absolute source file to push
  push: Map<string, string>;
  // if-present units skipped because the cell doesn't carry them
  skippedUnits: string[];
  // never-class paths that existed in DNA (informational — proves the
  // boundary held)
  protected: string[];
};

// Build the plan: every classified source file, filtered by what the cell
// actually carries. `presentUnits` is the set of if-present unit keys the
// caller discovered on the well (e.g. ".pi/extensions/memory",
// ".claude/skills/birth", ".pi/prompts").
export function buildPlan(sources: Map<string, string>, presentUnits: Set<string>): RefreshPlan {
  const push = new Map<string, string>();
  const skipped = new Set<string>();
  const protectedPaths: string[] = [];
  for (const [rel, abs] of sources) {
    // Test artifacts never ship to cells.
    if (rel.endsWith(".test.ts")) continue;
    const { cls, unit } = classifyPath(rel);
    if (cls === "sync") {
      push.set(rel, abs);
    } else if (cls === "if-present") {
      if (unit && presentUnits.has(unit)) push.set(rel, abs);
      else if (unit) skipped.add(unit);
    } else if (cls === "never") {
      protectedPaths.push(rel);
    }
    // "outside" → silent skip
  }
  return { push, skippedUnits: [...skipped].sort(), protected: protectedPaths.sort() };
}
