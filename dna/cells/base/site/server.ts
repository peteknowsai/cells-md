/**
 * cell site server (v2) — supervises pi, bridges it to Slack, and
 * publishes the cell's website.
 *
 * Three responsibilities:
 *
 *  1. Site publishing — the cell's website lives in public/. This server
 *     pushes a snapshot of it up to the per-cell Worker (on boot, and
 *     debounced on any change under public/). The Worker serves
 *     <name>.cells.md from that snapshot, so the site stays up even
 *     while the cell sleeps or hibernates — availability is decoupled
 *     from cell liveness. public/ is also served locally at / for
 *     in-cell preview.
 *  2. WebSocket bridge at /agent
 *     - The cell Worker (Cloudflare DO) opens an outbound WS to this
 *       server and holds it open. That inbound TCP keeps the well
 *       warm continuously (per sprites.dev hibernation rules).
 *     - We spawn `pi --mode rpc` as a child process. WS frames going
 *       down become lines on pi's stdin (e.g. {type:"prompt"}). Pi's
 *       stdout JSONL events go up to the WS client unchanged.
 *
 * Pi has no idea Slack exists. It just runs in RPC mode emitting its
 * normal event stream; the cell-Worker DO renders that into Slack
 * messages. No slack_post tool, no skill enforcement, no safety-net
 * session-tail. The bridge is the only delivery path.
 *
 * Auth: WS upgrade + site publish both require
 * Authorization: Bearer <CELLS_PROXY_SECRET>.
 */

import { type Subprocess, spawn } from "bun";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync,
  unlinkSync, watch, writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter, turnLeashMs, type AdapterHost, type HarnessAdapter } from "../lib/harness-adapters";
import { isInsideDir } from "../lib/path-guard";
import { MIME, collectSiteFiles } from "../lib/site-files";
import {
  buildJobScript, extractJobResult, freshWatchState, jobPaths, jobUnitName,
  JOBS_DIR, parseJobRecord, parseMainPid, sessionTargetHonorable, summarize, watchdogTick,
  WATCH_TICK_MS, type JobRecord, type WatchState,
} from "../lib/jobs";

const PORT = Number(process.env.PORT ?? 8080);
const NAME = process.env.CELL_NAME ?? "unknown";
const SECRET = process.env.CELLS_PROXY_SECRET ?? "";
const HOME = process.env.HOME ?? "/root";

// Wells bridge gateway (from inside the VM). host.well resolves to the host
// 192.168.64.1; welld serves cooperation endpoints on :7879.
const HOST_WELL = process.env.HOST_WELL_URL ?? "http://host.well:7879";

// Harness baked at birth — pi | claude-code | codex. Read from status.json
// (bake-egg writes it). Defaults to pi for safety.
function readHarness(): string {
  try {
    const j = JSON.parse(readFileSync(`${HOME}/.pi/status.json`, "utf8"));
    return typeof j?.harness === "string" ? j.harness : "pi";
  } catch { return "pi"; }
}
const HARNESS = readHarness();
const ADAPTER: HarnessAdapter = getAdapter(HARNESS);
// Whether THIS cell runs jobs through genuine interactive Claude Code
// (cc_entrypoint=cli → interactive billing pool, not the metered Agent-SDK
// credit), which also makes the --session fork/main targets meaningful.
// DEFAULT-ON for claude-code as of the fleet rollout (2026-06-15); opt OUT with
// CELLS_JOBS_INTERACTIVE=0. The SAME value is advertised in bridge_hello (so the
// CLI's capability gate matches reality) and used to gate startJobAttempt.
const JOBS_INTERACTIVE = HARNESS === "claude-code" && process.env.CELLS_JOBS_INTERACTIVE !== "0";

// Stable per-cell session file (pi). Pin pi to this on every spawn so
// conversations survive pi restarts. claude/codex use their own birth-time
// cached ids (see CLAUDE_MAIN_ID / CODEX_MAIN_THREAD below).
const SESSION_DIR = `${HOME}/.pi/agent/sessions/root-${NAME}`;
const SESSION_FILE = `${SESSION_DIR}/main.jsonl`;
mkdirSync(SESSION_DIR, { recursive: true });

// claude-code / codex resume ids captured at birth (bake-egg.sh). Empty
// string if missing — the harness will start a fresh session on spawn and
// the supervisor logs a warning. Read fresh at every use, NOT cached in a
// module const: a session swap (minting a new main after a wedge) used to
// leave the supervisor resuming the stale in-memory id until a service
// restart (homezero, 2026-06-13).
function readIdCache(path: string): string {
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}
const claudeMainId = () =>
  HARNESS === "claude-code" ? readIdCache("/root/.cell/claude-main-session") : "";
const codexMainThread = () =>
  HARNESS === "codex" ? readIdCache("/root/.cell/codex-main-thread") : "";

