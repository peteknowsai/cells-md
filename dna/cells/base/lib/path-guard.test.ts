import { test, expect } from "bun:test";
import { isInsideDir } from "./path-guard";

test("a file directly inside the base dir is inside", () => {
  expect(isInsideDir("/root/site/public", "/root/site/public/index.html")).toBe(true);
});

test("a file in a nested subdir is inside", () => {
  expect(isInsideDir("/root/site/public", "/root/site/public/a/b/c.css")).toBe(true);
});

test("the base dir itself counts as inside", () => {
  expect(isInsideDir("/root/site/public", "/root/site/public")).toBe(true);
});

test("a sibling dir sharing a name prefix is NOT inside (the serveStatic bug)", () => {
  // This is the exact case a bare startsWith(base) got wrong:
  // "/root/site/public-secrets" shares the prefix "/root/site/public"
  // but is a different directory.
  expect(isInsideDir("/root/site/public", "/root/site/public-secrets/leak")).toBe(false);
  expect(isInsideDir("/root/site/public", "/root/site/publicX")).toBe(false);
});

test("a parent-traversal escape is NOT inside", () => {
  expect(isInsideDir("/root/site/public", "/root/site/public/../../../etc/passwd")).toBe(false);
});

test("an absolute path outside the base is NOT inside", () => {
  expect(isInsideDir("/root/site/public", "/etc/environment")).toBe(false);
});

test("resolves relative inputs against cwd before comparing", () => {
  // Both relative: resolve() makes them absolute against the same cwd,
  // so a nested relative path is correctly inside its relative base.
  expect(isInsideDir("public", "public/index.html")).toBe(true);
  expect(isInsideDir("public", "public-secrets/x")).toBe(false);
});

test("trailing slash on the base dir does not change the verdict", () => {
  expect(isInsideDir("/root/site/public/", "/root/site/public/index.html")).toBe(true);
  expect(isInsideDir("/root/site/public/", "/root/site/public-secrets/x")).toBe(false);
});
