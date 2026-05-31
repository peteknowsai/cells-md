// Cell-name → well-name resolution. Single source of truth for the
// mapping. cells.ts and any helper (channels.ts, etc.) that needs to call
// `well exec -s <wellname>` for a given cell goes through here.
//
// Mapping rules (matches what cmdShell/cmdTui/cmdTalk have done all along):
//   - special (mother, pulse)  → `cells-<name>`     (deterministic well)
//   - pool-hatched cell        → pool entry's well_name (egg-<hex>)
//   - no registry entry        → return the input name (caller decides)
//   - registry entry, no hatched_from
//     and not special           → return the input name (legacy / pre-pool cells)

import { readFile } from "node:fs/promises";
import { REGISTRY_PATH, POOL_PATH } from "./paths";

// Reads here are intentionally tolerant (readJson swallows a missing or
// corrupt file): wellNameForCell degrades to returning the input name
// rather than throwing, so `cells shell/tui/talk` still function against a
// transiently-bad registry. That's why this keeps a local readJson instead
// of the strict loadRegistry/loadPool — different error stance on purpose.
type RegistryCell = {
  name: string;
  hatched_from?: string;
  special?: boolean;
  harness?: string;
};

type PoolMember = {
  id: string;
  well_name: string;
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
  if (cell.special) return `cells-${name}`;
  if (!cell.hatched_from) return name;
  const pool = await readJson<{ members?: PoolMember[] }>(POOL_PATH, {});
  const member = (pool.members ?? []).find((e) => e.id === cell.hatched_from);
  return member?.well_name ?? name;
}
