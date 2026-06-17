// DNA revision — a content fingerprint over the runtime DNA every cell
// carries, so "is this cell running current platform code?" becomes a
// comparable fact instead of an invisible one.
//
// The problem it closes: DNA is COPIED into the cell-base image (at bake) and
// cells (at birth/refresh), never referenced at runtime. A code-only DNA change
// (server.ts, lib/, bin/) therefore reaches no existing cell until something
// re-bakes or refreshes it — silently. Three incidents in one week came from
// exactly this (bob's stale supervisor, advisor-pete's missing lib module, a
// pre-merge cell shipping a stale jobs lane). The rev is stamped at every
// bake/refresh site and read by `cells doctor`; the steward consumes it to
// self-heal.
//
// DOMAIN — the `sync` class from cli/lib/refresh.ts ONLY:
//   site/server.ts, site/package.json, lib/, bin/, scripts/
// i.e. exactly the universal platform surface `cells refresh` pushes to
// EVERY cell unconditionally. Deliberately excluded:
//   - markdown (*.md): prose/docs must NOT churn the rev — the whole point
//     is content-addressing to behavior, not text. A comment edit is a no-op.
//   - test artifacts (*.test.ts): never ship to a cell.
//   - `if-present` capability code (.pi/extensions, skills, prompts): these
//     are PER-CELL (a cell carries only what it opted into). Folding them
//     into one global rev would mark a cell that lacks an extension as
//     "stale" the moment that extension's code changed, and make the
//     steward's rev-triggered auto-refresh storm the whole fleet on any
//     extension edit. Extensions have their own `cells refresh-extensions`
//     path; the rev stays scoped to the uniformly-fixable surface.
//
// Rev mismatch therefore means precisely: `cells refresh` would change a
// platform file on this cell → genuine, uniformly-fixable staleness.
//
// Pure logic (path predicate, hash) is separated from IO (disk walk) so the
// fingerprint is unit-testable against in-memory file maps. Mirrors the
// registry.ts / reconcile.ts split.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { classifyPath } from "./refresh";

// Is this DNA-relative path part of the runtime fingerprint? Pure.
export function isRuntimeDnaPath(rel: string): boolean {
  // Normalize Windows separators so the predicate is platform-stable; the
  // repo is checked out with forward slashes everywhere we run, but the
  // classifier keys on "/" prefixes, so be defensive.
  const r = rel.split(sep).join("/");
  if (r.endsWith(".test.ts")) return false; // test artifacts never ship to a cell
  if (r.endsWith(".md")) return false; // prose must not move the rev
  return classifyPath(r).cls === "sync";
}

// Strip CR so a CRLF checkout hashes identically to an LF one.
function lfNormalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Pure: fold a rel-path → file-content map into the 12-hex rev. Filters to
// the runtime subset itself, so callers can pass a whole DNA tree. Sorted
// by path and content-only (no mode bits) so the rev is stable across
// checkouts and machines. Returns "" for an empty runtime set — a caller
// that gets "" should treat the rev as unknown, never compare it as equal.
export function hashRuntimeDna(files: Map<string, string>): string {
  const rels = [...files.keys()].filter(isRuntimeDnaPath).sort();
  if (rels.length === 0) return "";
  const h = createHash("sha256");
  for (const rel of rels) {
    h.update(rel.split(sep).join("/"));
    h.update("\0");
    h.update(lfNormalize(files.get(rel)!));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

function collectRuntimeFiles(dir: string, root: string, out: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRuntimeFiles(abs, root, out);
    } else if (entry.isFile()) {
      const rel = relative(root, abs);
      if (!isRuntimeDnaPath(rel)) continue; // don't even read non-runtime files
      out.set(rel, readFileSync(abs, "utf-8"));
    }
  }
}

// Memoize per dnaDir. The cells CLI is short-lived (one rev per process),
// the repo doesn't change mid-command, and dnaRev() is called from several
// sites in a single birth — so a single walk per dir is both correct and a
// real saving.
const revCache = new Map<string, string>();

// Compute the runtime-DNA rev of a DNA tree on disk (e.g. dna/cells/base).
// IO wrapper around hashRuntimeDna.
export function dnaRev(dnaDir: string): string {
  const cached = revCache.get(dnaDir);
  if (cached !== undefined) return cached;
  const files = new Map<string, string>();
  try {
    collectRuntimeFiles(dnaDir, dnaDir, files);
  } catch {
    // A missing/unreadable DNA dir yields "" (unknown) rather than throwing
    // — callers degrade to "can't compare" instead of failing a birth.
    revCache.set(dnaDir, "");
    return "";
  }
  const rev = hashRuntimeDna(files);
  revCache.set(dnaDir, rev);
  return rev;
}

// Test seam: drop the memo so a test can recompute after mutating fixtures.
export function _clearDnaRevCache(): void {
  revCache.clear();
}

// ── drift summary (pure) — shared by `cells doctor`, `doctor --json`, and
//    (via the json) the steward sweep. Classifies live cells against the
//    repo's current rev. ──────────────────────────────────────────────────

export type RevState = "current" | "stale" | "unknown";

// A non-empty rev equal to current → current; non-empty and different →
// stale; empty/absent → unknown (a pre-DNA-rev artifact or an unprobed/
// hibernated cell). Unknown is NEVER treated as stale: auto-heal must not
// act on a rev it couldn't read.
export function revState(rev: string | undefined | null, currentRev: string): RevState {
  if (!rev) return "unknown";
  if (!currentRev) return "unknown"; // can't classify without a baseline
  return rev === currentRev ? "current" : "stale";
}

export type DnaDriftSummary = {
  current: string;
  tree_clean: boolean;
  pool: { current: number; stale: number; unknown: number; total: number };
  cells: { name: string; rev: string; state: RevState }[];
  // Running cells that are definitively behind — the steward's refresh
  // targets. Excludes unknown (hibernated/unprobed): those refresh when they
  // next wake, never woken just to refresh.
  stale_cells: string[];
};

export function summarizeDnaDrift(input: {
  currentRev: string;
  treeClean: boolean;
  poolRevs: (string | undefined)[];
  cellRevs: { name: string; rev: string }[]; // running cells only (probed)
}): DnaDriftSummary {
  const pool = { current: 0, stale: 0, unknown: 0, total: input.poolRevs.length };
  for (const r of input.poolRevs) pool[revState(r, input.currentRev)]++;

  const cells = input.cellRevs
    .map((c) => ({ name: c.name, rev: c.rev, state: revState(c.rev, input.currentRev) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const stale_cells = cells.filter((c) => c.state === "stale").map((c) => c.name);

  return { current: input.currentRev, tree_clean: input.treeClean, pool, cells, stale_cells };
}
