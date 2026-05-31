// Canonical ~/.cells filesystem layout. Every control-plane module that
// reads or writes local state imports its paths from here, so the layout
// is defined exactly once. Leaf module — depends only on node builtins,
// so pool.ts / registry.ts / postwork.ts can all import it without
// creating a cycle.

import { homedir } from "node:os";
import { join } from "node:path";

export const REGISTRY_DIR = join(homedir(), ".cells");

// The cell registry (live cells: name, harness, model, hatched_from, …).
export const REGISTRY_PATH = join(REGISTRY_DIR, "cells.json");

// The egg pool + its cooperative lock, and the pre-2026-05-13 legacy
// filename that loadPool migrates from on first read.
export const POOL_PATH = join(REGISTRY_DIR, "pool.json");
export const POOL_LOCK_PATH = join(REGISTRY_DIR, ".pool.lock");
export const LEGACY_EGGS_JSON_PATH = join(REGISTRY_DIR, "eggs.json");

// Per-cell post-birth status files written by scripts/birth-postwork.sh.
export const POSTWORK_DIR = join(REGISTRY_DIR, "postwork");
