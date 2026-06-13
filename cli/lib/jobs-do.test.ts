/**
 * DO-side jobs-lane logic (cli/shared/jobs.ts) — validation, admission,
 * transitions, eviction. Pure functions; no Workers runtime needed.
 */

import { describe, expect, test } from "bun:test";
import {
  admitJob,
  applyJobAccepted,
  applyJobDone,
  DEFAULT_JOB_TIMEOUT_S,
  evictTerminal,
  jobFrame,
  jobSummary,
  JOB_PROMPT_CAP,
  JOB_SUMMARY_CAP,
  MAX_ACTIVE_JOBS,
  MAX_JOB_TIMEOUT_S,
  MAX_TERMINAL_RECORDS,
  MIN_JOB_TIMEOUT_S,
  validateJobSubmit,
  type DoJobRecord,
} from "../shared/jobs";

const NOW = "2026-06-12T02:00:00.000Z";

function rec(over: Partial<DoJobRecord> = {}): DoJobRecord {
  return {
    id: "01JXTESTJOB0000000000000",
    created_at: "2026-06-12T00:00:00.000Z",
    timeout_seconds: 3600,
    status: "queued",
    ...over,
  };
}

describe("validateJobSubmit", () => {
  test("accepts a well-formed submit and defaults the timeout", () => {
    const v = validateJobSubmit({ job_id: "01JXM2K8ABCDEF", text: "drain the queue" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.job.id).toBe("01JXM2K8ABCDEF");
      expect(v.job.prompt).toBe("drain the queue");
      expect(v.job.timeoutSeconds).toBe(DEFAULT_JOB_TIMEOUT_S);
    }
  });

  test("clamps timeout to [min, max]", () => {
    const lo = validateJobSubmit({ job_id: "01JXM2K8ABCDEF", text: "x", timeout_seconds: 5 });
    const hi = validateJobSubmit({ job_id: "01JXM2K8ABCDEF", text: "x", timeout_seconds: 9_999_999 });
    expect(lo.ok && lo.job.timeoutSeconds).toBe(MIN_JOB_TIMEOUT_S);
    expect(hi.ok && hi.job.timeoutSeconds).toBe(MAX_JOB_TIMEOUT_S);
  });

  test("rejects bad ids — they become filenames on the cell", () => {
    for (const id of ["", "short", "has space", "../../etc/passwd", "a".repeat(41), 42, null]) {
      const v = validateJobSubmit({ job_id: id, text: "x" });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.status).toBe(400);
    }
  });

  test("rejects empty and oversized prompts", () => {
    const empty = validateJobSubmit({ job_id: "01JXM2K8ABCDEF", text: "   " });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.status).toBe(400);
    const big = validateJobSubmit({ job_id: "01JXM2K8ABCDEF", text: "x".repeat(JOB_PROMPT_CAP + 1) });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.status).toBe(413);
  });
});

describe("admitJob", () => {
  test("duplicate id is idempotent, not an error", () => {
    const existing = rec({ id: "01JXDUPLICATE1" });
    const d = admitJob([existing], "01JXDUPLICATE1");
    expect(d.kind).toBe("duplicate");
    if (d.kind === "duplicate") expect(d.rec).toBe(existing);
  });

  test("refuses past the active cap; terminal records don't count", () => {
    const active = Array.from({ length: MAX_ACTIVE_JOBS }, (_, i) =>
      rec({ id: `01JXACTIVE${String(i).padStart(4, "0")}`, status: i % 2 ? "queued" : "running" }));
    expect(admitJob(active, "01JXNEWJOB01").kind).toBe("full");
    const terminal = active.map((r, i) => ({ ...r, status: (i % 2 ? "done" : "failed") as const }));
    expect(admitJob(terminal, "01JXNEWJOB01").kind).toBe("admit");
  });
});

describe("transitions", () => {
  test("job_accepted marks running", () => {
    const r = rec();
    applyJobAccepted(r);
    expect(r.status).toBe("running");
  });

  test("job_accepted never resurrects a terminal record", () => {
    const r = rec({ status: "done", ok: true });
    applyJobAccepted(r);
    expect(r.status).toBe("done");
  });

  test("job_done caps the summary and stamps finished_at", () => {
    const r = rec({ status: "running" });
    applyJobDone(r, { ok: true, summary: "y".repeat(JOB_SUMMARY_CAP * 2), finished_at: "2026-06-12T01:00:00.000Z" }, NOW);
    expect(r.status).toBe("done");
    expect(r.ok).toBe(true);
    expect(r.summary!.length).toBe(JOB_SUMMARY_CAP);
    expect(r.finished_at).toBe("2026-06-12T01:00:00.000Z");
  });

  test("job_done falls back to the injected clock when finished_at is absent", () => {
    const r = rec({ status: "running" });
    applyJobDone(r, { ok: true, summary: "done" }, NOW);
    expect(r.finished_at).toBe(NOW);
  });

  test("job_done without ok:true is a failure", () => {
    const r = rec({ status: "running" });
    applyJobDone(r, { summary: "stalled at zero tokens" }, NOW);
    expect(r.status).toBe("failed");
    expect(r.ok).toBe(false);
  });
});

describe("evictTerminal", () => {
  test("keeps all non-terminal and the newest terminal records", () => {
    const entries: [string, DoJobRecord][] = [];
    for (let i = 0; i < MAX_TERMINAL_RECORDS + 10; i++) {
      const id = `01JXOLD${String(i).padStart(6, "0")}`;
      entries.push([id, rec({ id, status: "done", finished_at: `2026-06-0${1 + (i % 9)}T00:00:${String(i % 60).padStart(2, "0")}.000Z` })]);
    }
    entries.push(["01JXLIVE000001", rec({ id: "01JXLIVE000001", status: "running" })]);
    const pruned = evictTerminal(entries);
    expect(pruned.length).toBe(MAX_TERMINAL_RECORDS + 1);
    expect(pruned.some(([k]) => k === "01JXLIVE000001")).toBe(true);
  });

  test("no-op under the cap", () => {
    const entries: [string, DoJobRecord][] = [["a12345678", rec({ status: "done" })]];
    expect(evictTerminal(entries)).toEqual(entries);
  });
});

describe("frames and summaries", () => {
  test("jobFrame carries the passed-in prompt; jobSummary never does", () => {
    const r = rec();
    expect(JSON.parse(jobFrame(r, "secret task body")).prompt).toBe("secret task body");
    expect(JSON.stringify(jobSummary(r))).not.toContain("secret task body");
  });
});
