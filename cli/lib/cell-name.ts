// Cell-name validation. Names flow into DNS labels (worker subdomains,
// well names), shell interpolations (bake-egg.sh sed patterns, tar
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
