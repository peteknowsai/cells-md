/**
 * Cell-side jobs-lane logic — pure functions, no IO, no process spawning.
 *
 * The runner in site/server.ts owns the IO (files under /root/state/jobs/,
 * the detached spawn, the watchdog interval); every decision it makes lives
 * here so it's testable via `bun test dna/cells/base/lib/` without a VM —
 * the same split fleet-probe/refresh use on the Mac side.
 *
 * Design: docs/proposals/jobs.html. The incident this contains: detached
 * harness runs wedging at zero output tokens, invisibly, for 23h
 * (delta-market, 2026-06-12).
 */

export type JobStatus = "queued" | "running" | "done" | "failed";

// The durable job record — /root/state/jobs/<id>.json, the source of truth.
// state/ is a `cells refresh` never-path, so these survive both refresh
// pushes and rollbacks.
export type JobRecord = {
  id: string;
  created_at: string;
  status: JobStatus;
  harness: string;
  timeout_seconds: number;
  // Spawn attempts so far (1 = first run). Retry policy is exactly one
  // retry, and only for stall/vanish — a leash overrun fails outright.
  attempts: number;
  // The transient systemd unit (cell-job-<id>-a<attempt>) the run lives in.
  // Its own cgroup is the restart-survival mechanism: a setsid'd child
  // stays in well-site's cgroup and dies with every routine service
  // restart (refresh, steward, `cells model`) — systemd's default
  // KillMode=control-group takes the whole group (caught live, 2026-06-13).
  // `systemctl kill` on the unit is also the clean whole-tree kill.
  unit?: string;
  // The unit's MainPID — liveness probe (kill -0). pgid is the legacy
  // setsid field from the first deploy; kept so old records still parse.
  pgid?: number;
  pid?: number;
  started_at?: string;
  finished_at?: string;
  exit_code?: number | null;
  ok?: boolean;
  // Failure class: stalled | leash | exit | vanished | spawn | unsupported
  reason?: string;
  // Set once the DO acks job_done — until then the runner re-sends the
  // completion every watchdog tick (supervisor→DO has no other
  // at-least-once machinery).
  notified_at?: string;
};

export const JOBS_DIR = "/root/state/jobs";
export const WATCH_TICK_MS = 30_000;
export const JOB_SUMMARY_CAP = 2048;

export function jobPaths(dir: string, id: string) {
  return {
    meta: `${dir}/${id}.json`,
    prompt: `${dir}/${id}.prompt`,
    out: `${dir}/${id}.out.jsonl`,
    err: `${dir}/${id}.err`,
    exit: `${dir}/${id}.exit`,
    result: `${dir}/${id}.result.txt`,
  };
}

// Stall window in watchdog ticks. claude-code and codex stream frames per
// token/step, so silence is meaningful fast; pi --print may buffer, so it
// gets double the window before we call it wedged.
export function stallLimitTicks(harness: string): number {
  return harness === "claude-code" || harness === "codex" ? 10 : 20;
}

export function leashLimitTicks(timeoutSeconds: number): number {
  return Math.max(2, Math.ceil((timeoutSeconds * 1000) / WATCH_TICK_MS));
}

// Unit name for one attempt. Job ids are [0-9A-Za-z_-] (validated both at
// the DO and at the frame handler), which is unit-name-safe.
export function jobUnitName(id: string, attempt: number): string {
  return `cell-job-${id}-a${attempt}`;
}

// Parse `systemctl show -p MainPID --value <unit>` output.
export function parseMainPid(raw: string): number | null {
  const n = Number(raw.trim().replace(/^MainPID=/, ""));
  return Number.isInteger(n) && n > 1 ? n : null;
}

