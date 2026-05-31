// Path-containment guard. One canonical check for "is this candidate path
// inside this base directory" — used by the site server both when serving
// a static file (serveStatic) and when collecting files to publish to the
// Worker (collectSiteFiles).
//
// The trailing-separator check is load-bearing and the reason this lives
// in one place: a bare `candidate.startsWith(base)` treats
// `/root/site/public-secrets/x` as inside `/root/site/public` (shared
// prefix, no separator). That false-positive is a path-escape — appending
// the platform separator before comparing closes it. resolve() collapses
// `..` and makes both paths absolute so traversal and relative inputs are
// handled too. Symlink following is the caller's concern (lstat before
// calling); this function only reasons about the textual path.

import { resolve, sep } from "node:path";

export function isInsideDir(baseDir: string, candidate: string): boolean {
  const base = resolve(baseDir);
  const target = resolve(candidate);
  return target === base || target.startsWith(base + sep);
}
