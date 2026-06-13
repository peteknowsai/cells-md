import { test, expect } from "bun:test";
import {
  isValidCellName,
  validateCellName,
  isMotherName,
  projectOfMother,
  projectMotherName,
  projectCellName,
} from "./cell-name";

test("accepts plain lowercase names", () => {
  expect(isValidCellName("alice")).toBe(true);
  expect(isValidCellName("bob")).toBe(true);
  expect(isValidCellName("cell-abc123")).toBe(true);
});

test("accepts digits and hyphens in the middle", () => {
  expect(isValidCellName("a1")).toBe(true);
  expect(isValidCellName("a-b")).toBe(true);
  expect(isValidCellName("a--b")).toBe(true); // double hyphen mid-name is legal per DNS
  expect(isValidCellName("alpha9beta")).toBe(true);
});

test("rejects uppercase", () => {
  expect(isValidCellName("Alice")).toBe(false);
  expect(isValidCellName("ALICE")).toBe(false);
});

test("rejects leading or trailing hyphen", () => {
  expect(isValidCellName("-alice")).toBe(false);
  expect(isValidCellName("alice-")).toBe(false);
  expect(isValidCellName("-")).toBe(false);
});

test("rejects single-char names", () => {
  expect(isValidCellName("a")).toBe(false);
  expect(isValidCellName("")).toBe(false);
});

test("rejects names over 63 chars", () => {
  expect(isValidCellName("a".repeat(63))).toBe(true);
  expect(isValidCellName("a".repeat(64))).toBe(false);
});

test("rejects names with shell metacharacters", () => {
  expect(isValidCellName("rm-rf-slash")).toBe(true); // dashes are fine
  expect(isValidCellName("a;b")).toBe(false);
  expect(isValidCellName("a b")).toBe(false);
  expect(isValidCellName("a/b")).toBe(false);
  expect(isValidCellName("a&b")).toBe(false);
  expect(isValidCellName("a$b")).toBe(false);
  expect(isValidCellName("a`b")).toBe(false);
  expect(isValidCellName("a..b")).toBe(false);
  expect(isValidCellName("a.b")).toBe(false);
  expect(isValidCellName("a_b")).toBe(false); // underscore not in DNS label
});

test("rejects unicode and emoji", () => {
  expect(isValidCellName("café")).toBe(false);
  expect(isValidCellName("cell-🐛")).toBe(false);
});

test("validateCellName returns a useful reason on failure", () => {
  const empty = validateCellName("");
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.reason).toMatch(/empty/);

  const tooShort = validateCellName("a");
  expect(tooShort.ok).toBe(false);
  if (!tooShort.ok) expect(tooShort.reason).toMatch(/short/);

  const tooLong = validateCellName("a".repeat(64));
  expect(tooLong.ok).toBe(false);
  if (!tooLong.ok) expect(tooLong.reason).toMatch(/long/);

  const upper = validateCellName("Alice");
  expect(upper.ok).toBe(false);
  if (!upper.ok) expect(upper.reason).toMatch(/illegal/);
});

test("validateCellName returns ok for the auto-generated shape", () => {
  // cell-<6 hex>
  expect(validateCellName("cell-abc123").ok).toBe(true);
  expect(validateCellName("cell-000000").ok).toBe(true);
  expect(validateCellName("cell-ffffff").ok).toBe(true);
});

// ── mother naming (project mothers) ────────────────────────────────────

test("isMotherName: global mother and project mothers", () => {
  expect(isMotherName("mother")).toBe(true);
  expect(isMotherName("zero-mother")).toBe(true);
  expect(isMotherName("paonia-mother")).toBe(true);
});

test("isMotherName: ordinary cells are not mothers", () => {
  expect(isMotherName("abstractor")).toBe(false);
  expect(isMotherName("advisor-pete")).toBe(false);
  expect(isMotherName("pulse")).toBe(false);
  // a cell literally named "mother-foo" is not a mother (suffix, not prefix)
  expect(isMotherName("mother-ship")).toBe(false);
});

test("projectOfMother: derives the project (\"\" for global)", () => {
  expect(projectOfMother("mother")).toBe("");
  expect(projectOfMother("zero-mother")).toBe("zero");
  expect(projectOfMother("a-b-mother")).toBe("a-b"); // project may contain hyphens
});

test("projectOfMother: null for non-mothers and the empty-project degenerate", () => {
  expect(projectOfMother("abstractor")).toBeNull();
  expect(projectOfMother("pulse")).toBeNull();
  expect(projectOfMother("-mother")).toBeNull(); // empty project → not a valid project mother
});

test("projectMotherName round-trips with projectOfMother", () => {
  expect(projectMotherName("zero")).toBe("zero-mother");
  expect(projectOfMother(projectMotherName("paonia"))).toBe("paonia");
});

test("projectCellName prefixes the project, idempotently", () => {
  expect(projectCellName("zero", "abstractor")).toBe("zero-abstractor");
  expect(projectCellName("zero", "zero-abstractor")).toBe("zero-abstractor"); // no double prefix
  expect(projectCellName("paonia", "clerk")).toBe("paonia-clerk");
  expect(projectCellName("zero", "cell-abc123")).toBe("zero-cell-abc123"); // auto-names too
});
