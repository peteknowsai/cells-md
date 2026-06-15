/**
 * DO-side job-lane logic — pure functions, no IO.
 *
 * The jobs lane (docs/proposals/jobs.html) gives a cell durable background
 * work: `cells run` POSTs a kind:"job" event to the cell's /inbox/append,
 * the CellAgent DO records it and answers 202 with the job id immediately,
 * and the on-cell runner executes it in a fresh detached session. This
 * module holds the decisions the DO makes — validation, admission, record
 * transitions, eviction — so they're unit-testable from cli/lib/ without a
 * Workers runtime.
 *
 * Used by cli/worker/cell/cell-agent.ts (bundled into every per-cell
 * worker). Keep it dependency-free.
 */

export type DoJobStatus = "queued" | "running" | "done" | "failed";

// Which session the run binds to (interactive claude-code only). Mirrors
// SessionTarget in dna/cells/base/lib/jobs.ts; redefined here to keep this
// module dependency-free (it bundles into the per-cell Worker).
export type JobSessionTarget = "fresh" | "fork" | "main";

export type DoJobRecord = {
  id: string;
  // Never persisted in the snapshot: the DO stores each queued prompt under
  // its own `job-prompt:<id>` storage key and deletes it on job_accepted.
  // Packing prompts into the one DO_STATE_KEY value would blow the 128 KiB
  // per-value cap at just four max-size queued jobs (codex review P2,
  // 2026-06-13). Kept optional on the type for the wire frame only.
  prompt?: string;
  created_at: string;
  timeout_seconds: number;
  status: DoJobStatus;
  ok?: boolean;
  // First JOB_SUMMARY_CAP chars of the result; the full result stays on the
  // cell under /root/state/jobs/.
  summary?: string;
  finished_at?: string;
  // Passed through to the on-cell runner in the job frame (interactive
  // claude-code only). Omitted = fresh.
  session_target?: JobSessionTarget;
};

export const JOB_PROMPT_CAP = 32 * 1024;
export const JOB_SUMMARY_CAP = 2048;
// A cell is one small VM; jobs are "go do this and report", not a fan-out
// work queue. Backpressure beats an OOM'd cell.
export const MAX_ACTIVE_JOBS = 8;
export const MAX_TERMINAL_RECORDS = 32;
export const DEFAULT_JOB_TIMEOUT_S = 3600;
export const MIN_JOB_TIMEOUT_S = 60;
export const MAX_JOB_TIMEOUT_S = 86_400;

// Job ids are ULIDs from the submitting CLI, but accept any sane token so
// hand-rolled submitters work; the id becomes a filename on the cell, so
// the character set is the real constraint.
const JOB_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{7,39}$/;

export type JobSubmit = { id: string; prompt: string; timeoutSeconds: number; sessionTarget?: JobSessionTarget };

export function validateJobSubmit(event: unknown):
  | { ok: true; job: JobSubmit }
  | { ok: false; status: number; reason: string } {
  const e = (event ?? {}) as Record<string, unknown>;
  const id = typeof e.job_id === "string" ? e.job_id : "";
  if (!JOB_ID_RE.test(id)) {
    return { ok: false, status: 400, reason: "bad job_id (8-40 chars, [0-9A-Za-z_-])" };
  }
  const prompt = typeof e.text === "string" ? e.text : "";
  if (!prompt.trim()) {
    return { ok: false, status: 400, reason: "empty text" };
  }
  if (prompt.length > JOB_PROMPT_CAP) {
    return { ok: false, status: 413, reason: `text over ${JOB_PROMPT_CAP} bytes` };
  }
  const rawTimeout = e.timeout_seconds;
  let timeoutSeconds = DEFAULT_JOB_TIMEOUT_S;
  if (typeof rawTimeout === "number" && Number.isFinite(rawTimeout)) {
    timeoutSeconds = Math.round(
      Math.min(MAX_JOB_TIMEOUT_S, Math.max(MIN_JOB_TIMEOUT_S, rawTimeout)),
    );
  }
  const st = e.session_target;
  const sessionTarget: JobSessionTarget | undefined =
    st === "fresh" || st === "fork" || st === "main" ? st : undefined;
  return { ok: true, job: { id, prompt, timeoutSeconds, ...(sessionTarget ? { sessionTarget } : {}) } };
}

