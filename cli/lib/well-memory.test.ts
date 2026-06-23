import { describe, expect, test } from "bun:test";
import { defaultMemoryForBirth } from "./well-memory.ts";

describe("defaultMemoryForBirth — per-harness VM RAM policy", () => {
  test("pi/codex/hermes take welld's default (no override)", () => {
    expect(defaultMemoryForBirth("pi", "gpt-5.5")).toBeUndefined();
    expect(defaultMemoryForBirth("codex", "gpt-5.5")).toBeUndefined();
    expect(defaultMemoryForBirth("hermes", "gpt-5.5")).toBeUndefined();
  });

  test("claude-code gets 2GB by default (a single interactive session needs headroom over 1GB)", () => {
    expect(defaultMemoryForBirth("claude-code", "claude-sonnet-4-6")).toBe("2GB");
    expect(defaultMemoryForBirth("claude-code", "claude-haiku-4-5")).toBe("2GB");
    expect(defaultMemoryForBirth("claude-code", undefined)).toBe("2GB");
  });

  test("claude-code + opus gets 4GB (opus sessions grow most — the kdice-opus OOM)", () => {
    expect(defaultMemoryForBirth("claude-code", "opus")).toBe("4GB");
    expect(defaultMemoryForBirth("claude-code", "claude-opus-4-8")).toBe("4GB");
    expect(defaultMemoryForBirth("claude-code", "anthropic/opus:high")).toBe("4GB");
  });

  test("undefined harness takes the default (no override) — never throws", () => {
    expect(defaultMemoryForBirth(undefined, undefined)).toBeUndefined();
    expect(defaultMemoryForBirth(undefined, "opus")).toBeUndefined();
  });
});
