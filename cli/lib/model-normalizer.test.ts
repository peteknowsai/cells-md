import { test, expect } from "bun:test";
import { isOpusFamily, latestOpusFrom, normalizeAnthropicModel } from "./model-normalizer";

const MODELS = [
  { id: "claude-fable-5", created_at: "2026-06-07T00:00:00Z" },
  { id: "claude-opus-4-8", created_at: "2026-05-28T00:00:00Z" },
  { id: "claude-opus-4-7", created_at: "2026-04-14T00:00:00Z" },
  { id: "claude-sonnet-4-6", created_at: "2026-03-01T00:00:00Z" },
  { id: "claude-opus-4-6", created_at: "2026-02-01T00:00:00Z" },
  { id: "claude-opus-4-5-20251101", created_at: "2025-11-01T00:00:00Z" },
  { id: "claude-opus-4-20250514", created_at: "2025-05-14T00:00:00Z" },
  { id: "claude-haiku-4-5-20251001", created_at: "2025-10-01T00:00:00Z" },
];

test("latestOpusFrom picks the newest opus by created_at, not fable or sonnet", () => {
  expect(latestOpusFrom(MODELS)).toBe("claude-opus-4-8");
});

test("latestOpusFrom: dated legacy IDs don't outrank version-stamped ones", () => {
  // claude-opus-4-20250514 parses as 'newer-looking' only if you treat the
  // date as a minor version — created_at ordering avoids that trap.
  const shuffled = [...MODELS].reverse();
  expect(latestOpusFrom(shuffled)).toBe("claude-opus-4-8");
});

test("latestOpusFrom falls back to list order without created_at", () => {
  expect(
    latestOpusFrom([{ id: "claude-sonnet-4-6" }, { id: "claude-opus-4-9" }, { id: "claude-opus-4-8" }]),
  ).toBe("claude-opus-4-9");
});

test("latestOpusFrom returns null with no opus entries", () => {
  expect(latestOpusFrom([{ id: "claude-sonnet-4-6" }])).toBeNull();
  expect(latestOpusFrom([])).toBeNull();
});

test("opus family detection", () => {
  expect(isOpusFamily("opus")).toBe(true);
  expect(isOpusFamily("claude-opus-latest")).toBe(true);
  expect(isOpusFamily("claude-opus-4-7")).toBe(true);
  expect(isOpusFamily("claude-opus-4-5-20251101")).toBe(true);
  expect(isOpusFamily("claude-sonnet-4-6")).toBe(false);
  expect(isOpusFamily("claude-haiku-4-5")).toBe(false);
  expect(isOpusFamily("gpt-5.5")).toBe(false);
});

test("normalize rewrites stale opus pins and the bare alias", () => {
  expect(normalizeAnthropicModel("claude-opus-4-7", "claude-opus-4-8")).toBe("claude-opus-4-8");
  expect(normalizeAnthropicModel("opus", "claude-opus-4-8")).toBe("claude-opus-4-8");
  expect(normalizeAnthropicModel("claude-opus-4-5-20251101", "claude-opus-4-8")).toBe("claude-opus-4-8");
  // already-latest is idempotent
  expect(normalizeAnthropicModel("claude-opus-4-8", "claude-opus-4-8")).toBe("claude-opus-4-8");
});

test("normalize leaves non-opus models alone", () => {
  expect(normalizeAnthropicModel("claude-sonnet-4-6", "claude-opus-4-8")).toBe("claude-sonnet-4-6");
  expect(normalizeAnthropicModel("claude-haiku-4-5", "claude-opus-4-8")).toBe("claude-haiku-4-5");
});

test("normalize is a no-op when latest is unknown", () => {
  expect(normalizeAnthropicModel("claude-opus-4-7", null)).toBe("claude-opus-4-7");
});
