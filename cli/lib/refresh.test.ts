import { describe, it, expect } from "bun:test";
import { classifyPath, overlay, buildPlan } from "./refresh";

describe("classifyPath", () => {
  it("platform infrastructure is sync", () => {
    expect(classifyPath("site/server.ts").cls).toBe("sync");
    expect(classifyPath("site/package.json").cls).toBe("sync");
    expect(classifyPath("lib/harness-adapters.ts").cls).toBe("sync");
    expect(classifyPath("bin/cells").cls).toBe("sync");
    expect(classifyPath("scripts/cell-color.sh").cls).toBe("sync");
  });

  it("cell-owned identity and state are never", () => {
    for (const p of [
      "SOUL.md",
      "IDENTITY.md",
      "MEMORY.md",
      "HEARTBEAT.md",
      "package.json",
      ".pi/settings.json",
      ".claude/settings.json",
      "site/public/index.html",
      "state/memory/log.md",
      ".pi/agent/sessions/root-bob/main.jsonl",
    ]) {
      expect(classifyPath(p).cls).toBe("never");
    }
  });

  it("site/public is never even though site/server.ts is sync (prefix discipline)", () => {
    expect(classifyPath("site/public/style.css").cls).toBe("never");
    expect(classifyPath("site/server.ts").cls).toBe("sync");
  });

  it("extensions and skills are if-present with the dir as the unit", () => {
    expect(classifyPath(".pi/extensions/memory/index.ts")).toEqual({
      cls: "if-present",
      unit: ".pi/extensions/memory",
    });
    expect(classifyPath(".claude/skills/birth/SKILL.md")).toEqual({
      cls: "if-present",
      unit: ".claude/skills/birth",
    });
  });

  it("prompts are one flat if-present unit", () => {
    expect(classifyPath(".pi/prompts/cell-checkpoint.md")).toEqual({
      cls: "if-present",
      unit: ".pi/prompts",
    });
  });

  it("unknown paths are outside the refresh surface", () => {
    expect(classifyPath("docs/notes.md").cls).toBe("outside");
    expect(classifyPath("randomfile.txt").cls).toBe("outside");
  });
});

describe("overlay", () => {
  it("special files win over base at the same rel path", () => {
    const base = new Map([["lib/a.ts", "/base/lib/a.ts"], ["bin/cells", "/base/bin/cells"]]);
    const special = new Map([["lib/a.ts", "/special/lib/a.ts"]]);
    const out = overlay(base, special);
    expect(out.get("lib/a.ts")).toBe("/special/lib/a.ts");
    expect(out.get("bin/cells")).toBe("/base/bin/cells");
  });

  it("null special is a no-op copy", () => {
    const base = new Map([["lib/a.ts", "/base/lib/a.ts"]]);
    const out = overlay(base, null);
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });
});

describe("buildPlan", () => {
  const sources = new Map([
    ["site/server.ts", "/dna/site/server.ts"],
    ["lib/agent-envelope.ts", "/dna/lib/agent-envelope.ts"],
    ["lib/agent-envelope.test.ts", "/dna/lib/agent-envelope.test.ts"],
    [".pi/extensions/memory/index.ts", "/dna/.pi/extensions/memory/index.ts"],
    [".pi/extensions/well-tools/index.ts", "/dna/.pi/extensions/well-tools/index.ts"],
    ["SOUL.md", "/dna/SOUL.md"],
    ["docs/x.md", "/dna/docs/x.md"],
  ]);

  it("pushes sync always, if-present only when the cell carries the unit", () => {
    const plan = buildPlan(sources, new Set([".pi/extensions/memory"]));
    expect(plan.push.has("site/server.ts")).toBe(true);
    expect(plan.push.has(".pi/extensions/memory/index.ts")).toBe(true);
    expect(plan.push.has(".pi/extensions/well-tools/index.ts")).toBe(false);
    expect(plan.skippedUnits).toEqual([".pi/extensions/well-tools"]);
  });

  it("the mother case: a stripped extension never comes back via refresh", () => {
    // mother's well has well-tools deleted by birth-special; refresh must
    // not resurrect it even though it exists in her DNA dir.
    const plan = buildPlan(sources, new Set([".pi/extensions/memory"]));
    expect([...plan.push.keys()].some((p) => p.includes("well-tools"))).toBe(false);
  });

  it("never-class paths are reported as protected, not pushed", () => {
    const plan = buildPlan(sources, new Set());
    expect(plan.push.has("SOUL.md")).toBe(false);
    expect(plan.protected).toContain("SOUL.md");
  });

  it("test files are excluded even under sync roots", () => {
    const plan = buildPlan(sources, new Set());
    expect(plan.push.has("lib/agent-envelope.test.ts")).toBe(false);
    expect(plan.push.has("lib/agent-envelope.ts")).toBe(true);
  });

  it("outside paths are silently dropped", () => {
    const plan = buildPlan(sources, new Set());
    expect(plan.push.has("docs/x.md")).toBe(false);
    expect(plan.protected).not.toContain("docs/x.md");
  });
});
