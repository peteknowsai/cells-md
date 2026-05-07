// Smoke tests for variant signature parse/format/hash. Run with:
//   bun test cli/lib/variant-signature.test.ts

import { test, expect } from "bun:test";
import { formatVariant, parseVariant, variantHash, eggSpriteName, variantsEqual, poolKey, poolKeyMatches, type Variant } from "./variant-signature";

test("formatVariant produces canonical sorted form", () => {
  const v: Variant = {
    model: "opus",
    thinking: "high",
    extensions: ["wiki", "memory"], // unsorted on purpose
    packages: ["pi-web-access"],
    channels: ["slack"],
  };
  expect(formatVariant(v)).toBe(
    "v1:model=opus,thinking=high,extensions=memory|wiki,packages=pi-web-access,channels=slack",
  );
});

test("formatVariant handles empty multi-values", () => {
  const v: Variant = { model: "sonnet", thinking: "off", extensions: [], packages: [], channels: [] };
  expect(formatVariant(v)).toBe("v1:model=sonnet,thinking=off,extensions=,packages=,channels=");
});

test("parseVariant inverts formatVariant", () => {
  const v: Variant = {
    model: "gpt-5.5",
    thinking: "xhigh",
    extensions: ["memory", "wiki"],
    packages: [],
    channels: ["slack", "email"],
  };
  const sig = formatVariant(v);
  const parsed = parseVariant(sig);
  expect(formatVariant(parsed)).toBe(sig);
});

test("parseVariant rejects bad version", () => {
  expect(() => parseVariant("v2:model=opus,thinking=high,extensions=,packages=,channels=")).toThrow();
});

test("parseVariant rejects missing field", () => {
  expect(() => parseVariant("v1:model=opus,thinking=high,extensions=,packages=")).toThrow();
});

test("variantHash is stable + 6 hex chars", () => {
  const v: Variant = { model: "opus", thinking: "high", extensions: ["memory"], packages: [], channels: [] };
  const h1 = variantHash(v);
  const h2 = variantHash(v);
  expect(h1).toBe(h2);
  expect(h1).toMatch(/^[0-9a-f]{6}$/);
});

test("variantHash ignores extension order", () => {
  const a: Variant = { model: "opus", thinking: "high", extensions: ["wiki", "memory"], packages: [], channels: [] };
  const b: Variant = { model: "opus", thinking: "high", extensions: ["memory", "wiki"], packages: [], channels: [] };
  expect(variantHash(a)).toBe(variantHash(b));
});

test("eggSpriteName strips non-alnum from model", () => {
  const v: Variant = { model: "gpt-5.5", thinking: "high", extensions: [], packages: [], channels: [] };
  expect(eggSpriteName(v)).toMatch(/^egg-gpt55-[0-9a-f]{6}$/);
});

test("variantsEqual treats sort-order-different inputs as equal", () => {
  const a: Variant = { model: "opus", thinking: "high", extensions: ["wiki", "memory"], packages: ["pi-web-access"], channels: [] };
  const b: Variant = { model: "opus", thinking: "high", extensions: ["memory", "wiki"], packages: ["pi-web-access"], channels: [] };
  expect(variantsEqual(a, b)).toBe(true);
});

test("poolKey zeros out thinking and channels", () => {
  const v: Variant = { model: "opus", thinking: "high", extensions: ["memory"], packages: [], channels: ["slack"] };
  expect(poolKey(v)).toBe("v1:model=opus,thinking=,extensions=memory,packages=,channels=");
});

test("poolKeyMatches across thinking/channels differences", () => {
  const a: Variant = { model: "opus", thinking: "high", extensions: ["memory"], packages: [], channels: ["slack"] };
  const b: Variant = { model: "opus", thinking: "low",  extensions: ["memory"], packages: [], channels: [] };
  expect(poolKeyMatches(a, b)).toBe(true);
});

test("poolKeyMatches rejects model mismatch", () => {
  const a: Variant = { model: "opus", thinking: "high", extensions: [], packages: [], channels: [] };
  const b: Variant = { model: "sonnet", thinking: "high", extensions: [], packages: [], channels: [] };
  expect(poolKeyMatches(a, b)).toBe(false);
});

test("poolKeyMatches rejects extensions mismatch", () => {
  const a: Variant = { model: "opus", thinking: "high", extensions: ["memory"], packages: [], channels: [] };
  const b: Variant = { model: "opus", thinking: "high", extensions: ["memory", "wiki"], packages: [], channels: [] };
  expect(poolKeyMatches(a, b)).toBe(false);
});
