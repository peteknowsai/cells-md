/**
 * Cell-side jobs-lane logic — spawn scripts, watchdog decisions, result
 * extraction. Pure functions; the incident behaviors (zero-token stall,
 * vanished process, leash overrun) are pinned here.
 */

import { describe, expect, test } from "bun:test";
import {
  buildJobScript,
  extractJobResult,
  freshWatchState,
  jobPaths,
  jobUnitName,
  leashLimitTicks,
  parseJobRecord,
  parseMainPid,
  stallLimitTicks,
  watchdogTick,
  WATCH_TICK_MS,
  type WatchState,
} from "./jobs";

const P = jobPaths("/root/state/jobs", "01JXTEST01");

describe("buildJobScript", () => {
  test("claude-code: fresh session, stream-json, prompt on stdin, exit file", () => {
    const r = buildJobScript("claude-code", P);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.script).toContain("claude --print --output-format stream-json --verbose");
    // Load-bearing for the watchdog: per-token byte growth on long jobs.
    expect(r.script).toContain("--include-partial-messages");
    expect(r.script).not.toContain("--resume");
    expect(r.script).toContain(`< '${P.prompt}'`);
    expect(r.script).toContain(`echo $? > '${P.exit}'`);
  });

  test("codex: fresh thread (no resume), --json", () => {
    const r = buildJobScript("codex", P);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.script).toContain("codex exec --json");
    expect(r.script).not.toContain(" resume ");
  });

  test("pi: fresh session dir, prompt as argv", () => {
    const r = buildJobScript("pi", P);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.script).toContain("pi --print --session-dir");
    expect(r.script).not.toContain("--fork");
  });

  test("hermes: fails fast with a clear error", () => {
    const r = buildJobScript("hermes", P);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("hermes");
  });
});

describe("transient units", () => {
  test("unit name carries id + attempt and is unit-name-safe", () => {
    expect(jobUnitName("01JXTEST01", 2)).toBe("cell-job-01JXTEST01-a2");
  });
  test("parseMainPid handles --value and key=value forms, rejects junk", () => {
    expect(parseMainPid("36134\n")).toBe(36134);
    expect(parseMainPid("MainPID=36134")).toBe(36134);
    for (const bad of ["", "0", "1", "abc", "MainPID="]) {
      expect(parseMainPid(bad)).toBeNull();
    }
  });
});

