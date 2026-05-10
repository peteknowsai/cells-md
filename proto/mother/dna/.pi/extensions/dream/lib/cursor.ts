/**
 * Cursor: tracks the last successful dream ingest.
 *
 * Stored as an ISO timestamp in a single-line file at
 * <agent-root>/.dream/cursor. Independent of any storage package
 * (memory / mentality / wiki) — dream owns its own cursor.
 *
 * When wiki is installed, dream also appends a human-readable entry
 * to wiki/log.md, but that's provenance, not the cursor.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function resolveAgentRoot(): string {
  if (process.env.CELL_AGENT_ROOT) return process.env.CELL_AGENT_ROOT;
  if (existsSync("~/agent")) return "~/agent";
  return process.cwd();
}

const AGENT_ROOT = resolveAgentRoot();
const DREAM_DIR = join(AGENT_ROOT, "state", ".dream");
const CURSOR_FILE = join(DREAM_DIR, "cursor");

export function readCursor(): Date | null {
  if (!existsSync(CURSOR_FILE)) return null;
  const raw = readFileSync(CURSOR_FILE, "utf-8").trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function writeCursor(timestamp: Date): void {
  mkdirSync(DREAM_DIR, { recursive: true });
  writeFileSync(CURSOR_FILE, timestamp.toISOString() + "\n");
}

export { AGENT_ROOT };
