// Cell-name validation. Names flow into DNS labels (worker subdomains,
// well names), shell interpolations (imprint-cell.sh sed patterns, tar
// paths), /etc/environment writes, and JSON wire formats. Enforcing
// DNS-label safety at the cmdCreate boundary is the cheapest place to
// stop a bad name from reaching any of them — much cheaper than
// teaching every downstream call site to escape correctly.
//
// Rules:
//   - lowercase ASCII letters, digits, hyphen
//   - must start AND end with letter or digit
//   - 2..63 chars (DNS label limit)
//
// generateCellName() emits names like `cell-abc123` which always pass;
// the validator exists to catch user-typed or LLM-generated names.

const CELL_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const CELL_NAME_MIN = 2;
const CELL_NAME_MAX = 63;

export function isValidCellName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length < CELL_NAME_MIN || name.length > CELL_NAME_MAX) return false;
  return CELL_NAME_RE.test(name);
}

export function describeCellNameRules(): string {
  return `cell names must be ${CELL_NAME_MIN}–${CELL_NAME_MAX} chars, lowercase letters/digits/hyphen, no leading or trailing hyphen`;
}

// ── Mother naming ────────────────────────────────────────────────────────
// A mother is a ROLE keyed by project, not a singleton: the global `mother`,
// or a project's `<project>-mother`. These pure helpers are the single place
// the naming convention lives, so the role test, the project derivation, and
// the name construction can't drift apart.

const MOTHER_SUFFIX = "-mother";

// True for the global mother and every project mother.
export function isMotherName(name: string): boolean {
  return name === "mother" || name.endsWith(MOTHER_SUFFIX);
}

// The project a mother name belongs to: "" for the global `mother`, the project
// for "<project>-mother", or null if the name isn't a mother at all.
export function projectOfMother(name: string): string | null {
  if (name === "mother") return "";
  if (name.endsWith(MOTHER_SUFFIX) && name.length > MOTHER_SUFFIX.length) {
    return name.slice(0, -MOTHER_SUFFIX.length);
  }
  return null;
}

// The mother name for a project: "<project>-mother".
export function projectMotherName(project: string): string {
  return `${project}${MOTHER_SUFFIX}`;
}

// Whether `cells run` must refuse a job on this cell because it's a mother.
// The original guard refused ALL mothers ("a detached job racing the birth
// ritual is the known silent deadlock"). That deadlock only exists when the
// ritual runs THROUGH the mother cell — the legacy CELLS_USE_MOTHER_CELL mode.
// Under the default (births run Mac-side in MOTHER_ROOT, never talking to the
// mother cell), a PROJECT mother's job can't re-enter its own ritual, so it's
// safe — and that's exactly what lets a project mother run a durable birth as
// her own job. Still refuse the GLOBAL mother (her births are Mac-CLI-initiated;
// a self-job has no use case and would only risk racing the global lock), and
// refuse ANY mother under CELLS_USE_MOTHER_CELL where the deadlock is real.
// Returns a reason string when refused, or null when the job is allowed.
export function motherJobRefusalReason(name: string, useMotherCell: boolean): string | null {
  const project = projectOfMother(name);
  if (project === null) return null; // not a mother — no mother-specific refusal
  if (project === "") {
    return "the global mother births Mac-side via the deterministic handoff; a detached job would only race the birth-ritual lock";
  }
  if (useMotherCell) {
    return "CELLS_USE_MOTHER_CELL routes the birth ritual through the mother cell, so a detached job races it — the known silent deadlock";
  }
  return null; // project mother, default Mac-side-ritual mode — allowed
}

// ── Pulse naming ──────────────────────────────────────────────────────────
// Pulse is the family scheduler, and — like mother — a ROLE keyed by project,
// not a singleton: the global `pulse`, or a project's `<project>-pulse`. The
// difference from mother is that pulse genuinely shards (different pulses fire
// `cells talk` at different cells, in parallel), where project mothers share a
// global birth lock. These helpers mirror the mother block above byte-for-byte
// so the two roles can't drift; the ownership *resolver* (which cell each
// heartbeat belongs to) lives in ./pulse-owner.

const PULSE_SUFFIX = "-pulse";

// True for the global pulse and every project pulse.
export function isPulseName(name: string): boolean {
  return name === "pulse" || name.endsWith(PULSE_SUFFIX);
}

// The project a pulse name belongs to: "" for the global `pulse`, the project
// for "<project>-pulse", or null if the name isn't a pulse at all.
export function projectOfPulse(name: string): string | null {
  if (name === "pulse") return "";
  if (name.endsWith(PULSE_SUFFIX) && name.length > PULSE_SUFFIX.length) {
    return name.slice(0, -PULSE_SUFFIX.length);
  }
  return null;
}

// The pulse name for a project: "<project>-pulse".
export function projectPulseName(project: string): string {
  return `${project}${PULSE_SUFFIX}`;
}

// A project cell's globally-unique name: "<project>-<name>". Project cells are
// name-prefixed (like <project>-mother) so two projects can each have an
// "abstractor" without colliding, and a fleet name self-documents its project.
// Idempotent: a name already prefixed with "<project>-" is left as-is, so
// `cells birth zero zero-abstractor` doesn't become zero-zero-abstractor.
export function projectCellName(project: string, name: string): string {
  return name.startsWith(`${project}-`) ? name : `${project}-${name}`;
}

export function validateCellName(name: string): { ok: true } | { ok: false; reason: string } {
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, reason: "cell name is empty" };
  }
  if (name.length < CELL_NAME_MIN) {
    return { ok: false, reason: `'${name}' is too short — ${describeCellNameRules()}` };
  }
  if (name.length > CELL_NAME_MAX) {
    return { ok: false, reason: `'${name}' is too long — ${describeCellNameRules()}` };
  }
  if (!CELL_NAME_RE.test(name)) {
    return { ok: false, reason: `'${name}' has illegal characters — ${describeCellNameRules()}` };
  }
  return { ok: true };
}