describe("watchdogTick", () => {
  const rec = { attempts: 1, harness: "claude-code", timeout_seconds: 3600 };

  test("exit file present wins over everything — finalize", () => {
    const a = watchdogTick(rec, { exitFilePresent: true, pidAlive: false, bytes: 0 }, freshWatchState());
    expect(a.act).toBe("finalize");
  });

  test("growing output resets the stall counter", () => {
    let state = freshWatchState();
    for (let i = 1; i <= 30; i++) {
      const a = watchdogTick(rec, { exitFilePresent: false, pidAlive: true, bytes: i * 100 }, state);
      expect(a.act).toBe("wait");
      if (a.act === "wait") state = a.state;
    }
    expect(state.stallTicks).toBe(0);
    expect(state.totalTicks).toBe(30);
  });

  test("the zero-token wedge: alive but silent → kill + retry once", () => {
    let state: WatchState = { lastBytes: 500, stallTicks: 0, totalTicks: 5 };
    let action;
    for (let i = 0; i < stallLimitTicks("claude-code"); i++) {
      action = watchdogTick(rec, { exitFilePresent: false, pidAlive: true, bytes: 500 }, state);
      if (action.act === "wait") state = action.state;
      else break;
    }
    expect(action!.act).toBe("kill");
    if (action!.act === "kill") {
      expect(action!.reason).toBe("stalled");
      expect(action!.retry).toBe(true);
    }
    // Second attempt stalls again → no more retries.
    const second = watchdogTick(
      { ...rec, attempts: 2 },
      { exitFilePresent: false, pidAlive: true, bytes: 500 },
      { lastBytes: 500, stallTicks: stallLimitTicks("claude-code") - 1, totalTicks: 20 },
    );
    expect(second.act).toBe("kill");
    if (second.act === "kill") expect(second.retry).toBe(false);
  });

  test("pi gets the wider stall window", () => {
    expect(stallLimitTicks("pi")).toBeGreaterThan(stallLimitTicks("claude-code"));
  });

  test("leash overrun fails without retry, even while streaming", () => {
    const shortRec = { attempts: 1, harness: "claude-code", timeout_seconds: 60 };
    const limit = leashLimitTicks(60);
    let state: WatchState = { lastBytes: 0, stallTicks: 0, totalTicks: limit - 1 };
    const a = watchdogTick(shortRec, { exitFilePresent: false, pidAlive: true, bytes: 10_000 }, state);
    expect(a.act).toBe("kill");
    if (a.act === "kill") {
      expect(a.reason).toBe("leash");
      expect(a.retry).toBe(false);
    }
  });

  test("vanished process (OOM, restore edge) → retry once", () => {
    const a = watchdogTick(rec, { exitFilePresent: false, pidAlive: false, bytes: 100 }, freshWatchState());
    expect(a.act).toBe("vanished");
    if (a.act === "vanished") expect(a.retry).toBe(true);
    const b = watchdogTick({ ...rec, attempts: 2 }, { exitFilePresent: false, pidAlive: false, bytes: 100 }, freshWatchState());
    if (b.act === "vanished") expect(b.retry).toBe(false);
  });

  test("leash ticks derive from the timeout", () => {
    expect(leashLimitTicks(3600)).toBe(Math.ceil((3600 * 1000) / WATCH_TICK_MS));
    expect(leashLimitTicks(1)).toBe(2); // floor — never sub-tick
  });
});

describe("extractJobResult", () => {
  test("claude-code: result frame carries the verdict", () => {
    const out = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working…" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Drained 14 events." }),
    ].join("\n");
    expect(extractJobResult("claude-code", out, 0)).toEqual({ ok: true, text: "Drained 14 events." });
  });

  test("claude-code: killed mid-stream → not ok, assistant text salvaged", () => {
    const out = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial answer" }] } });
    const r = extractJobResult("claude-code", out, null);
    expect(r.ok).toBe(false);
    expect(r.text).toBe("partial answer");
  });

  test("claude-code: error result frame is not ok even on exit 0", () => {
    const out = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
    expect(extractJobResult("claude-code", out, 0).ok).toBe(false);
  });

  test("codex: agent messages + turn.completed", () => {
    const out = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "All done." } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    expect(extractJobResult("codex", out, 0)).toEqual({ ok: true, text: "All done." });
  });

  test("codex: turn.failed carries the error", () => {
    const out = JSON.stringify({ type: "turn.failed", error: { message: "quota" } });
    expect(extractJobResult("codex", out, 0)).toEqual({ ok: false, text: "quota" });
  });

  test("pi: exit code is the verdict, stdout is the text", () => {
    expect(extractJobResult("pi", "plain answer\n", 0)).toEqual({ ok: true, text: "plain answer" });
    expect(extractJobResult("pi", "half an answer", 137).ok).toBe(false);
  });
});

describe("parseJobRecord", () => {
  test("round-trips a record and defaults missing fields", () => {
    const rec = parseJobRecord(JSON.stringify({ id: "01JX", status: "running", harness: "claude-code", attempts: 2, pgid: 42, pid: 43 }));
    expect(rec).not.toBeNull();
    expect(rec!.attempts).toBe(2);
    expect(rec!.timeout_seconds).toBe(3600);
  });
  test("rejects garbage", () => {
    expect(parseJobRecord("not json")).toBeNull();
    expect(parseJobRecord(JSON.stringify({ status: "running" }))).toBeNull();
    expect(parseJobRecord(JSON.stringify({ id: "x", status: "exploded" }))).toBeNull();
  });
});
