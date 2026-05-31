// Site-file collection for publish — walk the public dir and base64 each
// file into the snapshot POSTed to the cell's Worker.
//
// Extracted from site/server.ts so the security-sensitive containment +
// symlink defense is unit-testable: server.ts starts a Bun.serve at module
// load, so it can't be imported into a test without booting the server.
// This module is pure of that side effect — IO only against the dir it's
// handed.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isInsideDir } from "./path-guard";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

// Per-file ceiling. The Worker's DO storage caps a value at 128 KiB and
// base64 inflates ~33%, so an on-disk file must stay under ~96 KiB. v1 is
// text-first (HTML/CSS/JS/markdown); large media is a later, R2-backed path.
export const SITE_FILE_CAP = 96 * 1024;

// `base` is the only directory the cell agent is meant to publish from.
// Use lstat (not stat) so symlinks aren't transparently followed out of the
// tree, and resolve every entry against `base` to refuse anything that
// escapes via `..` or an absolute link target. Without these guards a stray
// symlink under site/public — landed via a careless merge, a debug
// experiment, or a bug in the agent itself — would silently base64
// /etc/environment (or anything else readable as `well`) into the Worker
// snapshot served at <name>.cells.md.
export function collectSiteFiles(dir: string, base: string, out: Record<string, { ct: string; data: string }>) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!isInsideDir(base, full)) {
      console.error(`[site] skipping ${full} — resolves outside ${base}`);
      continue;
    }
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      console.error(`[site] skipping ${full} — symlink (not published)`);
      continue;
    }
    if (st.isDirectory()) {
      collectSiteFiles(full, base, out);
    } else if (st.isFile()) {
      if (st.size > SITE_FILE_CAP) {
        console.error(`[site] skipping ${full} — ${Math.round(st.size / 1024)}KB over ${SITE_FILE_CAP / 1024}KB cap`);
        continue;
      }
      const rel = "/" + full.slice(base.length).replace(/^\/+/, "");
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
      out[rel] = {
        ct: MIME[ext] ?? "application/octet-stream",
        data: readFileSync(full).toString("base64"),
      };
    }
  }
}
