import { test, expect } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSiteFiles, SITE_FILE_CAP } from "./site-files";

// Build a temp public/ tree, run the real collectSiteFiles against it, and
// assert what makes it into the publish snapshot. This is the security-
// critical coverage isInsideDir's unit test can't give: isInsideDir reasons
// about path text only — the symlink skip and the cap live here.

function withTree(fn: (base: string, out: Record<string, { ct: string; data: string }>) => void) {
  const root = mkdtempSync(join(tmpdir(), "site-files-"));
  const out: Record<string, { ct: string; data: string }> = {};
  try {
    fn(join(root, "public"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("collects normal files with the right content-type", () => {
  withTree((base, out) => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "index.html"), "<h1>hi</h1>");
    mkdirSync(join(base, "css"));
    writeFileSync(join(base, "css", "app.css"), "body{}");
    collectSiteFiles(base, base, out);
    expect(Object.keys(out).sort()).toEqual(["/css/app.css", "/index.html"]);
    expect(out["/index.html"]!.ct).toContain("text/html");
    expect(out["/css/app.css"]!.ct).toContain("text/css");
    expect(Buffer.from(out["/index.html"]!.data, "base64").toString()).toBe("<h1>hi</h1>");
  });
});

test("SKIPS a symlink pointing outside the tree (the exfil vector)", () => {
  withTree((base, out) => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "index.html"), "ok");
    // A secret outside the publish tree, and a symlink to it inside public/.
    const root = join(base, "..");
    writeFileSync(join(root, "secret.env"), "CELLS_PROXY_SECRET=topsecret");
    symlinkSync(join(root, "secret.env"), join(base, "leak.env"));
    collectSiteFiles(base, base, out);
    // Only the real file is published; the symlink is refused.
    expect(Object.keys(out)).toEqual(["/index.html"]);
    expect(JSON.stringify(out)).not.toContain("topsecret");
  });
});

test("SKIPS a symlinked directory (no recursion through links)", () => {
  withTree((base, out) => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "index.html"), "ok");
    const root = join(base, "..");
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "x.txt"), "out-of-tree");
    symlinkSync(join(root, "outside"), join(base, "linkdir"));
    collectSiteFiles(base, base, out);
    expect(Object.keys(out)).toEqual(["/index.html"]);
    expect(JSON.stringify(out)).not.toContain("out-of-tree");
  });
});

test("skips a file over the per-file cap", () => {
  withTree((base, out) => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "ok.txt"), "small");
    writeFileSync(join(base, "huge.bin"), "x".repeat(SITE_FILE_CAP + 1));
    collectSiteFiles(base, base, out);
    expect(Object.keys(out)).toEqual(["/ok.txt"]);
  });
});

test("an empty public dir yields an empty snapshot", () => {
  withTree((base, out) => {
    mkdirSync(base, { recursive: true });
    collectSiteFiles(base, base, out);
    expect(out).toEqual({});
  });
});
