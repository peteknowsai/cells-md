// Cell-name → well-name resolution. Single source of truth for the mapping.
// cells.ts and any helper (channels.ts, fleet.ts, host-bridge, etc.) that needs
// to `well exec -s <wellname>` for a given cell goes through here.
//
// Mapping rules:
//   - cell with a stored `well`  → that well name (set at birth: `cells-<name>`)
//   - cell without one / special → `cells-<name>` (the namespace convention,
//                                   docs/namespacing.md — what specials always used)
//   - no registry entry          → the input name (caller decides)
//
// Legacy (pre-cold-boot) cells were backfilled with their real well names, so
// resolution is purely data-driven — the code no longer derives a well name
// from any per-era scheme.

import { readFile } from "node:fs/promises";
import { REGISTRY_PATH } from "./paths";

// Reads here are intentionally tolerant (readJson swallows a missing or corrupt
// file): wellNameForCell degrades to returning the input name rather than
// throwing, so `cells shell/tui/talk` still function against a transiently-bad
// registry. That's why this keeps a local readJson instead of the strict
// loadRegistry — different error stance on purpose.
type RegistryCell = {
  name: string;
  well?: string;
};

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const txt = await readFile(path, "utf-8");
    return JSON.parse(txt) as T;
  } catch {
    return fallback;
  }
}

export async function wellNameForCell(name: string): Promise<string> {
  const reg = await readJson<{ cells?: RegistryCell[] }>(REGISTRY_PATH, {});
  const cell = (reg.cells ?? []).find((c) => c.name === name);
  if (!cell) return name;
  // The well name is stored on the record (set at birth). Specials and any cell
  // missing the field default to the `cells-<name>` namespace convention — the
  // same scheme specials have always used. The cell name already carries its
  // project prefix (projectCellName), so this yields e.g. `cells-zero-advisor-pete`.
  return cell.well ?? `cells-${name}`;
}
