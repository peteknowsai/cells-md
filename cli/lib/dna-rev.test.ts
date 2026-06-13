import { describe, expect, it } from "bun:test";
import { hashRuntimeDna, isRuntimeDnaPath, revState, summarizeDnaDrift } from "./dna-rev";

describe("isRuntimeDnaPath", () => {
  it("includes the sync-class platform surface", () => {
    expect(isRuntimeDnaPath("site/server.ts")).toBe(true);
    expect(isRuntimeDnaPath("site/package.json")).toBe(true);
    expect(isRuntimeDnaPath("lib/jobs.ts")).toBe(true);
    expect(isRuntimeDnaPath("lib/harness-adapters.ts")).toBe(true);
    expect(isRuntimeDnaPath("bin/cells")).toBe(true); // extensionless executable
    expect(isRuntimeDnaPath("bin/publish-image")).toBe(true);
    expect(isRuntimeDnaPath("scripts/apply-pi-patches.sh")).toBe(true);
  });

  it("excludes markdown so prose/doc edits never move the rev", () => {
    expect(isRuntimeDnaPath("CELLS.md")).toBe(false);
    expect(isRuntimeDnaPath("lib/README.md")).toBe(false);
    expect(isRuntimeDnaPath(".pi/skills/birth/SKILL.md")).toBe(false);
  });

  it("excludes test artifacts (they never ship to a cell)", () => {
    expect(isRuntimeDnaPath("lib/jobs.test.ts")).toBe(false);
    expect(isRuntimeDnaPath("lib/harness-adapters.test.ts")).toBe(false);
  });

  it("excludes per-cell capability code (if-present) and cell-owned state", () => {
    // if-present: a cell carries only what it opted into — out of the
    // universal rev by design.
    expect(isRuntimeDnaPath(".pi/extensions/wiki/index.ts")).toBe(false);
    expect(isRuntimeDnaPath(".claude/skills/birth/run.sh")).toBe(false);
    expect(isRuntimeDnaPath(".pi/prompts/foo.md")).toBe(false);
    // never-class identity/state/settings.
    expect(isRuntimeDnaPath("SOUL.md")).toBe(false);
    expect(isRuntimeDnaPath(".pi/settings.json")).toBe(false);
    expect(isRuntimeDnaPath("state/memory/activity.md")).toBe(false);
    // outside the refresh surface entirely.
    expect(isRuntimeDnaPath("bun.lock")).toBe(false);
    expect(isRuntimeDnaPath("package.json")).toBe(false);
  });
});

describe("hashRuntimeDna", () => {
  const base = () =>
    new Map<string, string>([
      ["site/server.ts", "export const x = 1\n"],
      ["lib/jobs.ts", "// jobs\n"],
      ["CELLS.md", "# prose\n"],
      ["lib/jobs.test.ts", "test stuff\n"],
    ]);

  it("is deterministic and 12 hex chars", () => {
    const a = hashRuntimeDna(base());
    const b = hashRuntimeDna(base());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is order-independent across the input map", () => {
    const reordered = new Map<string, string>([
      ["lib/jobs.ts", "// jobs\n"],
      ["lib/jobs.test.ts", "test stuff\n"],
      ["site/server.ts", "export const x = 1\n"],
      ["CELLS.md", "# prose\n"],
    ]);
    expect(hashRuntimeDna(reordered)).toBe(hashRuntimeDna(base()));
  });

  it("changes when a runtime file's content changes", () => {
    const before = hashRuntimeDna(base());
    const after = base();
    after.set("lib/jobs.ts", "// jobs v2\n");
    expect(hashRuntimeDna(after)).not.toBe(before);
  });

  it("does NOT change when only markdown or a test file changes", () => {
    const before = hashRuntimeDna(base());
    const docEdit = base();
    docEdit.set("CELLS.md", "# completely rewritten prose\n\nlots more\n");
    docEdit.set("lib/jobs.test.ts", "different test body\n");
    expect(hashRuntimeDna(docEdit)).toBe(before);
  });

  it("normalizes CRLF so a Windows checkout matches an LF one", () => {
    const lf = new Map([["lib/jobs.ts", "a\nb\nc\n"]]);
    const crlf = new Map([["lib/jobs.ts", "a\r\nb\r\nc\r\n"]]);
    expect(hashRuntimeDna(crlf)).toBe(hashRuntimeDna(lf));
  });

  it("returns '' (unknown) for an empty runtime set", () => {
    expect(hashRuntimeDna(new Map([["CELLS.md", "# only prose\n"]]))).toBe("");
    expect(hashRuntimeDna(new Map())).toBe("");
  });

  it("distinguishes same content at different paths", () => {
    const a = new Map([["lib/a.ts", "same\n"]]);
    const b = new Map([["lib/b.ts", "same\n"]]);
    expect(hashRuntimeDna(a)).not.toBe(hashRuntimeDna(b));
  });
});

describe("revState", () => {
  it("classifies current / stale / unknown", () => {
    expect(revState("abc", "abc")).toBe("current");
    expect(revState("old", "abc")).toBe("stale");
    expect(revState("", "abc")).toBe("unknown");
    expect(revState(undefined, "abc")).toBe("unknown");
    expect(revState(null, "abc")).toBe("unknown");
  });
  it("is unknown when there's no current baseline", () => {
    expect(revState("abc", "")).toBe("unknown");
  });
});

describe("summarizeDnaDrift", () => {
  it("buckets pool eggs and lists only running-stale cells for the steward", () => {
    const s = summarizeDnaDrift({
      currentRev: "cur",
      treeClean: true,
      poolRevs: ["cur", "cur", "old", undefined, ""],
      cellRevs: [
        { name: "bob", rev: "old" }, // stale → steward target
        { name: "advisor", rev: "cur" }, // current
        { name: "zoe", rev: "" }, // unknown (probe miss) → not a target
      ],
    });
    expect(s.current).toBe("cur");
    expect(s.tree_clean).toBe(true);
    expect(s.pool).toEqual({ current: 2, stale: 1, unknown: 2, total: 5 });
    expect(s.stale_cells).toEqual(["bob"]);
    // cells sorted by name
    expect(s.cells.map((c) => c.name)).toEqual(["advisor", "bob", "zoe"]);
    expect(s.cells.find((c) => c.name === "zoe")!.state).toBe("unknown");
  });

  it("never lists stale cells when current rev is unknown (no baseline)", () => {
    const s = summarizeDnaDrift({
      currentRev: "",
      treeClean: false,
      poolRevs: ["a", "b"],
      cellRevs: [{ name: "bob", rev: "a" }],
    });
    expect(s.pool).toEqual({ current: 0, stale: 0, unknown: 2, total: 2 });
    expect(s.stale_cells).toEqual([]);
  });
});
