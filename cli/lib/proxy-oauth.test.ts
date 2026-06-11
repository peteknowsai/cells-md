import { describe, it, expect } from "bun:test";
import {
  CLAUDE_CODE_PREAMBLE,
  ANTHROPIC_OAUTH_PREFIX,
  ensurePreamble,
  classifyOAuthRoute,
  anthropicRouteVerdict,
} from "./proxy-oauth";

// Convenience: the block shape ensurePreamble emits for the preamble.
const preambleBlock = { type: "text", text: CLAUDE_CODE_PREAMBLE };

describe("ensurePreamble", () => {
  it("absent system → single preamble block", () => {
    const out = ensurePreamble({ model: "claude" });
    expect(out.system).toEqual([preambleBlock]);
    expect((out.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
  });

  it("empty-string system → single preamble block (no empty text block)", () => {
    const out = ensurePreamble({ system: "" });
    expect(out.system).toEqual([preambleBlock]);
    expect((out.system as any[]).length).toBe(1);
    expect((out.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
  });

  it("plain string system → 2 blocks, preamble first", () => {
    const out = ensurePreamble({ system: "be terse" });
    expect(out.system).toEqual([preambleBlock, { type: "text", text: "be terse" }]);
    expect((out.system as any[]).length).toBe(2);
    expect((out.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
  });

  it("string already equal to the preamble → no double", () => {
    const out = ensurePreamble({ system: CLAUDE_CODE_PREAMBLE });
    expect(out.system).toEqual([preambleBlock]);
    expect((out.system as any[]).length).toBe(1);
    expect((out.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
  });

  it("array already starting with the preamble block → unchanged", () => {
    const blocks = [preambleBlock, { type: "text", text: "extra" }];
    const out = ensurePreamble({ system: blocks });
    expect(out.system).toEqual([preambleBlock, { type: "text", text: "extra" }]);
    expect((out.system as any[]).length).toBe(2);
    expect((out.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
  });

  it("array NOT starting with preamble → preamble prepended", () => {
    const out = ensurePreamble({ system: [{ type: "text", text: "hello" }] });
    expect(out.system).toEqual([preambleBlock, { type: "text", text: "hello" }]);
    expect((out.system as any[]).length).toBe(2);
    expect((out.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
  });

  it("array whose first block is a non-text block → preamble prepended", () => {
    const firstBlock = { type: "image", source: { data: "..." } };
    const out = ensurePreamble({ system: [firstBlock] });
    expect(out.system).toEqual([preambleBlock, firstBlock]);
    expect((out.system as any[]).length).toBe(2);
    expect((out.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
  });

  it("idempotency: apply twice == once", () => {
    const once = ensurePreamble({ system: "be terse" });
    const twice = ensurePreamble({ system: (once.system as any[]) });
    expect(twice.system).toEqual(once.system);
    expect((twice.system as any[]).length).toBe(2);
    expect((twice.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
  });

  it("other body keys (model, messages) preserved", () => {
    const messages = [{ role: "user", content: "hi" }];
    const out = ensurePreamble({ model: "claude-opus", messages, system: "x" });
    expect(out.model).toBe("claude-opus");
    expect(out.messages).toEqual(messages);
    expect((out.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
  });

  it("block[0].text is EXACTLY the preamble across every shape", () => {
    const cases: Record<string, unknown>[] = [
      {},
      { system: "" },
      { system: "be terse" },
      { system: CLAUDE_CODE_PREAMBLE },
      { system: [preambleBlock, { type: "text", text: "extra" }] },
      { system: [{ type: "text", text: "hello" }] },
      { system: [{ type: "image", source: { data: "..." } }] },
    ];
    for (const c of cases) {
      const out = ensurePreamble(c);
      expect((out.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
    }
  });

  it("unknown system shape (object) → body untouched", () => {
    const weird = { not: "a known shape" };
    const out = ensurePreamble({ system: weird });
    expect(out.system).toBe(weird);
  });

  it("primitive (number) system → body untouched", () => {
    const out = ensurePreamble({ system: 42 });
    expect(out.system).toBe(42);
  });

  // The realistic Claude-Code first block carries cache_control — the exact
  // duplicate-vs-skip branch. Extra keys must not defeat the idempotent skip.
  it("array first block is the preamble WITH extra keys (cache_control) → unchanged, not duplicated", () => {
    const firstWithCache = { type: "text", text: CLAUDE_CODE_PREAMBLE, cache_control: { type: "ephemeral" } };
    const out = ensurePreamble({ system: [firstWithCache, { type: "text", text: "soul" }] });
    expect((out.system as any[]).length).toBe(2);
    expect((out.system as any[])[0]).toBe(firstWithCache); // same ref, no duplicate prepended
  });

  // A near-miss text (preamble as a prefix of a longer string) must NOT match —
  // the gate needs an exact first block, so the proxy must prepend a real one.
  it("string that startsWith the preamble but is not equal → preamble prepended (strict ===)", () => {
    const out = ensurePreamble({ system: CLAUDE_CODE_PREAMBLE + " and more" });
    expect((out.system as any[]).length).toBe(2);
    expect((out.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
    expect((out.system as any[])[1].text).toBe(CLAUDE_CODE_PREAMBLE + " and more");
  });

  // The `first &&` guard must short-circuit a null/undefined first element
  // rather than throw on `.type`.
  it("array with a null first element → preamble prepended, no throw", () => {
    const out = ensurePreamble({ system: [null, { type: "text", text: "x" }] as any });
    expect((out.system as any[])[0].text).toBe(CLAUDE_CODE_PREAMBLE);
    expect((out.system as any[]).length).toBe(3);
  });

  it("returns the same body reference (in-place mutation contract)", () => {
    const body = { system: "x" };
    expect(ensurePreamble(body)).toBe(body);
  });
});

describe("classifyOAuthRoute", () => {
  it("/anthropic.com/v1/messages → {true, /v1/messages}", () => {
    expect(classifyOAuthRoute("/anthropic.com/v1/messages")).toEqual({
      isHermesOAuthRoute: true,
      upstreamPath: "/v1/messages",
    });
  });

  it("/anthropic.com → {true, /}", () => {
    expect(classifyOAuthRoute(ANTHROPIC_OAUTH_PREFIX)).toEqual({
      isHermesOAuthRoute: true,
      upstreamPath: "/",
    });
  });

  it("/anthropic.com/ → {true, /}", () => {
    expect(classifyOAuthRoute("/anthropic.com/")).toEqual({
      isHermesOAuthRoute: true,
      upstreamPath: "/",
    });
  });

  it("/anthropic.comx/v1/messages → {false, unchanged} (boundary, must NOT strip)", () => {
    expect(classifyOAuthRoute("/anthropic.comx/v1/messages")).toEqual({
      isHermesOAuthRoute: false,
      upstreamPath: "/anthropic.comx/v1/messages",
    });
  });

  it("/v1/messages → {false, unchanged}", () => {
    expect(classifyOAuthRoute("/v1/messages")).toEqual({
      isHermesOAuthRoute: false,
      upstreamPath: "/v1/messages",
    });
  });

  it("/codex/responses → {false, unchanged}", () => {
    expect(classifyOAuthRoute("/codex/responses")).toEqual({
      isHermesOAuthRoute: false,
      upstreamPath: "/codex/responses",
    });
  });

  it("/anthropic.com/v1/messages/count_tokens → {true, /v1/messages/count_tokens}", () => {
    expect(classifyOAuthRoute("/anthropic.com/v1/messages/count_tokens")).toEqual({
      isHermesOAuthRoute: true,
      upstreamPath: "/v1/messages/count_tokens",
    });
  });

  it("double prefix /anthropic.com/anthropic.com/v1 → strips exactly ONCE", () => {
    expect(classifyOAuthRoute("/anthropic.com/anthropic.com/v1")).toEqual({
      isHermesOAuthRoute: true,
      upstreamPath: "/anthropic.com/v1",
    });
  });

  it("empty-string pathname → {false, ''}", () => {
    expect(classifyOAuthRoute("")).toEqual({ isHermesOAuthRoute: false, upstreamPath: "" });
  });
});

// The Max-policy gate (Pete, 2026-06-11): Anthropic route is claude-code-only.
// Fixtures mirror the real fleet at policy time — pulse (claude-code), bob
// (pi, gpt-5.5 chain), mother (pi spawn harness, claude-code:anthropic chain
// entry), plus the unregistered/unknown caller class the proxy logs showed.
describe("anthropicRouteVerdict", () => {
  it("claude-code harness → allowed", () => {
    const v = anthropicRouteVerdict({ harness: "claude-code", modelChain: ["anthropic/claude-opus-4-7:high"] });
    expect(v.allowed).toBe(true);
  });

  it("pi harness, codex chain (bob) → denied, reason names the harness + the codex alternative", () => {
    const v = anthropicRouteVerdict({ harness: "pi", modelChain: ["openai-codex/gpt-5.5:medium"] });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("'pi'");
    expect(v.reason).toContain("/codex");
  });

  it("hermes harness → denied", () => {
    expect(anthropicRouteVerdict({ harness: "hermes", modelChain: ["openai-codex/gpt-5.5:high"] }).allowed).toBe(false);
  });

  it("codex harness → denied", () => {
    expect(anthropicRouteVerdict({ harness: "codex" }).allowed).toBe(false);
  });

  it("dual-harness special (mother): pi spawn harness + claude-code:anthropic chain entry → allowed", () => {
    const v = anthropicRouteVerdict({
      harness: "pi",
      modelChain: ["claude-code:anthropic/claude-opus-4-7:high", "pi:openai-codex/gpt-5.5:high"],
    });
    expect(v.allowed).toBe(true);
    expect(v.reason).toContain("chain entry");
  });

  it("pi:anthropic chain prefix does NOT sanction — only claude-code:anthropic does", () => {
    const v = anthropicRouteVerdict({ harness: "pi", modelChain: ["pi:anthropic/claude-opus-4-7:high"] });
    expect(v.allowed).toBe(false);
  });

  it("unregistered caller (x-cell-name unknown / __NAME__ / absent) → denied", () => {
    const v = anthropicRouteVerdict(undefined);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("not in registry");
  });

  it("legacy entry with no harness field → treated as pi (registry.ts contract) → denied", () => {
    expect(anthropicRouteVerdict({ modelChain: ["anthropic/claude-opus-4-7:high"] }).allowed).toBe(false);
  });

  it("legacy entry with no modelChain at all → denied without throwing", () => {
    expect(anthropicRouteVerdict({ harness: "pi" }).allowed).toBe(false);
  });
});
