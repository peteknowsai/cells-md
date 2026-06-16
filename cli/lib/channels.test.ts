import { test, expect } from "bun:test";
import { encodeChannelValue, parseChannelValue, SESSION_NAME_RE } from "./channels";

// The front-door workers (cli/worker/{slack,email}/index.ts) each carry a
// private parseBinding that must decode whatever encodeChannelValue writes.
// This is a copy of that decoder — kept identical so the round-trip test below
// guards the cross-file contract (a leading '{' marks JSON; else a bare name).
function decodeChannelValue(value: string): { cell: string; session?: string } | null {
  const v = value.trim();
  if (!v) return null;
  if (v[0] === "{") {
    try {
      const j = JSON.parse(v);
      if (j && typeof j.cell === "string" && j.cell) {
        return { cell: j.cell, session: typeof j.session === "string" && j.session ? j.session : undefined };
      }
    } catch { /* malformed */ }
    return null;
  }
  return { cell: v };
}

test("encodeChannelValue: session-less binding stays a bare cell name (back-compat)", () => {
  expect(encodeChannelValue("advisor-pete")).toBe("advisor-pete");
  expect(encodeChannelValue("advisor-pete", undefined)).toBe("advisor-pete");
  // A bare cell name never starts with '{', so the workers read it as a name.
  expect(encodeChannelValue("advisor-pete")[0]).not.toBe("{");
});

test("encodeChannelValue: a session pins as JSON {cell, session}", () => {
  expect(JSON.parse(encodeChannelValue("advisor-pete", "staff"))).toEqual({
    cell: "advisor-pete",
    session: "staff",
  });
});

test("encode → decode round-trips both shapes (the worker contract)", () => {
  expect(decodeChannelValue(encodeChannelValue("zero-advisor-tony"))).toEqual({
    cell: "zero-advisor-tony",
    session: undefined,
  });
  expect(decodeChannelValue(encodeChannelValue("zero-advisor-tony", "staff"))).toEqual({
    cell: "zero-advisor-tony",
    session: "staff",
  });
});

test("decodeChannelValue: empty/garbage → null (drop, never a literal name)", () => {
  expect(decodeChannelValue("")).toBeNull();
  expect(decodeChannelValue("   ")).toBeNull();
  expect(decodeChannelValue("{not json")).toBeNull();
  expect(decodeChannelValue('{"session":"staff"}')).toBeNull(); // no cell
});

test("parseChannelValue: bare kind → no session", () => {
  expect(parseChannelValue("slack")).toEqual({ kind: "slack" });
  expect(parseChannelValue("email")).toEqual({ kind: "email" });
});

test("parseChannelValue: kind:session splits", () => {
  expect(parseChannelValue("slack:staff")).toEqual({ kind: "slack", session: "staff" });
  expect(parseChannelValue("slack:buyer")).toEqual({ kind: "slack", session: "buyer" });
});

test("parseChannelValue: ':main' and ':' normalize away to the default session", () => {
  expect(parseChannelValue("slack:main")).toEqual({ kind: "slack", session: undefined });
  expect(parseChannelValue("slack:")).toEqual({ kind: "slack", session: undefined });
});

test("SESSION_NAME_RE: accepts valid names, rejects junk", () => {
  for (const ok of ["staff", "buyer", "s", "a1_b-c"]) expect(SESSION_NAME_RE.test(ok)).toBe(true);
  for (const bad of ["main ", "Staff", "1staff", "has space", "with:colon", ""]) {
    expect(SESSION_NAME_RE.test(bad)).toBe(false);
  }
});