// Per-harness reference to the cell's main session, passed to the adapter's
// forkAndAsk. Format is harness-specific (see HarnessAdapter doc).
function getMainRef(): string {
  if (HARNESS === "pi") return SESSION_FILE;
  if (HARNESS === "claude-code") return claudeMainId();
  if (HARNESS === "codex") return codexMainThread();
  return "";
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");

// MIME + collectSiteFiles live in ../lib/site-files (imported above) so the
// publish-collect containment defense is unit-testable without booting this
// server.

function defaultHome(): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${NAME}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A7%AC%3C/text%3E%3C/svg%3E">
<style>
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif;
         max-width: 640px; margin: 4em auto; padding: 0 1em;
         color: #ddd; background: #111; }
  h1 { font-size: 2em; margin: 0 0 0.2em; }
  .sub { color: #888; }
  code { background: #8881; padding: 0.1em 0.4em; border-radius: 3px; }
  a { color: inherit; }
</style>
<body>
  <h1>🧬 ${NAME}</h1>
  <p class="sub">A living cell.</p>
  <p>This page is served by ${NAME} itself — not by mother.</p>
  <p><a href="https://mother.cells.md/">← fleet</a></p>
  <!--
    The cells-front Worker strips anything wearing the data-private
    attribute before sending HTML to anonymous visitors, and injects
    a Clerk sign-in widget into every page. Anything inside the block
    below is visible only to signed-in users — single sign-on across
    every cell on .cells.md. This is the editorial convention an
    agent uses to gate the private parts of its site.
  -->
  <div data-private style="margin-top:2em;padding:1em;border:1px dashed #444;border-radius:6px">
    <p class="sub">🔓 You're signed in.</p>
    <p>This block is wrapped in <code>&lt;div data-private&gt;</code> —
       anonymous visitors never see it.</p>
    <p><a href="/private">→ View private content</a></p>
  </div>
</body>
</html>`;
}

// The private companion to defaultHome(). Anonymous visitors hitting
// /private get a near-empty body — every element here is inside a
// [data-private] wrapper, so the Worker's HTMLRewriter strips them all
// at the edge. Signed-in visitors see the full page. This is the
// "private site" the agent (and human) can extend by editing public/
// or writing additional [data-private]-wrapped HTML.
function defaultPrivate(): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${NAME} · private</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%94%92%3C/text%3E%3C/svg%3E">
<style>
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif;
         max-width: 640px; margin: 4em auto; padding: 0 1em;
         color: #ddd; background: #111; }
  h1 { font-size: 2em; margin: 0 0 0.2em; }
  .sub { color: #888; }
  code { background: #8881; padding: 0.1em 0.4em; border-radius: 3px; }
  a { color: inherit; }
</style>
<body>
  <div data-private>
    <h1>🔒 ${NAME} · private</h1>
    <p class="sub">A signed-in-only view.</p>
    <p>You're seeing this because you're signed in. To an anonymous
       visitor this page renders as an empty body — every element here
       sits inside <code>&lt;div data-private&gt;</code>, which the
       edge Worker strips before the response leaves Cloudflare.</p>
    <p>The agent edits this page (and the public home) over time —
       wrap any block in <code>&lt;div data-private&gt;</code> and it's
       gated. Treat it like an editorial convention, not a security
       feature: the gating is the bit-stripping, not access control on
       the agent itself.</p>
    <p><a href="/">← back to public home</a></p>
  </div>
</body>
</html>`;
}

function serveStatic(pathname: string): Response | null {
  if (!existsSync(PUBLIC_DIR)) return null;
  const rel = pathname === "/" ? "/index.html" : pathname;
  const path = join(PUBLIC_DIR, rel);
  // Containment guard: join() collapses `..`, but a request like
  // `/../public-secrets/x` could still resolve to a sibling sharing the
  // PUBLIC_DIR name prefix. isInsideDir's separator check refuses it.
  if (!isInsideDir(PUBLIC_DIR, path)) return null;
  if (!existsSync(path)) return null;
  const ext = path.slice(path.lastIndexOf("."));
  const mime = MIME[ext] ?? "application/octet-stream";
  return new Response(readFileSync(path), { headers: { "content-type": mime } });
}

// ---------------------------------------------------------------------------
// Harness supervisor — adapter-driven (pi, claude-code, codex)
// ---------------------------------------------------------------------------
//
// The supervisor owns process lifecycle (spawn / respawn / per-turn spawn)
// and the cell-side spawn argv. Translation in both directions lives in the
// adapter (dna/cells/base/lib/harness-adapters.ts), so the cell Worker DO
// upstream sees only the pi event vocabulary — the harness flavour is
// invisible to anything past the supervisor.

// Persistent-harness state (pi, claude-code). null for per-turn (codex).
let harnessProc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
let harnessStdoutBuffer = "";
let harnessRespawnTimer: Timer | null = null;
// Race-tolerance: spawnHarness() returns immediately, but pi's setup +
// claude's first system/init take a few hundred ms. A `prompt` arriving in
// that window can land before the harness is steerable. Track readiness;
// queue pre-ready prompts and flush after the adapter flips ready.
let harnessReady = false;
const pendingPrompts: object[] = [];
const HARNESS_RESPAWN_DELAY_MS = 1000;

// Per-turn harness state (codex). turnInFlight gates one process at a time;
// concurrent prompts queue and drain in order.
let turnProc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
let turnInFlight = false;
const pendingTurns: string[] = [];

// AdapterHost shim — adapters read/write codexThreadId / awaitingSwitchAck /
// hermesSessionId here, and call writeLine/log/err/onPiSetupAcked on us.
const hostState: AdapterHost = {
  codexThreadId: HARNESS === "codex" ? (codexMainThread() || null) : null,
  awaitingSwitchAck: null,
  hermesSessionId: null,
  writeLine: (line) => writeToHarness(line),
  log: (msg) => console.log(`[bridge] ${msg}`),
  err: (msg) => console.error(`[bridge] ${msg}`),
  onPiSetupAcked: () => onHarnessReady(),
};

// ---------------------------------------------------------------------------
// Bridge WebSocket — outbound to the cell Worker.
//
// Post-direction-flip (2026-05-22): the supervisor dials OUT to
// wss://<cell>.cells.md/agent and the cell Worker's Durable Object accepts.
// This reverses the pre-flip arrangement (the DO dialed in to
// <well>.cells.md/agent through the cloudflared tunnel + proxy) and
// collapses the second hostname, the tunnel hop, and the proxy's
// well-routing. A hibernated cell holds no connection; the DO rings a
// doorbell (proxy.cells.md/wake) so welld wakes us, then we dial back in.
// ---------------------------------------------------------------------------

const BRIDGE_URL = `wss://${NAME}.cells.md/agent`;
const BRIDGE_RECONNECT_MIN_MS = 1_000;
const BRIDGE_RECONNECT_MAX_MS = 30_000;
// A dial that never opens also won't surface close/error for a long time —
// an OS TCP connect can stall for minutes, and the first dial after a
// hibernation thaw (before the guest's networking is warm) is exactly when
// it does. Bound it: abort a dial that hasn't opened within this window, so
// the `bridgeConnecting` latch can't wedge every reconnect path forever.
const BRIDGE_CONNECT_TIMEOUT_MS = 12_000;
// Heartbeat. The well hibernates and thaws; when it does the bridge WS
// dies, but Bun's WebSocket won't reliably surface a `close` on an idle
// socket — the supervisor would sit on a zombie connection forever. So
// every BRIDGE_PING_MS we ping; the DO auto-answers with a pong via
// setWebSocketAutoResponse (without un-hibernating). We count heartbeats
// that saw no frame come back — BRIDGE_MAX_MISSED in a row means the
// socket is dead, reconnect. A *count* (not a wall-clock delta) so a
// post-thaw clock skew can't mask the staleness.
const BRIDGE_PING_MS = 15_000;
const BRIDGE_MAX_MISSED = 3;
const BRIDGE_PING_FRAME = JSON.stringify({ type: "ping" });

let bridgeWs: WebSocket | null = null;
let bridgeConnecting = false;
let bridgeReconnectMs = BRIDGE_RECONNECT_MIN_MS;
let bridgeReconnectTimer: Timer | null = null;
// Heartbeat liveness: a frame (any frame, pong included) arrived since the
// last tick? Cleared each tick; consecutive misses → zombie.
let bridgeSawFrame = false;
let bridgeMissedPings = 0;

// ---------------------------------------------------------------------------
// Lifecycle signaling.
//
// The cell reports *state* to welld's bridge gateway (host.well:7879) — it
// never commands hibernation:
//
//   POST /lifecycle {state:"busy"|"idle"}   busy = an agent turn is in
//                                            flight; idle = none. welld's
//                                            watchdog is the SOLE decider of
//                                            when an idle cell hibernates —
//                                            it alone weighs this signal
//                                            against the never-sleep pin,
//                                            seal-readiness and activity.
//
// One signal, one decider (hibernation model, invariant 2). The cell used to
// also POST /sleep — an imperative "hibernate me now" — but welld's /sleep
// hibernated unconditionally, bypassing the pin, so a pinned always-on cell
// could hibernate itself. Removed: welld owns the decision; the cell's whole
// hibernation vocabulary is busy/idle.
//
// Fire-and-forget; failures are logged and swallowed so older welld builds
// (or transient hiccups) don't break the cell.
// ---------------------------------------------------------------------------

let lastLifecycleState: "busy" | "idle" | null = null;

async function signalLifecycle(state: "busy" | "idle") {
  if (lastLifecycleState === state) return;
  lastLifecycleState = state;
  try {
    await fetch(`${HOST_WELL}/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(2000),
    });
  } catch (e) {
    console.error(`[bridge] lifecycle ${state} signal failed: ${String(e).slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------------------
// Jobs lane — durable background work (docs/proposals/jobs.html).
//
// A `job` frame from the DO becomes a job file under /root/state/jobs/ (the
// durable ack `job_accepted` fires only after that write), then a DETACHED
// fresh-session harness run in its own transient systemd unit — survives
// well-site restarts (the unit's cgroup outlives this service), never
// --resume'ing the main session (the serialized-main wedge is the incident
// class this lane exists to contain). A 30s watchdog counts ticks without
// output growth: a wedged-at-zero-tokens process gets killed and retried
// once, then durably marked failed. Completion flows back to the DO as
// `job_done`, re-sent every tick until `job_done_ack` — the supervisor→DO
// direction has no other at-least-once machinery.
// ---------------------------------------------------------------------------

// id → watchdog state for jobs this supervisor is watching. Rebuilt from
// the job files at boot (adoptJobs) — restarts are routine.
const runningJobs = new Map<string, WatchState>();
// Terminal jobs whose job_done the DO hasn't acked yet.
const unnotifiedDones = new Set<string>();
// Mirror of the DO-side id rule — ids become filenames here.
const JOB_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{7,39}$/;

// Jobs hold the cell awake. welld's watchdog only sees the busy/idle
// signal, and a detached job process is invisible to it — without this
// gate the VM gets checkpointed mid-job.
function signalIdleIfQuiet() {
  if (runningJobs.size === 0) void signalLifecycle("idle");
}

function loadJobRecord(id: string): JobRecord | null {
  try { return parseJobRecord(readFileSync(jobPaths(JOBS_DIR, id).meta, "utf8")); }
  catch { return null; }
}

function saveJobRecord(rec: JobRecord) {
  const meta = jobPaths(JOBS_DIR, rec.id).meta;
  writeFileSync(`${meta}.tmp`, JSON.stringify(rec, null, 2));
  renameSync(`${meta}.tmp`, meta);
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; }
}

// Is the job's transient unit still alive? systemd is the source of truth
// for the cgroup, so this — not a possibly-racing MainPID — is the liveness
// signal. "activating"/"active"/"deactivating" all mean the run hasn't
// exited; "inactive"/"failed"/missing mean it's gone. Synchronous so the
// watchdog stays a simple per-tick pass.
function jobUnitAlive(unit: string): boolean {
  try {
    const r = Bun.spawnSync(["systemctl", "is-active", unit], { stdout: "pipe", stderr: "ignore" });
    const out = r.stdout.toString().trim();
    return out === "active" || out === "activating" || out === "deactivating";
  } catch {
    return false;
  }
}

// Whether the run behind a record is still alive. Prefer the unit (the
// cgroup truth); fall back to the pid for pre-unit records.
function jobRunAlive(rec: JobRecord): boolean {
  if (rec.unit) return jobUnitAlive(rec.unit);
  if (rec.pid) return pidAlive(rec.pid);
  return false;
}

// Kill the job's run and WAIT for the cgroup to actually die before
// returning. The retry path truncates the shared .out/.err files and
// launches the next attempt — if the old harness is still alive it would
// keep writing into them, interleaving two attempts' output (codex P2).
async function killJobRun(rec: JobRecord): Promise<void> {
  if (rec.unit) {
    // The transient unit's cgroup is the whole job tree — systemctl kill
    // takes harness + children in one shot. NEVER fall through to the raw
    // pid kill for a unit-backed record: a vanished unit's saved pid may
    // already have been recycled by an unrelated root process (codex P2).
    try { spawn(["systemctl", "kill", "--signal=SIGKILL", rec.unit], { stdout: "ignore", stderr: "ignore" }); } catch {}
    // An interactive job runs claude under a dedicated `tmux -L cell-job-<id>`
    // socket INSIDE the unit's cgroup, so systemctl kill reaps the server — but
    // SIGKILL skips the runner's cleanup trap, leaving the dead socket FILE
    // behind. Sweep it (id is JOB_ID_RE-validated, so no shell metachars; a
    // no-op for --print jobs that have no such socket).
    try { spawn(["bash", "-lc", `rm -f /tmp/tmux-*/cell-job-${rec.id}`], { stdout: "ignore", stderr: "ignore" }); } catch {}
    // Bounded wait (~3s) for systemd to reap the cgroup. If it somehow
    // outlives this, the next attempt still uses a DIFFERENT unit name, so
    // only the shared files overlap — acceptable worst case after the wait.
    for (let i = 0; i < 20; i++) {
      if (!jobUnitAlive(rec.unit)) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    return;
  }
  // Legacy (pre-unit setsid) records only: the pid/pgid IS the handle.
  if (rec.pgid) { try { process.kill(-rec.pgid, "SIGKILL"); } catch {} }
  if (rec.pid) { try { process.kill(rec.pid, "SIGKILL"); } catch {} }
}

// A `job` frame arrived over the bridge. Durable-write-then-ack: the job
// file is the dedupe (at-least-once delivery re-sends across reconnects),
// so a duplicate just re-acks.
async function handleJobFrame(cmd: any): Promise<void> {
  const id = typeof cmd?.id === "string" ? cmd.id : "";
  if (!JOB_ID_RE.test(id)) {
    console.error(`[jobs] dropping job frame with bad id: ${String(cmd?.id).slice(0, 40)}`);
    return;
  }
  const existing = loadJobRecord(id);
  if (existing) {
    broadcastToClients(JSON.stringify({ type: "job_accepted", id }));
    return;
  }
  const prompt = typeof cmd.prompt === "string" ? cmd.prompt : "";
  if (!prompt.trim()) {
    console.error(`[jobs] job ${id} has no prompt — dropping`);
    return;
  }
  const timeoutS =
    typeof cmd.timeout_seconds === "number" && Number.isFinite(cmd.timeout_seconds)
      ? Math.max(60, Math.min(86_400, Math.round(cmd.timeout_seconds)))
      : 3600;
  mkdirSync(JOBS_DIR, { recursive: true });
  const p = jobPaths(JOBS_DIR, id);
  writeFileSync(p.prompt, prompt);
  const st = cmd.session_target;
  const rec: JobRecord = {
    id,
    created_at: new Date().toISOString(),
    status: "queued",
    harness: HARNESS,
    timeout_seconds: timeoutS,
    attempts: 0,
    ...(st === "fresh" || st === "fork" || st === "main" ? { session_target: st } : {}),
  };
  saveJobRecord(rec);
  broadcastToClients(JSON.stringify({ type: "job_accepted", id }));
  console.log(`[jobs] ${id} accepted (${prompt.length}B, timeout=${timeoutS}s)`);
  await startJobAttempt(rec);
}

// Spawn one (re)attempt as a transient systemd unit. Its own cgroup is
// what survives well-site restarts — a setsid'd child stays in this
// service's cgroup and systemd's KillMode=control-group takes it down on
// every routine restart (caught live, 2026-06-13). --collect reaps the
// unit on exit either way; the .exit file the script writes is the
// completion signal (the run is not our child).
async function startJobAttempt(rec: JobRecord): Promise<void> {
  const p = jobPaths(JOBS_DIR, rec.id);
  rec.attempts += 1;
  // Genuine interactive Claude Code (cc_entrypoint=cli → interactive billing
  // pool, not the metered Agent-SDK credit) when enabled for this cell. The
  // same value the supervisor advertises in bridge_hello, so the CLI's gate and
  // this launch path agree; fork/main are honored only here (--print is fresh).
  const interactive = JOBS_INTERACTIVE;
  // A non-fresh session target (fork) is honored ONLY on the interactive
  // claude-code runner. If this cell can't honor it — interactive disabled (the
  // rollout default) or a non-claude-code harness — FAIL LOUDLY rather than let
  // buildJobScript fall through to the --print path, which is always fresh: a
  // silently-fresh job that reported success is the wrong-context trap.
  if (!sessionTargetHonorable(rec.session_target, interactive)) {
    finalizeJob(rec, {
      ok: false,
      text: `--session ${rec.session_target} needs the interactive runner (a claude-code cell with CELLS_JOBS_INTERACTIVE=1), which is not enabled here. Re-run with --session fresh, or enable interactive jobs on this cell.`,
      reason: "unsupported",
      exitCode: null,
    });
    return;
  }
  const built = buildJobScript(rec.harness, p, {
    interactive,
    timeoutSeconds: rec.timeout_seconds,
    ...(rec.session_target ? { sessionTarget: rec.session_target } : {}),
  });
  if (!built.ok) {
    finalizeJob(rec, { ok: false, text: built.error, reason: "unsupported", exitCode: null });
    return;
  }
  // Clear prior-attempt artifacts so the watchdog and finalize read this run.
  // The stale pid from a previous attempt MUST go — left set, the watchdog
  // could probe a recycled pid and misjudge liveness (codex P2).
  for (const stale of [p.exit]) { try { unlinkSync(stale); } catch {} }
  for (const trunc of [p.out, p.err]) { try { writeFileSync(trunc, ""); } catch {} }
  delete rec.pid;
  const unit = jobUnitName(rec.id, rec.attempts);
  rec.unit = unit;
  rec.status = "running";
  rec.started_at = new Date().toISOString();
  // Persist running+unit BEFORE the spawn: a well-site crash between
  // systemd-run starting the unit and a later save would otherwise leave a
  // live unit behind a record still reading "queued", and adoption would
  // launch a DUPLICATE (codex P2). With the record already running+unit,
  // adoption re-watches and the watchdog reconciles via the unit's own
  // state. A queued record now unambiguously means "never spawned".
  saveJobRecord(rec);
  try {
    const run = spawn(
      ["systemd-run", "--collect", "--quiet", `--unit=${unit}`, "/bin/bash", "-lc", built.script],
      { cwd: "/root", stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const code = await run.exited;
    if (code !== 0) {
      const err = await new Response(run.stderr).text();
      finalizeJob(rec, { ok: false, text: `systemd-run exited ${code}: ${err.slice(0, 300)}`, reason: "spawn", exitCode: null });
      return;
    }
  } catch (e) {
    finalizeJob(rec, { ok: false, text: `job spawn threw: ${String(e).slice(0, 300)}`, reason: "spawn", exitCode: null });
    return;
  }
  // The record is already saved as running+unit (before the spawn). The
  // unit IS the liveness source of truth (its cgroup), so the watchdog
  // probes the unit, not a pid that may not have resolved yet. Best-effort
  // MainPID is a nicety for logs + the legacy kill belt; poll briefly since
  // it can read 0 in the first moments before the harness is exec'd, then
  // persist it so adoption after a restart has it too.
  for (let i = 0; i < 3; i++) {
    try {
      const show = spawn(["systemctl", "show", "-p", "MainPID", "--value", unit], { stdout: "pipe", stderr: "ignore" });
      const pid = parseMainPid(await new Response(show.stdout).text());
      if (pid) { rec.pid = pid; break; }
    } catch {}
    // A fast job may already be inactive (unit collected) — stop polling.
    if (!jobUnitAlive(unit)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (rec.pid) saveJobRecord(rec);
  runningJobs.set(rec.id, freshWatchState());
  void signalLifecycle("busy");
  console.log(`[jobs] ${rec.id} attempt ${rec.attempts} running (unit=${unit} pid=${rec.pid ?? "?"})`);
}

// Terminal transition + durable result + completion frame.
function finalizeJob(
  rec: JobRecord,
  outcome: { ok: boolean; text: string; reason?: string; exitCode: number | null },
) {
  const p = jobPaths(JOBS_DIR, rec.id);
  try { writeFileSync(p.result, outcome.text); } catch {}
  rec.status = outcome.ok ? "done" : "failed";
  rec.ok = outcome.ok;
  rec.exit_code = outcome.exitCode;
  rec.finished_at = new Date().toISOString();
  if (!outcome.ok && outcome.reason) rec.reason = outcome.reason;
  saveJobRecord(rec);
  runningJobs.delete(rec.id);
  unnotifiedDones.add(rec.id);
  sendJobDone(rec);
  if (!mainSessionBusy) signalIdleIfQuiet();
  console.log(`[jobs] ${rec.id} ${rec.status}${rec.reason ? ` (${rec.reason})` : ""} after ${rec.attempts} attempt(s)`);
}

// The wrapper's .exit file appeared — read the verdict out of the stream.
function finalizeFromFiles(rec: JobRecord) {
  const p = jobPaths(JOBS_DIR, rec.id);
  let exitCode: number | null = null;
  try {
    const n = parseInt(readFileSync(p.exit, "utf8").trim(), 10);
    if (Number.isInteger(n)) exitCode = n;
  } catch {}
  let outText = "";
  try { outText = readFileSync(p.out, "utf8"); } catch {}
  const r = extractJobResult(rec.harness, outText, exitCode);
  // A failed run with silent stdout (auth errors, spawn-time refusals)
  // explains itself only on stderr — surface that tail in the result so
  // `cells jobs` answers "why" without SSH archaeology.
  let text = r.text;
  if (!r.ok && !text.trim()) {
    try { text = readFileSync(p.err, "utf8").trim().slice(-1000); } catch {}
  }
  finalizeJob(rec, {
    ok: r.ok,
    text,
    ...(r.ok ? {} : { reason: "exit" }),
    exitCode,
  });
}

function sendJobDone(rec: JobRecord) {
  let resultText = "";
  try { resultText = readFileSync(jobPaths(JOBS_DIR, rec.id).result, "utf8"); } catch {}
  broadcastToClients(JSON.stringify({
    type: "job_done",
    id: rec.id,
    ok: rec.ok === true,
    summary: summarize(resultText),
    finished_at: rec.finished_at ?? "",
  }));
}

// One watchdog pass. Tick-counted, not wall-clock — timestamps lie across
// hibernate/restore, and a checkpoint freezes this interval together with
// the job process, so the count stays honest.
function jobsWatchdogTick() {
  for (const [id, state] of runningJobs) {
    const rec = loadJobRecord(id);
    if (!rec || rec.status !== "running") { runningJobs.delete(id); continue; }
    const p = jobPaths(JOBS_DIR, id);
    const action = watchdogTick(rec, {
      exitFilePresent: existsSync(p.exit),
      pidAlive: jobRunAlive(rec),
      bytes: fileSize(p.out) + fileSize(p.err),
    }, state);
    if (action.act === "finalize") {
      finalizeFromFiles(rec);
    } else if (action.act === "wait") {
      runningJobs.set(id, action.state);
    } else if (action.act === "kill") {
      // Delete from runningJobs synchronously so the next tick (the kill
      // wait spans ticks) doesn't re-handle this job. The kill is AWAITED
      // before the retry truncates the shared files + spawns, so the old
      // and new attempts can't interleave output.
      runningJobs.delete(id);
      void (async () => {
        await killJobRun(rec);
        // The job may have exited cleanly in the kill-wait window — honor a
        // real completion instead of discarding it for a retry (codex P2).
        if (existsSync(p.exit)) { finalizeFromFiles(rec); return; }
        if (action.retry) {
          console.error(`[jobs] ${id} ${action.reason} (attempt ${rec.attempts}) — killed, retrying once`);
          await startJobAttempt(rec);
        } else {
          finalizeJob(rec, {
            ok: false,
            text: `[${action.reason}] no output progress within the ${action.reason === "leash" ? "job timeout" : "stall window"} — killed`,
            reason: action.reason,
            exitCode: null,
          });
        }
      })();
    } else if (action.act === "vanished") {
      // Process already gone (unit inactive, no exit file) — no kill to
      // wait on, but still confirm-kill any stray pid belt before retry.
      runningJobs.delete(id);
      void (async () => {
        await killJobRun(rec);
        // Same window: an exit file that appeared between the probe and now
        // is a real completion.
        if (existsSync(p.exit)) { finalizeFromFiles(rec); return; }
        if (action.retry) {
          console.error(`[jobs] ${id} process vanished (attempt ${rec.attempts}) — retrying once`);
          await startJobAttempt(rec);
        } else {
          finalizeJob(rec, { ok: false, text: "job process vanished (OOM kill or external)", reason: "vanished", exitCode: null });
        }
      })();
    }
  }
  // Completion is at-least-once toward the DO: re-send until acked.
  for (const id of unnotifiedDones) {
    const rec = loadJobRecord(id);
    if (!rec) { unnotifiedDones.delete(id); continue; }
    if (rec.notified_at) { unnotifiedDones.delete(id); continue; }
    sendJobDone(rec);
  }
}

// Boot-time re-adoption — well-site restarts are routine (refresh, steward,
// `cells model`), and the detached jobs outlive them. Nothing is orphaned:
// running jobs get re-watched, a never-spawned queued one starts, unacked
// completions resume re-sending. startJobAttempt persists running+unit
// BEFORE spawning, so a record reading "queued" here genuinely never
// spawned a unit — but we still probe for an already-live unit or a
// finished run before launching, belt-and-suspenders against duplicate work.
function adoptJobs() {
  mkdirSync(JOBS_DIR, { recursive: true });
  let files: string[] = [];
  try { files = readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json")); } catch { return; }
  for (const f of files) {
    const rec = loadJobRecord(f.slice(0, -5));
    if (!rec) continue;
    if (rec.status === "running") {
      runningJobs.set(rec.id, freshWatchState());
      console.log(`[jobs] adopted running job ${rec.id} (unit=${rec.unit ?? "?"})`);
    } else if (rec.status === "queued") {
      const p = jobPaths(JOBS_DIR, rec.id);
      // A unit/output/exit for the NEXT attempt name means a spawn already
      // happened (in-memory gap before the running save) — adopt it as
      // running instead of launching a duplicate.
      const nextUnit = jobUnitName(rec.id, rec.attempts + 1);
      if (existsSync(p.exit) || jobUnitAlive(nextUnit) || fileSize(p.out) > 0) {
        rec.attempts += 1;
        rec.unit = nextUnit;
        rec.status = "running";
        if (!rec.started_at) rec.started_at = new Date().toISOString();
        saveJobRecord(rec);
        runningJobs.set(rec.id, freshWatchState());
        console.log(`[jobs] adopted in-flight queued job ${rec.id} as running (unit=${nextUnit})`);
      } else {
        console.log(`[jobs] adopted queued job ${rec.id} — starting`);
        void startJobAttempt(rec);
      }
    } else if (!rec.notified_at) {
      unnotifiedDones.add(rec.id);
    }
  }
  if (runningJobs.size > 0) void signalLifecycle("busy");
}

// Send one pi-shaped event line up the bridge to the cell Worker DO.
// (Kept the "broadcast" name through the direction flip — there is now
// exactly one bridge, so this is a single send when it's up, a no-op
// when it isn't. A dropped frame is acceptable: the well is hibernating
// or reconnecting, and pi's session continuity is preserved on the well.)
function broadcastToClients(line: string) {
  if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
    try { bridgeWs.send(line); }
    catch (e) { console.error(`[bridge] ws send failed: ${String(e).slice(0, 120)}`); }
  }
}

// ── target=main: durable conversation turns ─────────────────────────
//
// A main-targeted envelope drives the cell's MAIN session instead of a
// throwaway fork, so the exchange persists in session history (peers and
// buyers get continuity instead of goldfish memory). The main session is
// single-threaded by nature: turns queue behind interactive use and each
// other. The reply is the text the session streams until agent_end; a
// leash (sized from the sender's budget) fails the turn loudly if the
// harness wedges, so the sender's long-poll never just evaporates.
type MainTurn = {
  corrId: string;
  from: string;
  text: string;
  leashMs: number;
  acc: string;
  timer?: ReturnType<typeof setTimeout>;
  startedAt?: number;
};
const mainQueue: MainTurn[] = [];
let activeMainTurn: MainTurn | null = null;
let mainSessionBusy = false; // any turn in flight — ours or interactive

function enqueueMainTurn(t: { corrId: string; from: string; text: string; leashMs: number }) {
  mainQueue.push({ ...t, acc: "" });
  pumpMainQueue();
}

function pumpMainQueue() {
  if (activeMainTurn || mainSessionBusy || mainQueue.length === 0 || !harnessReady) return;
  const turn = mainQueue.shift()!;
  activeMainTurn = turn;
  turn.startedAt = Date.now();
  turn.timer = setTimeout(() => {
    finishMainTurn(`[error] main turn timed out after ${Math.round(turn.leashMs / 1000)}s`);
  }, turn.leashMs);
  console.log(`[bridge] main turn start corr=${turn.corrId.slice(0, 10)} from=${turn.from} leash=${Math.round(turn.leashMs / 1000)}s`);
  // Same path an interactive client prompt takes — busy signal, ready
  // buffering, per-turn vs persistent dispatch all included. The prefix
  // tells the cell who's speaking; the session records it verbatim.
  handleBridgeFrame(
    JSON.stringify({
      type: "prompt",
      message: `[message from ${turn.from} — your reply goes back to them] ${turn.text}`,
    }),
  );
}

function finishMainTurn(text: string) {
  const turn = activeMainTurn;
  if (!turn) return;
  activeMainTurn = null;
  if (turn.timer) clearTimeout(turn.timer);
  const dt = turn.startedAt ? Date.now() - turn.startedAt : 0;
  console.log(`[bridge] main turn end corr=${turn.corrId.slice(0, 10)} dt=${dt}ms text=${text.slice(0, 100).replace(/\n/g, " ")}`);
  broadcastToClients(JSON.stringify({ type: "agent_response", in_reply_to: turn.corrId, text }));
  pumpMainQueue();
}

// One translated pi-shaped event line — broadcast to WS clients and sniff
// for agent_end → idle lifecycle. agent_start is pi-only (passthrough); the
// busy signal fires at WS-prompt-receive time for uniform coverage across
// all three harnesses. Main-turn accounting taps the same stream: text
// deltas accumulate into the active main turn, agent_end closes it.
function onTranslatedLine(line: string) {
  broadcastToClients(line);
  try {
    const evt = JSON.parse(line);
    if (evt?.type === "agent_end") {
      signalIdleIfQuiet();
      mainSessionBusy = false;
      if (activeMainTurn) {
        finishMainTurn(activeMainTurn.acc.trim() || "(empty reply)");
      } else {
        pumpMainQueue(); // an interactive turn just freed the session
      }
    } else if (evt?.type === "agent_start") {
      void signalLifecycle("busy");
      mainSessionBusy = true;
    } else if (
      activeMainTurn &&
      evt?.type === "message_update" &&
      evt.assistantMessageEvent?.type === "text_delta" &&
      typeof evt.assistantMessageEvent.delta === "string"
    ) {
      activeMainTurn.acc += evt.assistantMessageEvent.delta;
    }
  } catch { /* not JSON — already broadcast */ }
}

// One raw harness stdout line → adapter → broadcast each resulting line.
function onHarnessRawLine(line: string) {
  const { lines, ready } = ADAPTER.translateOutbound(hostState, line);
  for (const out of lines) onTranslatedLine(out);
  if (ready && !harnessReady) onHarnessReady();
}

function onHarnessStdoutChunk(chunk: string) {
  harnessStdoutBuffer += chunk;
  const lines = harnessStdoutBuffer.split("\n");
  harnessStdoutBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.trim()) continue;
    onHarnessRawLine(trimmed);
  }
}

async function pumpHarnessStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      onHarnessStdoutChunk(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    console.error(`[bridge] harness stdout reader error: ${String(e).slice(0, 200)}`);
  } finally {
    reader.releaseLock();
  }
}

async function pumpHarnessStderr(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) console.error(`[${HARNESS}-err] ${line}`);
      }
    }
  } catch (e) {
    console.error(`[bridge] harness stderr reader error: ${String(e).slice(0, 200)}`);
  } finally {
    reader.releaseLock();
  }
}

// Write one already-serialized line to the persistent harness's stdin.
// Bun's FileSink buffers writes; explicit flush keeps rapid back-to-back
// setup commands from arriving as one chunk pi's RPC dispatcher fumbles.
function writeToHarness(line: string): boolean {
  if (!harnessProc || harnessProc.stdin == null) return false;
  try {
    const sink = harnessProc.stdin as any;
    sink.write(line + "\n");
    if (typeof sink.flush === "function") sink.flush();
    return true;
  } catch (e) {
    console.error(`[bridge] harness stdin write failed: ${String(e).slice(0, 200)}`);
    return false;
  }
}

// Build cell-side spawn argv + env for the persistent harnesses. Returns
// null for codex (per-turn — runTurn() spawns one process per prompt).
function persistentSpawnArgs(): { cmd: string[]; env: Record<string, string> } | null {
  // HOME=/root: harnesses look for config under HOME (.pi/, .claude/, .codex/).
  // PATH: process.env already carries /etc/profile.d/cells-env.sh additions.
  const baseEnv = { ...process.env, HOME: "/root" } as Record<string, string>;
  if (HARNESS === "pi") {
    return {
      cmd: ["pi", "--mode", "rpc", "--session-dir", SESSION_DIR],
      env: baseEnv,
    };
  }
  if (HARNESS === "claude-code") {
    // --print + stream-json in/out keeps claude as a persistent multi-turn
    // process driven over stdin/stdout, the same shape host-bridge gives pi.
    // --resume pins to the birth-time main session id so every cell restart
    // continues the same conversation. IS_SANDBOX=1 satisfies claude's root +
    // bypassPermissions guard (the VM is the isolation boundary).
    const argv = [
      "claude", "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
    ];
    const mainId = claudeMainId();
    if (mainId) {
      argv.push("--resume", mainId);
    } else {
      console.error(`[bridge] claude-main-session cache missing — running without --resume; first turn creates a fresh session, conversation won't survive restarts`);
    }
    return {
      cmd: argv,
      env: { ...baseEnv, IS_SANDBOX: "1" },
    };
  }
  if (HARNESS === "hermes") {
    // hermes's TUI-gateway JSON-RPC server — a persistent stdio process, the
    // same one host-bridge spawns over SSH. `-u`: Python stdout to a pipe is
    // fully buffered, and a buffered gateway never flushes its gateway.ready
    // frame, so the handshake would hang. HERMES_PYTHON_SRC_ROOT makes the
    // gateway's in-process imports resolve. The session is opened by the
    // adapter handshake (translateOutbound), not here.
    const H = "/usr/local/lib/hermes-agent";
    return {
      cmd: [`${H}/venv/bin/python`, "-u", "-m", "tui_gateway.entry"],
      env: {
        ...baseEnv,
        TERMINAL_CWD: "/root",
        HERMES_HOME: "/root/.hermes",
        HERMES_PYTHON_SRC_ROOT: H,
        PYTHONUNBUFFERED: "1",
      },
    };
  }
  return null;
}

function spawnHarness() {
  if (harnessProc) return;
  if (ADAPTER.mode === "per-turn") {
    // No persistent process to spawn. Mark ready so prompts flow into runTurn().
    harnessReady = true;
    broadcastToClients(JSON.stringify({ type: "bridge_ready" }));
    const thread = codexMainThread();
    if (HARNESS === "codex" && !thread) {
      console.error(`[bridge] codex-main-thread cache missing — first turn creates a fresh thread, conversation won't survive restarts`);
    } else if (HARNESS === "codex") {
      console.log(`[bridge] codex per-turn ready (resuming thread ${thread.slice(0, 8)})`);
    }
    return;
  }
  const args = persistentSpawnArgs();
  if (!args) {
    console.error(`[bridge] no spawn args for harness=${HARNESS}`);
    return;
  }
  console.log(`[bridge] spawning ${HARNESS}`);
  harnessStdoutBuffer = "";
  harnessReady = false;
  harnessProc = spawn(args.cmd, {
    cwd: "/root",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: args.env,
  });

  void pumpHarnessStream(harnessProc.stdout!);
  void pumpHarnessStderr(harnessProc.stderr!);

  void harnessProc.exited.then((code) => {
    console.error(`[bridge] ${HARNESS} exited code=${code}; respawning in ${HARNESS_RESPAWN_DELAY_MS}ms`);
    harnessProc = null;
    // If the harness died mid-turn welld would otherwise wait forever for
    // agent_end. Force-clear busy so the well is hibernate-eligible —
    // unless a detached job still needs the cell awake.
    signalIdleIfQuiet();
    harnessRespawnTimer = setTimeout(() => {
      harnessRespawnTimer = null;
      spawnHarness();
    }, HARNESS_RESPAWN_DELAY_MS);
  });

  // Harness-specific ready handshake (pi sends switch_session; claude-code
  // flips ready immediately — it has no pre-input ready event). ~250ms
  // after spawn so the pipe is live.
  if (ADAPTER.startHandshake) {
    setTimeout(() => ADAPTER.startHandshake!(hostState, SESSION_DIR), 250);
  }
}

// Per-turn-harness driver (codex). One process per prompt; subsequent
// prompts queue and drain in order via the exited handler.
function runTurn(prompt: string) {
  if (turnInFlight) { pendingTurns.push(prompt); return; }
  turnInFlight = true;
  // codex exec [resume <id>] --json --skip-git-repo-check --dangerously-... <prompt>
  const argv = ["codex", "exec"];
  if (hostState.codexThreadId) argv.push("resume", hostState.codexThreadId);
  argv.push("--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt);
  const label = hostState.codexThreadId ? `resume ${hostState.codexThreadId.slice(0, 8)}` : "new thread";
  console.log(`[bridge] spawning codex turn (${label})`);
  turnProc = spawn(argv, {
    cwd: "/root",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: "/root" },
  });
  void pumpHarnessStream(turnProc.stdout!);
  void pumpHarnessStderr(turnProc.stderr!);
  void turnProc.exited.then((code) => {
    console.log(`[bridge] codex turn exited code=${code}`);
    turnProc = null;
    turnInFlight = false;
    // `codex exec` exits 0 even on turn.failed (the failure rides the event
    // stream). Non-zero is an ssh/spawn failure — surface so the client isn't
    // left hanging on a turn that never reported back.
    if (code !== 0) {
      broadcastToClients(JSON.stringify({ type: "response", success: false, error: `codex turn process exited ${code}` }));
    }
    const next = pendingTurns.shift();
    if (next !== undefined) runTurn(next);
  });
}

// Called when the adapter flips ready (pi: switch_session ack; claude-code:
// immediately on spawn; codex: never via this path — runTurn-based). Re-apply
// pi-only settings, flush queued prompts, fire bridge_ready to all clients.
function onHarnessReady() {
  if (HARNESS === "pi") {
    try {
      const settings = JSON.parse(readFileSync(`${HOME}/.pi/settings.json`, "utf8"));
      if (settings.defaultProvider && settings.defaultModel) {
        writeToHarness(JSON.stringify({ type: "set_model", provider: settings.defaultProvider, modelId: settings.defaultModel }));
        console.log(`[bridge] set_model ${settings.defaultProvider}/${settings.defaultModel}`);
      }
      if (settings.defaultThinkingLevel) {
        writeToHarness(JSON.stringify({ type: "set_thinking_level", level: settings.defaultThinkingLevel }));
        console.log(`[bridge] set_thinking_level ${settings.defaultThinkingLevel}`);
      }
    } catch (e) {
      console.error(`[bridge] failed to apply pi settings: ${String(e).slice(0, 200)}`);
    }
  }
  harnessReady = true;
  if (pendingPrompts.length > 0) {
    console.log(`[bridge] flushing ${pendingPrompts.length} pending prompt(s)`);
    for (const cmd of pendingPrompts) {
      if (ADAPTER.mode === "per-turn") {
        if ((cmd as any)?.type === "prompt" && typeof (cmd as any).message === "string") {
          runTurn((cmd as any).message);
        }
      } else {
        const translated = ADAPTER.translateInbound?.(cmd, hostState);
        if (translated !== null && translated !== undefined) writeToHarness(translated);
      }
    }
    pendingPrompts.length = 0;
  }
  broadcastToClients(JSON.stringify({ type: "bridge_ready" }));
  // Main-targeted envelopes that arrived during boot are waiting in the
  // queue — the doorbell woke us for exactly this.
  pumpMainQueue();
}

// ---------------------------------------------------------------------------
// Site publishing — push public/ up to the per-cell Worker.
//
// The Worker (cells-front-<name>) serves <name>.cells.md from a snapshot
// held in its Durable Object. We push that snapshot here: once on boot,
// and debounced on any change under public/. The Worker then serves the
// site whether this cell is awake, asleep, or hibernating. The cell only
// needs to be awake to *change* the site, not to serve it.
// ---------------------------------------------------------------------------

const SITE_PUBLISH_URL = `https://${NAME}.cells.md/site/publish`;
const PUBLISH_DEBOUNCE_MS = 800;
let publishing = false;
let dirtyDuringPublish = false;
let publishTimer: Timer | null = null;

// Build the current public/ snapshot and POST it to the Worker. Returns
// true iff the Worker accepted it. Swallows + logs all errors.
async function publishSite(): Promise<boolean> {
  if (publishing) { dirtyDuringPublish = true; return false; }
  publishing = true;
  try {
    if (!SECRET) {
      console.error(`[site] no CELLS_PROXY_SECRET — cannot publish`);
      return false;
    }
    const files: Record<string, { ct: string; data: string }> = {};
    if (existsSync(PUBLIC_DIR)) collectSiteFiles(PUBLIC_DIR, PUBLIC_DIR, files);
    // Nothing in public/ yet — seed /index.html from defaultHome() so
    // <name>.cells.md is live from birth, not a 404. Seed /private.html
    // too so the public/private split has a working demo from day zero.
    if (!files["/index.html"]) {
      files["/index.html"] = {
        ct: "text/html; charset=utf-8",
        data: Buffer.from(defaultHome()).toString("base64"),
      };
    }
    // Publish as /private/index.html so the directory-index fallback in
    // the Worker's DO (serveSite: extensionless path → look up
    // `<path>/index.html`) resolves `/private` cleanly.
    if (!files["/private/index.html"]) {
      files["/private/index.html"] = {
        ct: "text/html; charset=utf-8",
        data: Buffer.from(defaultPrivate()).toString("base64"),
      };
    }
    const res = await fetch(SITE_PUBLISH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ files }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[site] publish failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    const j: any = await res.json().catch(() => ({}));
    const skipped = Array.isArray(j?.skipped) ? j.skipped.length : 0;
    console.log(`[site] published ${Object.keys(files).length} file(s) to ${NAME}.cells.md` +
      (skipped ? ` (${skipped} skipped server-side)` : ""));
    return true;
  } catch (e) {
    console.error(`[site] publish error: ${String(e).slice(0, 200)}`);
    return false;
  } finally {
    publishing = false;
    // A change landed mid-publish — fold it into the next debounced run.
    if (dirtyDuringPublish) {
      dirtyDuringPublish = false;
      schedulePublish();
    }
  }
}

function schedulePublish() {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    void publishSite();
  }, PUBLISH_DEBOUNCE_MS);
}

// Boot: ensure public/ exists (a dir to watch + a place for the agent to
// write), publish the initial snapshot — retrying, since the Worker may
// still be deploying during birth — then re-publish on any change.
function startSitePublishing() {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  void (async () => {
    for (let i = 0; i < 6; i++) {
      if (await publishSite()) break;
      await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  })();
  try {
    watch(PUBLIC_DIR, { recursive: true }, () => schedulePublish());
    console.log(`[site] watching ${PUBLIC_DIR} for changes`);
  } catch (e) {
    console.error(`[site] watch unavailable — site publishes at boot only: ${String(e).slice(0, 160)}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

// Pending --await callers, keyed by corr_id. When the DO forwards an
// agent_reply over the WS, we look up the corr_id here and resolve the
// waiter's response promise — that completes the HTTP long-poll and the
// `cells talk --await` CLI prints the response and exits.
type AwaitWaiter = {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
};
const agentAwaiters = new Map<string, AwaitWaiter>();

const server = Bun.serve({
  port: PORT,
  // /agent-wait is a long-poll that holds the connection until a matching
  // agent_reply arrives (default 120s, capped at 600s). Bun.serve's default
  // idle timeout is 10s — bump it past our hard cap.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return new Response("ok");

    // /agent-wait — long-poll endpoint for `cells talk --await`. The CLI
    // calls this with its corr_id immediately after POSTing the envelope
    // to the peer's inbox. We hold the connection until the matching
    // agent_reply arrives over the bridge WS (forwarded by our DO when
    // the peer's response lands in our inbox), or the timeout expires.
    // No auth — bound to localhost-only callers (inside the cell VM).
    if (url.pathname === "/agent-wait") {
      const corrId = url.searchParams.get("corr_id") ?? "";
      const timeoutS = Math.max(1, Math.min(600, Number(url.searchParams.get("timeout") ?? "120")));
      if (!corrId) return new Response("missing corr_id", { status: 400 });
      const existing = agentAwaiters.get(corrId);
      if (existing) {
        // A second waiter for the same corr_id would race the first; reject.
        return new Response("already awaiting this corr_id", { status: 409 });
      }
      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          agentAwaiters.delete(corrId);
          resolve(new Response("timeout", { status: 408 }));
        }, timeoutS * 1000);
        agentAwaiters.set(corrId, {
          resolve: (text: string) => {
            clearTimeout(timer);
            agentAwaiters.delete(corrId);
            resolve(
              new Response(JSON.stringify({ text }), {
                headers: { "content-type": "application/json" },
              })
            );
          },
          timer,
        });
      });
    }

    // /jobs — job-lane status, read from the durable job files. /jobs/<id>
    // serves a job's RESULT text, which is durable task output — gate it on
    // the same bearer the Worker-facing route uses (codex P2). Unlike
    // /health and /agent-wait (which carry nothing sensitive and stay open),
    // this route shouldn't be readable if :8080 is ever reachable past the
    // guest's localhost. The on-cell `cells jobs` helper passes the secret.
    if (url.pathname === "/jobs" || url.pathname.startsWith("/jobs/")) {
      if (!SECRET || req.headers.get("authorization") !== `Bearer ${SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const id = url.pathname.startsWith("/jobs/") ? url.pathname.slice(6) : "";
      if (id) {
        const rec = JOB_ID_RE.test(id) ? loadJobRecord(id) : null;
        if (!rec) return new Response("unknown job", { status: 404 });
        let result = "";
        try { result = readFileSync(jobPaths(JOBS_DIR, id).result, "utf8"); } catch {}
        return Response.json({ ...rec, result: result.slice(0, 64 * 1024) });
      }
      let files: string[] = [];
      try { files = readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json")); } catch {}
      const jobs = files
        .map((f) => loadJobRecord(f.slice(0, -5)))
        .filter((r): r is JobRecord => r !== null)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return Response.json({ cell: NAME, watching: runningJobs.size, jobs });
    }

    // The bridge WebSocket is no longer served here — post-direction-flip
    // the supervisor dials OUT to the cell Worker (see connectBridge
    // below). This server keeps only the local HTTP surface: /health,
    // /agent-wait, /jobs, and the in-cell static site preview.

    const staticHit = serveStatic(url.pathname);
    if (staticHit) return staticHit;

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(defaultHome(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/private" || url.pathname === "/private.html") {
      return new Response(defaultPrivate(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

// ---------------------------------------------------------------------------
// Bridge client — dial the cell Worker and pump frames both ways.
// ---------------------------------------------------------------------------

// Handle one inbound bridge frame (already line-split). The vocabulary is
// Dedupe window for at-least-once agent_message delivery (see ack_key
// handling below). Bounded — oldest entries evicted past 300.
const seenAgentCorrs = new Set<string>();

// pi's RPC dialect plus bridge-control (ping) and agent-comms (agent_reply,
// agent_message). Replies go back up via broadcastToClients → bridgeWs.
function handleBridgeFrame(line: string) {
  let cmd: any;
  try { cmd = JSON.parse(line); }
  catch (e) { console.error(`[bridge] bad ws json: ${String(e).slice(0, 120)}`); return; }

  // Bridge-level commands (don't forward to the harness). The DO answers
  // our heartbeat ping via setWebSocketAutoResponse, so a `ping` from the
  // DO is unusual — but honor it anyway. A `pong` is our own heartbeat
  // coming back; lastBridgeRecvAt was already refreshed in the message
  // listener, so just drop it.
  if (cmd?.type === "ping") {
    broadcastToClients(JSON.stringify({ type: "pong" }));
    return;
  }
  if (cmd?.type === "pong") return;

  // Reliable-delivery handshake: any frame carrying ack_key gets an
  // immediate frame_ack so the DO stops re-sending it. The DO holds
  // agent_message/agent_reply as pending-until-acked because a ws.send()
  // into the post-hibernation zombie socket vanishes silently — the
  // wake-triggering message always rode exactly that socket (advisor-pete
  // buyer mutes, 2026-06-11). Ack BEFORE dedupe: a duplicate means an
  // earlier ack was lost, so it needs acking again either way.
  if (typeof cmd?.ack_key === "string" && cmd.ack_key) {
    broadcastToClients(JSON.stringify({ type: "frame_ack", key: cmd.ack_key }));
  }

  // job — the DO is handing us durable background work. Never the
  // conversation path: a fresh detached session, watched by the jobs
  // watchdog (docs/proposals/jobs.html).
  if (cmd?.type === "job") {
    void handleJobFrame(cmd);
    return;
  }

  // job_done_ack — the DO recorded our completion; stop re-sending it.
  if (cmd?.type === "job_done_ack") {
    const id = typeof cmd.id === "string" ? cmd.id : "";
    const rec = id ? loadJobRecord(id) : null;
    if (rec && !rec.notified_at) {
      rec.notified_at = new Date().toISOString();
      saveJobRecord(rec);
    }
    unnotifiedDones.delete(id);
    return;
  }

  // agent_reply — forwarded by our DO when an in_reply_to envelope landed
  // in our inbox. Match the corr_id against waiting CLIs that called
  // /agent-wait. If no match, drop silently (timed out or never registered
  // — Pete might have run cells talk --await on the Mac).
  if (cmd?.type === "agent_reply") {
    const corrId = typeof cmd.in_reply_to === "string" ? cmd.in_reply_to : "";
    const text = typeof cmd.text === "string" ? cmd.text : "";
    const waiter = corrId ? agentAwaiters.get(corrId) : undefined;
    if (waiter) {
      waiter.resolve(text);
      console.log(`[bridge] agent_reply matched corr=${corrId.slice(0, 10)} → resolved waiter`);
    } else {
      console.log(`[bridge] agent_reply for unknown corr=${corrId.slice(0, 10)} — no local waiter`);
    }
    return;
  }

  // agent_message — a peer cell (or Pete via the Mac path) is asking us
  // something. Default target="fork": fork main read-only, answer, discard
  // the fork. The adapter owns the fork mechanic per harness (pi: --fork;
  // claude/codex: filename-clone + --resume).
  if (cmd?.type === "agent_message") {
    const corrId = typeof cmd.corr_id === "string" ? cmd.corr_id : "";
    const from = typeof cmd.from === "string" ? cmd.from : "unknown";
    const text = typeof cmd.text === "string" ? cmd.text : "";
    const target = typeof cmd.target === "string" ? cmd.target : "fork";
    // At-least-once delivery means duplicates: the DO re-sends until our
    // ack lands. Same corr_id = same message — fork it once.
    if (corrId && seenAgentCorrs.has(corrId)) {
      console.log(`[bridge] duplicate agent_message corr=${corrId.slice(0, 10)} — already handling, dropped`);
      return;
    }
    if (corrId) {
      seenAgentCorrs.add(corrId);
      if (seenAgentCorrs.size > 300) {
        for (const k of seenAgentCorrs) {
          seenAgentCorrs.delete(k);
          if (seenAgentCorrs.size <= 200) break;
        }
      }
    }
    // Sender's declared turn budget (DO forwards it from the envelope) —
    // sizes the fork leash below so a long WhatsApp/onboarding turn isn't
    // killed at the per-harness default while the sender is still waiting.
    const timeoutS =
      typeof cmd.timeout_seconds === "number" && cmd.timeout_seconds > 0 ? cmd.timeout_seconds : 0;
    console.log(
      `[bridge] agent_message corr=${corrId.slice(0, 10)} from=${from} target=${target}${timeoutS ? ` leash=${timeoutS}s` : ""} text=${text.slice(0, 100).replace(/\n/g, " ")}`,
    );
    if (target === "main") {
      // Durable-conversation path: drive the cell's MAIN session (the same
      // process and session file Slack/CLI stream) instead of a throwaway
      // fork. The exchange lands in session history, so the cell remembers
      // it next turn — conversation continuity by construction.
      enqueueMainTurn({
        corrId,
        from,
        text,
        leashMs: turnLeashMs((timeoutS || 180) * 1000),
      });
      return;
    }
    // Fork path. Wrap in an IIFE so we don't block the frame loop; multiple
    // peers can pipeline (the harness adapter runs the fork to completion).
    const cellName = NAME;
    void (async () => {
      const t0 = Date.now();
      const result = await ADAPTER.forkAndAsk({
        prompt: text,
        mainRef: getMainRef(),
        cellName,
        ...(timeoutS ? { timeoutMs: turnLeashMs(timeoutS * 1000) } : {}),
      });
      const dt = Date.now() - t0;
      if (result.ok) {
        console.log(`[bridge] agent_response corr=${corrId.slice(0, 10)} dt=${dt}ms text=${result.text.slice(0, 100).replace(/\n/g, " ")}`);
        broadcastToClients(JSON.stringify({ type: "agent_response", in_reply_to: corrId, text: result.text }));
      } else {
        console.error(`[bridge] forkAndAsk failed corr=${corrId.slice(0, 10)} dt=${dt}ms: ${result.error}`);
        broadcastToClients(JSON.stringify({
          type: "agent_response",
          in_reply_to: corrId,
          text: `[error] ${result.error}`,
        }));
      }
    })();
    return;
  }

  // Signal busy at prompt-receive time — uniform across harnesses. pi also
  // emits agent_start through passthrough (no-op duplicate); claude and
  // codex don't have an analogue, so this is their only busy signal. Also
  // synthesize agent_start for non-pi so the cell Worker DO opens a turn
  // (DO gates message_update accumulation on currentTurn, which is only
  // created by agent_start). Without this, claude/codex text streams in
  // but the DO drops every event silently.
  if (cmd?.type === "prompt") {
    void signalLifecycle("busy");
    // Main-turn accounting: any prompt occupies the main session, whether
    // it came from an interactive client or our own main-turn pump.
    mainSessionBusy = true;
    if (HARNESS !== "pi") {
      broadcastToClients(JSON.stringify({ type: "agent_start" }));
    }
  }

  // Buffer prompts that arrive before the harness is fully ready (pi setup
  // race; claude's first-output delay). Without this, a prompt can hit a
  // half-configured process and the response is silently lost.
  if (!harnessReady && cmd?.type === "prompt") {
    console.log(`[bridge] queuing prompt (harness not ready yet)`);
    pendingPrompts.push(cmd);
    broadcastToClients(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }));
    return;
  }

  // Per-turn (codex): every prompt spawns a fresh `codex exec`. Pi-only
  // commands (abort, set_model, …) have no per-turn equivalent — drop.
  if (ADAPTER.mode === "per-turn") {
    if (cmd?.type === "prompt" && typeof cmd.message === "string") {
      runTurn(cmd.message);
    }
    return;
  }

  // Persistent: translate inbound to the harness's wire format and write
  // to its stdin. translateInbound returns null for commands the harness
  // can't handle (e.g. abort on claude-code) — drop them.
  const translated = ADAPTER.translateInbound?.(cmd, hostState);
  if (translated === null || translated === undefined) return;
  if (!writeToHarness(translated)) {
    console.error(`[bridge] harness not running, dropping cmd ${cmd?.type}`);
  }
}

function scheduleBridgeReconnect() {
  if (bridgeReconnectTimer) return;
  const delay = bridgeReconnectMs;
  bridgeReconnectTimer = setTimeout(() => {
    bridgeReconnectTimer = null;
    connectBridge();
  }, delay);
  // Exponential backoff, capped. Reset to the floor on a clean connect.
  bridgeReconnectMs = Math.min(bridgeReconnectMs * 2, BRIDGE_RECONNECT_MAX_MS);
}

// Dial the cell Worker's /agent endpoint and hold the connection. On drop
// (well hibernated, Worker redeployed, transient network) reconnect with
// exponential backoff — when the cell is hibernating the dial fails fast
// and the doorbell is what actually brings us back.
function connectBridge() {
  if (bridgeWs || bridgeConnecting) return;
  if (!SECRET) {
    console.error("[bridge] no CELLS_PROXY_SECRET — cannot dial bridge");
    return;
  }
  bridgeConnecting = true;
  let ws: WebSocket;
  try {
    ws = new WebSocket(BRIDGE_URL, { headers: { authorization: `Bearer ${SECRET}` } } as any);
  } catch (e) {
    bridgeConnecting = false;
    console.error(`[bridge] dial failed: ${String(e).slice(0, 160)}`);
    scheduleBridgeReconnect();
    return;
  }
  console.log(`[bridge] dialing ${BRIDGE_URL}`);
  // One dial settles exactly once — via open, close, error, or the connect
  // timeout. `settled` keeps a slow event arriving after a timeout abort
  // (or the reverse) from resurrecting a dead socket or double-reconnecting.
  let settled = false;
  const connectTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    bridgeConnecting = false;
    console.error(`[bridge] dial stalled — no open in ${BRIDGE_CONNECT_TIMEOUT_MS}ms; aborting + retrying`);
    try { ws.close(); } catch {}
    scheduleBridgeReconnect();
  }, BRIDGE_CONNECT_TIMEOUT_MS);
  ws.addEventListener("open", () => {
    if (settled) { try { ws.close(); } catch {} return; }  // timed out — discard
    settled = true;
    clearTimeout(connectTimer);
    bridgeConnecting = false;
    bridgeWs = ws;
    bridgeReconnectMs = BRIDGE_RECONNECT_MIN_MS;
    bridgeSawFrame = true;
    bridgeMissedPings = 0;
    console.log(`[bridge] connected to ${BRIDGE_URL}`);
    // Greet, and if the harness is already ready (warm cell, fast dial)
    // send bridge_ready immediately so the DO doesn't wait. session_targets
    // advertises whether THIS supervisor will actually honor `cells run
    // --session <target>` (interactive runner on, claude-code) — NOT merely
    // that the code is present — so the CLI's gate matches what startJobAttempt
    // will do, and never queues a fork job that's destined to fail-loud.
    try { ws.send(JSON.stringify({ type: "bridge_hello", cell: NAME, harness: HARNESS, session_targets: JOBS_INTERACTIVE })); } catch {}
    if (harnessReady) {
      try { ws.send(JSON.stringify({ type: "bridge_ready" })); } catch {}
    }
  });
  ws.addEventListener("message", (ev: any) => {
    bridgeSawFrame = true;
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as Uint8Array);
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      if (line) handleBridgeFrame(line);
    }
  });
  ws.addEventListener("close", () => {
    clearTimeout(connectTimer);
    const wasLive = bridgeWs === ws;
    if (wasLive) bridgeWs = null;
    // The connect timeout already abandoned this dial — don't double-reconnect.
    if (settled && !wasLive) return;
    settled = true;
    bridgeConnecting = false;
    console.log(`[bridge] disconnected from ${BRIDGE_URL}`);
    scheduleBridgeReconnect();
  });
  ws.addEventListener("error", (e: any) => {
    console.error(`[bridge] ws error: ${String((e as any)?.message ?? e).slice(0, 160)}`);
    if (settled) return;  // open succeeded, or already abandoned — `close` covers it
    // error before open with no `close` to follow — settle and retry here.
    settled = true;
    clearTimeout(connectTimer);
    bridgeConnecting = false;
    scheduleBridgeReconnect();
  });
}

// Bridge heartbeat, every BRIDGE_PING_MS:
//   - Bridge up: did a frame arrive since the last tick? Yes → healthy,
//     reset the miss counter. No → another miss. BRIDGE_MAX_MISSED misses
//     in a row means the socket is a zombie (typically a connection that
//     died while the well was hibernated and never surfaced a `close`) —
//     force it closed and reconnect. Then ping, so the next tick has a
//     pong to see.
//   - No bridge and nothing in flight: dial — belt-and-suspenders in case
//     a `close` event was missed entirely.
function bridgeHeartbeat() {
  const ws = bridgeWs;
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (bridgeSawFrame) bridgeMissedPings = 0;
    else bridgeMissedPings++;
    bridgeSawFrame = false;
    if (bridgeMissedPings >= BRIDGE_MAX_MISSED) {
      console.error(`[bridge] ${bridgeMissedPings} heartbeats unanswered — zombie socket, reconnecting`);
      bridgeWs = null;
      bridgeMissedPings = 0;
      try { ws.close(4000, "heartbeat-timeout"); } catch {}
      connectBridge();
      return;
    }
    // Pinging a dead socket also helps: the failed write surfaces the
    // drop and fires `close`, so we don't only depend on the miss count.
    try { ws.send(BRIDGE_PING_FRAME); } catch { /* close event will follow */ }
  } else if (ws) {
    // bridgeWs set but not OPEN — a half-dead socket whose `close` never
    // landed. Drop it and redial; without this branch the heartbeat would
    // neither ping nor reconnect and the bridge would stay wedged.
    console.error(`[bridge] socket stuck at readyState=${ws.readyState} — reconnecting`);
    bridgeWs = null;
    bridgeMissedPings = 0;
    try { ws.close(); } catch {}
    connectBridge();
  } else if (!bridgeConnecting && !bridgeReconnectTimer) {
    connectBridge();
  }
}

console.log(`${NAME} site listening on :${server.port} (harness=${HARNESS})`);
connectBridge();
setInterval(bridgeHeartbeat, BRIDGE_PING_MS);
spawnHarness();
startSitePublishing();
adoptJobs();
setInterval(jobsWatchdogTick, WATCH_TICK_MS);