// Build the body of the job's transient unit. The supervisor runs:
//   systemd-run --collect --quiet --unit=<unit> /bin/bash -lc <script>
// The unit's own cgroup detaches the run from well-site's lifetime
// (restarts are routine), and the script records the harness exit code to
// the .exit file: that file's existence IS completion — the run is not the
// supervisor's child, so there's no exit event to catch.
export function buildJobScript(
  harness: string,
  p: ReturnType<typeof jobPaths>,
): { ok: true; script: string } | { ok: false; error: string } {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  let pipeline: string;
  if (harness === "claude-code") {
    // Fresh session — never --resume the main id (the serialized-main wedge
    // is the incident class). --include-partial-messages is load-bearing for
    // the watchdog: without it stream-json emits a frame only per COMPLETED
    // assistant block, so a long job that streams tokens for minutes without
    // closing a block shows no byte growth and gets killed as stalled. The
    // persistent supervisor runs claude with the same flag for this reason.
    pipeline =
      `claude --print --output-format stream-json --verbose --include-partial-messages ` +
      `--permission-mode bypassPermissions < ${q(p.prompt)}`;
  } else if (harness === "codex") {
    // Fresh thread (no `resume`). --json emits item events per step.
    pipeline =
      `JOB_PROMPT=$(cat ${q(p.prompt)}); ` +
      `codex exec --json --skip-git-repo-check ` +
      `--dangerously-bypass-approvals-and-sandbox "$JOB_PROMPT"`;
  } else if (harness === "pi") {
    // Fresh session in a throwaway dir — same shape as the adapter's
    // no-mainRef fork. pi resolves provider config from cwd /root/.pi.
    //
    // pi-ai has NO env-var fallback for the openai-codex provider: the
    // codex-proxy EXTENSION is what authenticates it (it reads
    // OPENAI_CODEX_API_KEY and calls registerProvider with the proxy
    // baseUrl). Under `pi --print --session-dir <tmp>`, pi's automatic
    // extension discovery does NOT load it (discovery anchors away from
    // /root/.pi — proven on zero-advisor-testbuyer 2026-06-13: every pi job
    // died "No API key found for openai-codex" while claude-code jobs, which
    // read the bearer straight from the env, ran fine). Sourcing cells-env.sh
    // (below) puts the key in the env but that is necessary-not-sufficient —
    // the extension still has to load to consume it. So load it EXPLICITLY by
    // absolute path. Guard on existence so a pi cell somehow baked without it
    // still runs (it just won't have codex auth — same as before this fix).
    const codexProxyExt = "/root/.pi/extensions/codex-proxy/index.ts";
    pipeline =
      `JOB_PROMPT=$(cat ${q(p.prompt)}); ` +
      `PI_EXT=; [ -f ${codexProxyExt} ] && PI_EXT='-e ${codexProxyExt}'; ` +
      `pi --print $PI_EXT --session-dir ${q(`/tmp/job-session-${pathId(p)}`)} "$JOB_PROMPT"`;
  } else {
    return { ok: false, error: `jobs unsupported on harness ${harness} (v1)` };
  }
  const script =
    `export HOME=/root IS_SANDBOX=1; cd /root; ` +
    // A job runs in a `systemd-run` transient unit, which does NOT inherit
    // well-site's environment — so unlike a talk fork (spawned as a supervisor
    // child, inheriting its env), a job starts without the proxy bearer. Source
    // cells-env.sh to load it: OPENAI_CODEX_API_KEY for pi/codex, ANTHROPIC_OAUTH_TOKEN
    // for claude. Without this, every pi-cell background job (advisor self-config,
    // heartbeat drains) dies with "No API key found for openai-codex".
    `[ -r /etc/profile.d/cells-env.sh ] && . /etc/profile.d/cells-env.sh; ` +
    `${pipeline} > ${q(p.out)} 2> ${q(p.err)}; echo $? > ${q(p.exit)}`;
  return { ok: true, script };
}

function pathId(p: ReturnType<typeof jobPaths>): string {
  const m = p.meta.match(/([^/]+)\.json$/);
  return m ? m[1]! : "job";
}

// ---- watchdog ----
//
// One decision per running job per tick. Counted in TICKS, never wall-clock:
// timestamps lie across hibernate/restore (the guest clock wakes skewed
// until chrony steps), and a VM checkpoint freezes this counter together
// with the job process, so the count stays honest — the same reason the
// bridge heartbeat counts missed pings instead of comparing clocks.

export type WatchState = {
  lastBytes: number;
  stallTicks: number;
  totalTicks: number;
};

export const freshWatchState = (): WatchState => ({ lastBytes: 0, stallTicks: 0, totalTicks: 0 });

export type WatchObs = {
  exitFilePresent: boolean;
  pidAlive: boolean;
  // out + err sizes combined — stderr progress (tool noise, retries) is
  // progress too.
  bytes: number;
};

export type WatchAction =
  | { act: "finalize" }
  | { act: "wait"; state: WatchState }
  | { act: "kill"; reason: "stalled" | "leash"; retry: boolean }
  | { act: "vanished"; retry: boolean };

export function watchdogTick(
  rec: Pick<JobRecord, "attempts" | "harness" | "timeout_seconds">,
  obs: WatchObs,
  state: WatchState,
): WatchAction {
  // Exit file present = the wrapper ran to completion — the honest signal,
  // checked before liveness (the process is gone in both cases).
  if (obs.exitFilePresent) return { act: "finalize" };
  if (!obs.pidAlive) {
    // No exit file, no process: OOM kill, external kill, or a
    // restore-edge death. Retry once.
    return { act: "vanished", retry: rec.attempts < 2 };
  }
  const grew = obs.bytes > state.lastBytes;
  const next: WatchState = {
    lastBytes: obs.bytes,
    stallTicks: grew ? 0 : state.stallTicks + 1,
    totalTicks: state.totalTicks + 1,
  };
  if (next.totalTicks >= leashLimitTicks(rec.timeout_seconds)) {
    // Over the absolute budget — no retry; a second attempt would just
    // burn the same budget again.
    return { act: "kill", reason: "leash", retry: false };
  }
  if (next.stallTicks >= stallLimitTicks(rec.harness)) {
    // The zero-token wedge: process alive, output dead. Kill + retry once.
    return { act: "kill", reason: "stalled", retry: rec.attempts < 2 };
  }
  return { act: "wait", state: next };
}

