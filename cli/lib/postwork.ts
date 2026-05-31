// Post-birth tail status — the structured signal mother's nohup chain
// writes to ~/.cells/postwork/<name>.json via scripts/birth-postwork.sh.
//
// Site service registration, Cloudflare Worker deploy, channel binding,
// harness update, and the final checkpoint all run after mother declares
// the cell alive (reliability over speed — never put Cloudflare in the
// critical path). Without this file each failure is invisible: the cell
// stays talkable, the registry shows it alive, but <name>.cells.md/debug
// 404s or channels never bind and no one notices.
//
// Consumers today: `cells list`'s deploy column, `cells doctor`'s 6b
// section, and the dashboard's per-cell pill. All read through this lib
// so the JSON shape lives in exactly one place.

import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { POSTWORK_DIR } from "./paths";

export function postworkPathFor(cellName: string): string {
  return join(POSTWORK_DIR, `${cellName}.json`);
}

export type PostworkSummary = {
  // Coarse rollup: pending = nohup chain is still running (no
  // completed_at yet), ok = chain finished with every step OK,
  // failed = chain finished but >=1 step reported failed.
  status: "pending" | "ok" | "failed";
  failed_steps: string[];
  // ISO timestamps written by birth-postwork.sh. completed_at is the
  // signal that the chain finished — it's the difference between
  // "pending" and "ok / failed".
  started_at: string | null;
  completed_at: string | null;
};

// The on-disk shape birth-postwork.sh writes. The field names here are a
// contract with that script's jq calls — postwork.test.ts spawns the real
// script and round-trips its output through summarizePostwork to catch
// drift in either direction.
export type PostworkDoc = {
  started_at?: string | null;
  completed_at?: string | null;
  steps?: Record<string, { status?: string; detail?: string }>;
};

// Pure rollup: turn the raw postwork document into the coarse summary the
// CLI / dashboard render. No IO — unit-testable directly.
export function summarizePostwork(doc: PostworkDoc): PostworkSummary {
  const steps = doc.steps ?? {};
  const failedSteps: string[] = [];
  for (const [name, s] of Object.entries(steps)) {
    if (s?.status === "failed") failedSteps.push(name);
  }
  const completedAt = doc.completed_at ?? null;
  // completed_at is stamped only when the chain finishes, so its absence
  // means "still running" even if every step so far reported ok.
  const status: PostworkSummary["status"] =
    completedAt === null ? "pending" : failedSteps.length > 0 ? "failed" : "ok";
  return {
    status,
    failed_steps: failedSteps,
    started_at: doc.started_at ?? null,
    completed_at: completedAt,
  };
}

export async function loadPostworkSummary(cellName: string): Promise<PostworkSummary | null> {
  const path = postworkPathFor(cellName);
  if (!existsSync(path)) return null;
  try {
    return summarizePostwork(JSON.parse(await readFile(path, "utf8")) as PostworkDoc);
  } catch {
    return null;
  }
}

// Best-effort: remove ~/.cells/postwork/<name>.json. Called from cmdKill
// so orphan postwork records don't accumulate across kill/birth cycles.
// Returns silently when no file exists or removal races a parallel sweep.
export async function removePostwork(cellName: string): Promise<void> {
  try {
    await unlink(postworkPathFor(cellName));
  } catch {
    /* file missing or already removed — nothing to clean up */
  }
}
