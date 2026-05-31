// Pure display helpers for the proxy status page: format a cell's born
// timestamp, and project a (possibly malformed) registry `cells` array into
// renderable rows. Separated from proxy.ts — which starts Bun.serve at
// import, so it can't be imported by a test — so the render tolerance is
// unit-testable.
//
// Tolerance matters here: loadRegistrySafe validates only the envelope
// (cells is an array), not each entry, and the /bridge/registry/write
// endpoint accepts unvalidated bodies. A single malformed entry (a null
// cell, a non-string created_at) must drop its own row, never throw and
// 500 the whole status page.

export type CellRow = { name: string; born: string };

// 2026-04-30T05:29:45.393Z → 2026-04-30 05:29. Anything that isn't a
// non-empty string (undefined, "", a number, an object) formats to "?".
export function formatBorn(iso?: unknown): string {
  if (!iso || typeof iso !== "string") return "?";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

// Project registry cells → status rows, skipping any entry that isn't a
// well-formed object with a string name.
export function cellRows(cells: unknown): CellRow[] {
  if (!Array.isArray(cells)) return [];
  return cells.flatMap((c) =>
    c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string"
      ? [{ name: (c as { name: string }).name, born: formatBorn((c as { created_at?: unknown }).created_at) }]
      : [],
  );
}
