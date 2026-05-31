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
