// Canonical ~/.cells filesystem layout. Every control-plane module that
// reads or writes local state imports its paths from here, so the layout
// is defined exactly once. Leaf module — depends only on node builtins,
// so registry.ts / postwork.ts can all import it without creating a cycle.

import { homedir } from "node:os";
import { join } from "node:path";

export const REGISTRY_DIR = join(homedir(), ".cells");

// The cell registry (live cells: name, harness, model, well, …)
// and its cooperative lock. Every cells.json read-modify-write goes through
// withRegistryLock so concurrent writers (a birth pre-registering/promoting,
// `cells model/kill/project/chain`) can't clobber each other's update.
export const REGISTRY_PATH = join(REGISTRY_DIR, "cells.json");
export const REGISTRY_LOCK_PATH = join(REGISTRY_DIR, ".registry.lock");


// Per-cell post-birth status files written by scripts/birth-postwork.sh.
export const POSTWORK_DIR = join(REGISTRY_DIR, "postwork");