// ---- result extraction ----

// Pull the final answer out of the harness's stdout stream. exitCode is the
// wrapper-recorded code; ok requires both a clean exit and a non-error
// terminal frame where the stream provides one.
export function extractJobResult(
  harness: string,
  outText: string,
  exitCode: number | null,
): { ok: boolean; text: string } {
  const cleanExit = exitCode === 0;
  if (harness === "claude-code") {
    // stream-json: the terminal frame is {"type":"result","subtype":
    // "success"|..., "result": "...", "is_error": bool}. Fall back to
    // assistant text blocks if the run died before the result frame.
    let result: { ok: boolean; text: string } | null = null;
    const assistant: string[] = [];
    for (const line of outText.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      let f: any;
      try { f = JSON.parse(t); } catch { continue; }
      if (f?.type === "result") {
        result = {
          ok: f.subtype === "success" && !f.is_error,
          text: typeof f.result === "string" ? f.result : JSON.stringify(f.result ?? ""),
        };
      } else if (f?.type === "assistant" && Array.isArray(f?.message?.content)) {
        for (const block of f.message.content) {
          if (block?.type === "text" && typeof block.text === "string") assistant.push(block.text);
        }
      }
    }
    if (result) return { ok: cleanExit && result.ok, text: result.text };
    return { ok: false, text: assistant.join("\n").trim() || tailOf(outText) };
  }
  if (harness === "codex") {
    // --json: item.completed {item:{type:"agent_message", text}} carries the
    // answer; turn.completed = clean end, turn.failed carries the error.
    const messages: string[] = [];
    let completed = false;
    let failed = "";
    for (const line of outText.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      let f: any;
      try { f = JSON.parse(t); } catch { continue; }
      if (f?.type === "item.completed" && f?.item?.type === "agent_message" && typeof f.item.text === "string") {
        messages.push(f.item.text);
      } else if (f?.type === "turn.completed") {
        completed = true;
      } else if (f?.type === "turn.failed") {
        failed = typeof f?.error?.message === "string" ? f.error.message : "turn.failed";
      }
    }
    if (failed) return { ok: false, text: failed };
    return { ok: cleanExit && completed, text: messages.join("\n").trim() || tailOf(outText) };
  }
  // pi & friends: plain stdout; the exit code is the only verdict.
  return { ok: cleanExit, text: outText.trim() };
}

function tailOf(s: string): string {
  const t = s.trim();
  return t.length <= 1000 ? t : t.slice(-1000);
}

export function summarize(text: string): string {
  return text.slice(0, JOB_SUMMARY_CAP);
}

// Hydration guard for records read back from disk — a torn write or a
// hand-edited file must not crash the adoption sweep.
export function parseJobRecord(raw: string): JobRecord | null {
  let j: any;
  try { j = JSON.parse(raw); } catch { return null; }
  if (typeof j?.id !== "string" || !j.id) return null;
  if (!["queued", "running", "done", "failed"].includes(j.status)) return null;
  return {
    id: j.id,
    created_at: typeof j.created_at === "string" ? j.created_at : "",
    status: j.status,
    harness: typeof j.harness === "string" ? j.harness : "",
    timeout_seconds: Number.isFinite(j.timeout_seconds) ? j.timeout_seconds : 3600,
    attempts: Number.isInteger(j.attempts) ? j.attempts : 1,
    ...(typeof j.unit === "string" && j.unit ? { unit: j.unit } : {}),
    ...(Number.isInteger(j.pgid) ? { pgid: j.pgid } : {}),
    ...(Number.isInteger(j.pid) ? { pid: j.pid } : {}),
    ...(typeof j.started_at === "string" ? { started_at: j.started_at } : {}),
    ...(typeof j.finished_at === "string" ? { finished_at: j.finished_at } : {}),
    ...(j.exit_code === null || Number.isInteger(j.exit_code) ? { exit_code: j.exit_code } : {}),
    ...(typeof j.ok === "boolean" ? { ok: j.ok } : {}),
    ...(typeof j.reason === "string" ? { reason: j.reason } : {}),
    ...(typeof j.notified_at === "string" ? { notified_at: j.notified_at } : {}),
  };
}