export function isTerminal(status: DoJobStatus): boolean {
  return status === "done" || status === "failed";
}

export type AdmitDecision =
  | { kind: "duplicate"; rec: DoJobRecord }
  | { kind: "full" }
  | { kind: "admit" };

// Re-submitting an existing id is idempotent (the at-least-once world
// guarantees duplicates); a cell with MAX_ACTIVE_JOBS in flight refuses
// new ones rather than stacking processes on a small VM.
export function admitJob(records: Iterable<DoJobRecord>, id: string): AdmitDecision {
  let active = 0;
  for (const rec of records) {
    if (rec.id === id) return { kind: "duplicate", rec };
    if (!isTerminal(rec.status)) active++;
  }
  if (active >= MAX_ACTIVE_JOBS) return { kind: "full" };
  return { kind: "admit" };
}

// The frame the supervisor receives. No ack_key: the durable ack is
// job_accepted (sent after the job file is on disk), not frame receipt.
// The prompt is passed separately — it lives under its own storage key,
// never inside the record snapshot.
export function jobFrame(rec: DoJobRecord, prompt: string): string {
  return JSON.stringify({
    type: "job",
    id: rec.id,
    prompt,
    timeout_seconds: rec.timeout_seconds,
    ...(rec.session_target ? { session_target: rec.session_target } : {}),
  });
}

// job_accepted — the supervisor wrote the job file. Mark running; the
// caller deletes the separate job-prompt:<id> storage key (the cell owns
// the prompt now).
export function applyJobAccepted(rec: DoJobRecord): void {
  if (isTerminal(rec.status)) return;
  rec.status = "running";
}

// job_done — terminal transition. Summary is capped here so an over-chatty
// supervisor can't blow the DO storage value cap.
export function applyJobDone(
  rec: DoJobRecord,
  ev: { ok?: unknown; summary?: unknown; finished_at?: unknown },
  now: string,
): void {
  rec.status = ev.ok === true ? "done" : "failed";
  rec.ok = ev.ok === true;
  rec.summary = typeof ev.summary === "string" ? ev.summary.slice(0, JOB_SUMMARY_CAP) : "";
  rec.finished_at =
    typeof ev.finished_at === "string" && ev.finished_at
      ? ev.finished_at
      : now;
}

// Keep every non-terminal record; keep the newest MAX_TERMINAL_RECORDS
// terminal ones. Entry order is preserved for the survivors.
export function evictTerminal(
  entries: [string, DoJobRecord][],
): [string, DoJobRecord][] {
  const terminal = entries.filter(([, r]) => isTerminal(r.status));
  if (terminal.length <= MAX_TERMINAL_RECORDS) return entries;
  const drop = new Set(
    terminal
      .sort((a, b) => (a[1].finished_at ?? a[1].created_at).localeCompare(b[1].finished_at ?? b[1].created_at))
      .slice(0, terminal.length - MAX_TERMINAL_RECORDS)
      .map(([k]) => k),
  );
  return entries.filter(([k]) => !drop.has(k));
}

// Public summary of a record (GET /jobs, /debug) — never includes the prompt.
export function jobSummary(rec: DoJobRecord): Record<string, unknown> {
  return {
    id: rec.id,
    status: rec.status,
    created_at: rec.created_at,
    timeout_seconds: rec.timeout_seconds,
    ...(rec.ok !== undefined ? { ok: rec.ok } : {}),
    ...(rec.summary ? { summary: rec.summary } : {}),
    ...(rec.finished_at ? { finished_at: rec.finished_at } : {}),
  };
}
