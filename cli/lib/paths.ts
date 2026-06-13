// Canonical ~/.cells filesystem layout. Every control-plane module that
// reads or writes local state imports its paths from here, so the layout
// is defined exactly once. Leaf module — depends only on node builtins,
// so pool.ts / registry.ts / postwork.ts can all import it without
// creating a cycle.

import { homedir } from "node:os";
import { join } from "node:path";

export const REGISTRY_DIR = join(homedir(), ".cells");

// The cell registry (live cells: name, harness, model, hatched_from, …)
// and its cooperative lock. Every cells.json read-modify-write goes through
// withRegistryLock so concurrent writers (a birth pre-registering/promoting,
// `cells model/kill/project/chain`) can't clobber each other's update.
export const REGISTRY_PATH = join(REGISTRY_DIR, "cells.json");
export const REGISTRY_LOCK_PATH = join(REGISTRY_DIR, ".registry.lock");

// The egg pool + its cooperative lock, and the pre-2026-05-13 legacy
// filename that loadPool migrates from on first read.
export const POOL_PATH = join(REGISTRY_DIR, "pool.json");
export const POOL_LOCK_PATH = join(REGISTRY_DIR, ".pool.lock");
export const LEGACY_EGGS_JSON_PATH = join(REGISTRY_DIR, "eggs.json");

// Single-flight sentinel for the whole refill loop. Distinct from the
// pool lock: POOL_LOCK_PATH guards short pool.json read-modify-writes,
// while this guards the minutes-long refillPoolToDepth bake loop so two
// triggers (post-claim drought kick, reconcile shrink, `pool refill`, the
// steward) don't run concurrent bake loops that oversubscribe the host.
export const REFILL_LOCK_PATH = join(REGISTRY_DIR, ".refill.lock");

// Per-cell post-birth status files written by scripts/birth-postwork.sh.
export const POSTWORK_DIR = join(REGISTRY_DIR, "postwork");
