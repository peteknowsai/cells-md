import { test, expect } from "bun:test";
import { compileBrief, type BriefVocab } from "./brief";

const VOCAB: BriefVocab = {
  models: ["opus", "sonnet", "haiku", "gpt-5.5"],
  harnesses: ["pi", "claude-code", "codex", "hermes"],
  thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max", "adaptive"],
};

test("extracts model + thinking, leaves the purpose", () => {
  const r = compileBrief("national parcel resolver, opus, medium thinking", VOCAB);
  expect(r.model).toBe("opus");
  expect(r.thinking).toBe("medium");
  expect(r.harness).toBeUndefined();
  expect(r.purpose).toBe("national parcel resolver");
});

test("a pure-purpose brief yields no config", () => {
  const r = compileBrief("fast chat cell for answering buyer questions", VOCAB);
  expect(r.model).toBeUndefined();
  expect(r.thinking).toBeUndefined();
  expect(r.harness).toBeUndefined();
  expect(r.purpose).toBe("fast chat cell for answering buyer questions");
});

test("recognizes a harness, bare and with the 'harness' word", () => {
  expect(compileBrief("billing bot, codex", VOCAB).harness).toBe("codex");
  expect(compileBrief("billing bot, claude-code harness", VOCAB).harness).toBe("claude-code");
});

test("thinking phrasings: bare, '<level> thinking', 'thinking <level>', '<level> effort'", () => {
  expect(compileBrief("x, high", VOCAB).thinking).toBe("high");
  expect(compileBrief("x, high thinking", VOCAB).thinking).toBe("high");
  expect(compileBrief("x, thinking high", VOCAB).thinking).toBe("high");
  expect(compileBrief("x, xhigh effort", VOCAB).thinking).toBe("xhigh");
});

test("config tokens mid-sentence (no comma) are NOT extracted — they stay purpose", () => {
  const r = compileBrief("an opus-grade summary writer", VOCAB);
  expect(r.model).toBeUndefined();
  expect(r.purpose).toBe("an opus-grade summary writer");
});

test("a config-only brief leaves an empty purpose", () => {
  const r = compileBrief("opus, high", VOCAB);
  expect(r.model).toBe("opus");
  expect(r.thinking).toBe("high");
  expect(r.purpose).toBe("");
});

test("first recognized token of each kind wins; extras fall to purpose", () => {
  const r = compileBrief("resolver, opus, sonnet", VOCAB);
  expect(r.model).toBe("opus");
  expect(r.purpose).toBe("resolver, sonnet"); // second model isn't config
});

test("case-insensitive matching; purpose preserves original casing", () => {
  const r = compileBrief("Parcel Resolver, OPUS, HIGH thinking", VOCAB);
  expect(r.model).toBe("opus");
  expect(r.thinking).toBe("high");
  expect(r.purpose).toBe("Parcel Resolver");
});

test("hyphenated model id (gpt-5.5) matches as a bare token", () => {
  expect(compileBrief("chat cell, gpt-5.5", VOCAB).model).toBe("gpt-5.5");
});

test("empty / whitespace brief → empty purpose, no config", () => {
  expect(compileBrief("", VOCAB)).toEqual({ purpose: "" });
  expect(compileBrief("   ,  , ", VOCAB)).toEqual({ purpose: "" });
});
