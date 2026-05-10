#!/usr/bin/env bun
//
// Birth/kill hardening harness. One run = pick N combos, birth them in
// parallel, verify each came up clean, kill them, verify cleanup.
//
// Output: a single JSON run record at ~/.cells/logs/harden/runs/<iso>.json.
// State.json and REPORT.md are the slash command's job — this script just
// emits one machine-readable record per invocation. The loop reasons over
// records to decide what to try next and to write Pete's report.
//
// Usage:
//   bun scripts/harden-birth.ts [--combos=N] [--combo=<id>] [--orphans=name,...]
//                               [--age=name] [--dry-run]
//
// Exit code: 0 if the script ran to completion (regardless of birth/kill
// outcomes — those go in the record). Non-zero only on script-level errors.

import { readFile, writeFile, mkdir, readdir, unlink, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const HOME = homedir();
const REGISTRY_PATH   = join(HOME, ".cells", "cells.json");
const CHANNELS_PATH   = join(HOME, ".cells", "channels.json");
const SECRETS_PATH    = join(HOME, ".cells", "secrets.json");
const PULSE_CACHE_DIR = join(HOME, ".cells", "pulse-cache");
const PULSE_INBOX_DIR = join(HOME, ".cells", "pulse-inbox");
const VAULT_DIR       = join(HOME, "Obsidian", "cells");
const LOGS_DIR        = join(HOME, ".cells", "logs", "harden");
const RUNS_DIR        = join(LOGS_DIR, "runs");
const RUN_LOCK_PATH   = join(LOGS_DIR, "run.lock");
const BIRTH_TIMING_DIR = join(HOME, ".cells", "logs", "birth-timings");

// In-flight detection. The hourly cron can fire while a prior run is still
// going (sonnet-slack birth has been observed taking >50min when stuck on
// `pi install`). Two harden scripts at once means two `pi -p` against
// mother, which has concurrency=1 and will deadlock. So we lockfile.
async function acquireRunLock(): Promise<void> {
  if (existsSync(RUN_LOCK_PATH)) {
    try {
      const raw = await readFile(RUN_LOCK_PATH, "utf8");
      const data = JSON.parse(raw) as { pid: number; startedAt: string };
      // Probe the PID without killing — `kill -0 <pid>` returns 0 if the
      // process exists and we have permission to signal it.
      try {
        process.kill(data.pid, 0);
        // Still alive — refuse to start.
        console.error(`harden-birth: a prior run is still in flight (pid ${data.pid}, started ${data.startedAt}). exiting without doing anything.`);
        process.exit(0); // exit 0 so the cron doesn't retry-storm
      } catch {
        // Stale lock — owner gone. Reclaim.
        console.warn(`harden-birth: removing stale lock (pid ${data.pid} no longer alive)`);
      }
    } catch {
      console.warn(`harden-birth: malformed run.lock — removing and proceeding`);
    }
    try { await unlink(RUN_LOCK_PATH); } catch {}
  }
  await writeFile(RUN_LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}

async function releaseRunLock(): Promise<void> {
  try { await unlink(RUN_LOCK_PATH); } catch {}
}

// ───── combos ─────
//
// Fixed schedule + one randomized roll per fire. Pete owns this list — add
// rows when there's a new option dimension to exercise. Combo `id` ends up
// in the cell name, so keep it short, lowercase, alnum/dash only.

type Combo = {
  id: string;
  model: string;
  thinking: string;
  extensions: string[];
  packages: string[];
  channels: string[];
};

const COMBOS: Combo[] = [
  { id: "min",            model: "sonnet",            thinking: "off",      extensions: [],                                  packages: [],                channels: [] },
  { id: "opus-high",      model: "opus",              thinking: "high",     extensions: [],                                  packages: ["pi-web-access"], channels: [] },
  { id: "opus-adaptive",  model: "opus",              thinking: "adaptive", extensions: ["memory"],                          packages: ["pi-web-access"], channels: [] },
  { id: "haiku-mem",      model: "haiku",             thinking: "high",     extensions: ["memory"],                          packages: [],                channels: [] },
  { id: "sonnet-full",    model: "sonnet",            thinking: "high",     extensions: ["memory","mentality","wiki","dream"], packages: ["pi-web-access"], channels: [] },
  { id: "sonnet-slack",   model: "sonnet",            thinking: "high",     extensions: [],                                  packages: ["pi-web-access"], channels: ["slack"] },
  { id: "gpt55",          model: "gpt-5.5",           thinking: "medium",   extensions: [],                                  packages: [],                channels: [] },
  { id: "deepseek-flash", model: "deepseek-v4-flash", thinking: "medium",   extensions: [],                                  packages: [],                channels: [] },
];

const BASELINE_ID = "min";

// ───── args ─────

type Args = {
  combos: number;
  combo: string | null;
  orphans: string[];
  age: string | null;
  dryRun: boolean;
  // --hatch (opt-in): before each birth, bake an egg matching the combo so
  // the subsequent `cells birth` auto-hatches from the egg pool. Adds ~5min
  // per combo (egg bake) but exercises the egg lifecycle end-to-end. Default
  // off because the cron's regular cadence runs slow-birth, which is faster.
  // Pete invokes this manually when he wants to test the hatch path.
  hatch: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { combos: 3, combo: null, orphans: [], age: null, dryRun: false, hatch: false };
  for (const x of argv) {
    if (x.startsWith("--combos=")) a.combos = Math.max(1, Math.min(5, parseInt(x.slice(9), 10) || 3));
    else if (x.startsWith("--combo=")) a.combo = x.slice(8);
    else if (x.startsWith("--orphans=")) a.orphans = x.slice(10).split(",").filter(Boolean);
    else if (x.startsWith("--age=")) a.age = x.slice(6);
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--hatch") a.hatch = true;
    else { console.error(`unknown flag: ${x}`); process.exit(2); }
  }
  return a;
}

// ───── combo selection ─────

function pickCombos(n: number, hour: number, only: string | null): Combo[] {
  if (only) {
    const c = COMBOS.find((c) => c.id === only);
    if (!c) { console.error(`unknown combo: ${only}. known: ${COMBOS.map((c) => c.id).join(", ")}`); process.exit(2); }
    return [c];
  }
  const baseline = COMBOS.find((c) => c.id === BASELINE_ID)!;
  const picked: Combo[] = [baseline];
  // Scheduled — deterministic by hour-of-day, skip baseline.
  const others = COMBOS.filter((c) => c.id !== BASELINE_ID);
  if (n >= 2) picked.push(others[hour % others.length]);
  // Randomized — fill remaining slots, no duplicates within the run.
  while (picked.length < n) {
    const c = others[Math.floor(Math.random() * others.length)];
    if (!picked.some((p) => p.id === c.id)) picked.push(c);
    // If we somehow can't fill (small COMBOS list), bail.
    if (picked.length >= others.length + 1) break;
  }
  return picked;
}

// ───── naming ─────

function nameFor(combo: Combo, ts: Date): string {
  const id = combo.id.replace(/[^a-z0-9-]+/g, "");
  const hh = String(ts.getHours()).padStart(2, "0");
  const mm = String(ts.getMinutes()).padStart(2, "0");
  const ss = String(ts.getSeconds()).padStart(2, "0");
  return `harden-${id}-${hh}${mm}${ss}`;
}

// ───── verification ─────

type Registry = { cells: Array<{ name: string; created_at: string; modelChain?: string[] }> };
type ChannelsFile = { version: 1; bindings: Record<string, { cell: string; kind: string; createdAt: string }> };

async function loadRegistry(): Promise<Registry> {
  if (!existsSync(REGISTRY_PATH)) return { cells: [] };
  try { return JSON.parse(await readFile(REGISTRY_PATH, "utf-8")); }
  catch { return { cells: [] }; }
}

async function loadChannels(): Promise<ChannelsFile> {
  if (!existsSync(CHANNELS_PATH)) return { version: 1, bindings: {} };
  try { return JSON.parse(await readFile(CHANNELS_PATH, "utf-8")); }
  catch { return { version: 1, bindings: {} }; }
}

async function wellsToken(): Promise<string | null> {
  if (process.env.WELL_TOKEN) return process.env.WELL_TOKEN;
  if (!existsSync(SECRETS_PATH)) return null;
  try {
    const s = JSON.parse(await readFile(SECRETS_PATH, "utf-8"));
    return typeof s.WELL_TOKEN === "string" ? s.WELL_TOKEN : null;
  } catch { return null; }
}

type WellCheck = { exists: boolean; status: string | null; httpStatus: number; error?: string };

async function wellCheck(name: string): Promise<WellCheck> {
  const token = await wellsToken();
  if (!token) return { exists: false, status: null, httpStatus: 0, error: "no WELL_TOKEN" };
  try {
    const r = await fetch(`https://api.sprites.dev/v1/sprites/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 404) return { exists: false, status: null, httpStatus: 404 };
    if (!r.ok) return { exists: false, status: null, httpStatus: r.status, error: (await r.text()).slice(0, 200) };
    const j = await r.json();
    return { exists: true, status: typeof j.status === "string" ? j.status : "?", httpStatus: r.status };
  } catch (e) {
    return { exists: false, status: null, httpStatus: 0, error: String(e) };
  }
}

async function pulseCacheExists(name: string): Promise<boolean> {
  return existsSync(join(PULSE_CACHE_DIR, `${name}.json`));
}

async function pulseInboxFiles(name: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of ["", "processed"]) {
    const dir = join(PULSE_INBOX_DIR, sub);
    if (!existsSync(dir)) continue;
    try {
      const files = await readdir(dir);
      for (const f of files) if (f.startsWith(`${name}-`) && f.endsWith(".md")) out.push(join(dir, f));
    } catch { /* best-effort */ }
  }
  return out;
}

function vaultExists(name: string): boolean {
  return existsSync(join(VAULT_DIR, name));
}

async function bindingsForCell(name: string): Promise<string[]> {
  const f = await loadChannels();
  return Object.entries(f.bindings).filter(([, b]) => b.cell === name).map(([id]) => id);
}

async function inRegistry(name: string): Promise<boolean> {
  const r = await loadRegistry();
  return r.cells.some((c) => c.name === name);
}

// ───── shelling out to `cells` ─────

type CmdResult = { exitCode: number; durationMs: number; stdout: string; stderr: string };

async function runCells(args: string[]): Promise<CmdResult> {
  const t0 = Date.now();
  const proc = Bun.spawn(["cells", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, durationMs: Date.now() - t0, stdout, stderr };
}

// ───── birth + verify ─────

type BirthFlags = { harness: string; model: string; thinking: string; extensions: string[]; packages: string[]; channels: string[] };

// Read the cell's settings.json on the well via `well exec` and compare
// its `modelChain` to the expected chain (the one we wrote into the
// laptop-side registry). Returns:
//   true  → chain on well matches expected exactly (same length, same order)
//   false → chain present but differs, OR missing/null on the well
// On any error (well CLI missing, exec fails, JSON malformed) the caller
// gets `null` via the wrapper above — we don't fail birth on infra hiccups.
async function verifyChainOnWell(wellName: string, expected: string[]): Promise<boolean | null> {
  try {
    const proc = Bun.spawn(
      ["well", "exec", "-s", wellName, "--", "cat", "/cell/.pi/settings.json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const parsed = JSON.parse(stdout);
    const onWell = parsed?.modelChain;
    if (!Array.isArray(onWell)) return false;
    if (onWell.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (onWell[i] !== expected[i]) return false;
    }
    return true;
  } catch {
    return null;
  }
}

function birthArgs(name: string, c: Combo): string[] {
  const flags: string[] = [
    "birth", name,
    `--harness=pi`,
    `--model=${c.model}`,
    `--thinking=${c.thinking}`,
  ];
  // Empty list flags are intentional — `cells birth` parses an empty value
  // as "no extensions/packages/channels". Without the flag, cells birth
  // would default packages to PACKAGE_DEFAULTS, which we don't want when
  // a combo says "no packages."
  flags.push(`--extensions=${c.extensions.join(",")}`);
  flags.push(`--packages=${c.packages.join(",")}`);
  flags.push(`--channels=${c.channels.join(",")}`);
  return flags;
}

// `cells egg --model=... --extensions=... --packages=...` — bakes a single
// egg into the pool. `cells birth` for a matching variant will then
// auto-hatch from this egg. Eggs don't take --thinking or --channels;
// those are hatch-time. Used by --hatch mode below.
function eggArgs(c: Combo): string[] {
  return [
    "egg",
    `--model=${c.model}`,
    `--extensions=${c.extensions.join(",")}`,
    `--packages=${c.packages.join(",")}`,
  ];
}

type EggBakeRecord = {
  combo: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  stderrTail: string;
};

// Bake a single egg matching `combo` so that the subsequent `cells birth`
// for that combo auto-hatches from the pool. Egg-bake is slow (~5min on
// happy path; longer if mother chains through fallback tiers), so we use a
// 12-min timeout per egg. Returns an EggBakeRecord regardless of outcome.
async function bakeEgg(combo: Combo): Promise<EggBakeRecord> {
  const t0 = Date.now();
  const r = await runCells(eggArgs(combo));
  return {
    combo: combo.id,
    ok: r.exitCode === 0,
    exitCode: r.exitCode,
    durationMs: Date.now() - t0,
    stderrTail: tail(r.stderr, 600),
  };
}

type BirthVerify = {
  registry: boolean;
  well: WellCheck;
  slackBinding: boolean | null; // null = combo didn't request slack
  vault: boolean;
  // Did `cli/cells.ts` write a non-empty modelChain into the cell's
  // registry entry? Catches DNA-substitution drift on the laptop side.
  // Null = no registry entry to check (already covered by `registry: false`).
  modelChain: boolean | null;
  // Deep verify: does the cell's settings.json on the well contain
  // the SAME chain as the registry mirror? Catches DNA-substitution drift
  // on the cell side (placeholder didn't get sed'd, jq didn't validate
  // properly, etc). Null = well unreachable or `well exec` not
  // available (don't fail the birth on this — it's an extra check).
  modelChainOnWell: boolean | null;
};

type StepTiming = { step: string; label: string; startedAt: number; durationSec: number | null };

type FallbackEvent = {
  fromModel: string;       // e.g. "anthropic/claude-opus-4-7"
  toModel: string;         // e.g. "openai-codex/gpt-5.5"
  atTimestamp: string;     // ISO from mother's session JSONL
  triggerError: string;    // the errorMessage that exhausted retries (e.g. "terminated")
};

// Token usage summed across mother's session for a single birth, broken
// down by (provider, model) so fallback-mixed sessions are legible. Cost
// computation is intentionally NOT in v1 — provider pricing drifts and we
// don't want stale constants lying. Pete can eyeball totals.
type MotherUsageEntry = {
  modelKey: string;        // "<provider>/<modelId>"
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messageCount: number;    // # of assistant messages from this model in the session
};

type BirthRecord = {
  name: string;
  combo: Combo;
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  verify: BirthVerify;
  timings: StepTiming[] | null;  // null if log file missing/unreadable
  fallbacks: FallbackEvent[];    // model swaps mother performed mid-birth (empty = primary held)
  motherUsage: MotherUsageEntry[]; // token breakdown by (provider, model) for this birth's mother session
  ok: boolean;
};

function tail(s: string, n = 1500): string {
  if (s.length <= n) return s;
  return "…" + s.slice(s.length - n);
}

// Mother's session log dir. Each `pi -p` invocation lands one JSONL here;
// model_fallback events show up as `model_change` records with a parent
// `parentId` pointing at an `assistant` message whose `stopReason === "error"`.
const MOTHER_SESSION_DIR = join(
  homedir(),
  ".pi/agent/sessions/--Users-pete-Projects-cells-proto-mother--",
);

// Find any mother session JSONL that started in [windowStartMs, windowEndMs]
// (i.e. mother sessions spawned during this birth's wall-clock window). The
// session filename embeds the start timestamp in ISO form.
//
// Returns both fallbacks and per-(provider,model) token usage in one pass —
// otherwise we'd readFile each session twice for the same data.
async function readMotherDataDuringWindow(
  windowStartMs: number,
  windowEndMs: number,
): Promise<{ fallbacks: FallbackEvent[]; usage: MotherUsageEntry[] }> {
  if (!existsSync(MOTHER_SESSION_DIR)) return { fallbacks: [], usage: [] };
  let entries: string[];
  try { entries = await readdir(MOTHER_SESSION_DIR); }
  catch { return { fallbacks: [], usage: [] }; }
  const candidates: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    // Filename format: 2026-05-06T18-46-21-560Z_<uuid>.jsonl
    const m = name.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_/);
    if (!m) continue;
    const iso = m[1].replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z");
    const startMs = Date.parse(iso);
    if (!Number.isFinite(startMs)) continue;
    if (startMs >= windowStartMs - 1000 && startMs <= windowEndMs + 1000) {
      candidates.push(join(MOTHER_SESSION_DIR, name));
    }
  }
  const fallbacks: FallbackEvent[] = [];
  // Aggregate usage by `<provider>/<modelId>` across all sessions in window.
  const usageMap = new Map<string, MotherUsageEntry>();
  for (const path of candidates) {
    let raw: string;
    try { raw = await readFile(path, "utf-8"); }
    catch { continue; }
    const lines = raw.split("\n").filter(Boolean);
    let lastErrorMsg = "";
    let lastModelId = "";
    let lastProvider = "";
    for (const line of lines) {
      let evt: any;
      try { evt = JSON.parse(line); } catch { continue; }
      const m = evt.message ?? {};
      // Track the most recent assistant error so a model_change immediately
      // after gets attributed to "this is what tripped fallback."
      if (m.role === "assistant" && m.stopReason === "error" && m.errorMessage) {
        lastErrorMsg = String(m.errorMessage).slice(0, 100);
        if (m.model) lastModelId = String(m.model);
        if (m.provider) lastProvider = String(m.provider);
      }
      // Sum usage from successful assistant messages (errors carry zeros).
      if (m.role === "assistant" && m.usage && m.provider && m.model) {
        const key = `${m.provider}/${m.model}`;
        const u = m.usage;
        const entry = usageMap.get(key) ?? {
          modelKey: key,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          messageCount: 0,
        };
        entry.inputTokens     += Number(u.input ?? u.input_tokens ?? 0);
        entry.outputTokens    += Number(u.output ?? u.output_tokens ?? 0);
        entry.cacheReadTokens += Number(u.cacheRead ?? u.cache_read_input_tokens ?? 0);
        entry.cacheWriteTokens+= Number(u.cacheWrite ?? u.cache_creation_input_tokens ?? 0);
        entry.messageCount    += 1;
        usageMap.set(key, entry);
      }
      // model_change after a chain of errors → fallback fired.
      if (evt.type === "model_change" && lastErrorMsg) {
        fallbacks.push({
          fromModel: lastProvider && lastModelId ? `${lastProvider}/${lastModelId}` : lastModelId,
          toModel: `${evt.provider ?? "?"}/${evt.modelId ?? "?"}`,
          atTimestamp: String(evt.timestamp ?? ""),
          triggerError: lastErrorMsg,
        });
        lastErrorMsg = "";
      }
    }
  }
  return { fallbacks, usage: Array.from(usageMap.values()) };
}

// Parse the per-cell birth timing log (written by scripts/log-birth-step.sh
// from inside the birth skill). Each line: "<epoch.ns>\t<step>\t<label>".
// Returns one entry per recorded step with durationSec computed as
// next-step-start minus this-step-start. The last step's duration is null
// (no successor to compute against).
async function readBirthTimings(name: string): Promise<StepTiming[] | null> {
  const path = join(BIRTH_TIMING_DIR, `${name}.log`);
  if (!existsSync(path)) return null;
  let raw: string;
  try { raw = await readFile(path, "utf-8"); }
  catch { return null; }
  const rows = raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split("\t");
    return { ts: parseFloat(parts[0]), step: parts[1] ?? "?", label: parts[2] ?? "" };
  }).filter((r) => Number.isFinite(r.ts));
  if (rows.length === 0) return null;
  return rows.map((r, i) => ({
    step: r.step,
    label: r.label,
    startedAt: r.ts,
    durationSec: i + 1 < rows.length ? +(rows[i + 1].ts - r.ts).toFixed(2) : null,
  }));
}

async function birthOne(name: string, combo: Combo): Promise<BirthRecord> {
  const args = birthArgs(name, combo);
  const cmd = `cells ${args.join(" ")}`;
  const t0 = Date.now();
  const r = await runCells(args);
  const t1 = Date.now();

  const wantsSlack = combo.channels.includes("slack");
  const reg = await loadRegistry();
  const regEntry = reg.cells.find((c) => c.name === name);
  const well = await wellCheck(name);
  // Deep verify of chain on the well. Only attempt when the well is
  // reachable; otherwise mark null and move on. The registry mirror should
  // match what's on the well — if it doesn't, the substitution pipeline
  // dropped or corrupted the chain at some step.
  const expectedChain = Array.isArray(regEntry?.modelChain) ? regEntry.modelChain : null;
  const modelChainOnWell = (expectedChain && well.exists)
    ? await verifyChainOnWell(name, expectedChain)
    : null;
  const verify: BirthVerify = {
    registry: regEntry !== undefined,
    well,
    slackBinding: wantsSlack ? (await bindingsForCell(name)).length > 0 : null,
    vault: vaultExists(name),
    modelChain: regEntry === undefined ? null : Array.isArray(regEntry.modelChain) && regEntry.modelChain.length > 0,
    modelChainOnWell,
  };

  const ok =
    r.exitCode === 0 &&
    verify.registry &&
    verify.well.exists &&
    (verify.slackBinding === null || verify.slackBinding === true) &&
    verify.modelChain !== false &&
    verify.modelChainOnWell !== false;

  const timings = await readBirthTimings(name);
  const { fallbacks, usage: motherUsage } = await readMotherDataDuringWindow(t0, t1);

  return {
    name, combo, command: cmd,
    exitCode: r.exitCode, durationMs: r.durationMs,
    stdoutTail: tail(r.stdout), stderrTail: tail(r.stderr),
    verify, timings, fallbacks, motherUsage, ok,
  };
}

// ───── kill + verify ─────

type KillVerify = {
  registry: boolean;       // true = correctly absent
  well: boolean;         // true = correctly absent (404)
  slackBindings: boolean;  // true = correctly absent
  vault: boolean;          // true = correctly absent
  pulseCache: boolean;     // true = correctly absent
  pulseInbox: boolean;     // true = correctly absent (no leftover files)
};

type KillRecoveryAction =
  | { kind: "retry-cells-kill"; ok: boolean }
  | { kind: "direct-well-destroy"; httpStatus: number; ok: boolean };

type KillRecord = {
  name: string;
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  verify: KillVerify;
  recoveries: KillRecoveryAction[]; // empty if first attempt cleared
  ok: boolean;
  reason: "paired" | "orphan" | "aged";
};

// Direct well destroy via the wells API. Used as a last-ditch recovery
// when `cells kill` failed to remove the well (e.g. mother's destroy
// session crashed mid-flight, registry got cleaned but well is still up).
async function directWellDestroyApi(name: string): Promise<{ ok: boolean; httpStatus: number }> {
  const token = await wellsToken();
  if (!token) return { ok: false, httpStatus: 0 };
  try {
    const r = await fetch(`https://api.sprites.dev/v1/sprites/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    // 404 means already gone — treat as success.
    return { ok: r.ok || r.status === 404, httpStatus: r.status };
  } catch {
    return { ok: false, httpStatus: 0 };
  }
}

// Run `cells kill` once and verify; if anything is left dirty, attempt an
// idempotent retry (cells kill is safe to re-run). If well is STILL up
// after retry, fall through to direct API destroy. Each recovery attempt
// is recorded so the report can attribute "this kill needed 2 retries +
// direct API hit" rather than just saying "ok".
async function killOne(name: string, reason: KillRecord["reason"]): Promise<KillRecord> {
  const args = ["kill", name, "--yes"];
  const cmd = `cells ${args.join(" ")}`;
  const t0 = Date.now();
  const r = await runCells(args);

  const computeVerify = async (): Promise<KillVerify> => {
    const inbox = await pulseInboxFiles(name);
    const well = await wellCheck(name);
    return {
      registry:      !(await inRegistry(name)),
      well: !well.exists,
      slackBindings: (await bindingsForCell(name)).length === 0,
      vault:         !vaultExists(name),
      pulseCache:    !(await pulseCacheExists(name)),
      pulseInbox:    inbox.length === 0,
    };
  };
  const verifyOk = (v: KillVerify) =>
    v.registry && v.well && v.slackBindings && v.vault && v.pulseCache && v.pulseInbox;

  let verify = await computeVerify();
  const recoveries: KillRecoveryAction[] = [];

  // First-line recovery: if first cells-kill left anything dirty (or exited
  // non-zero), give it one more go. cmdDestroyOne is idempotent per the
  // 2026-05-06 hardening pass.
  if (r.exitCode !== 0 || !verifyOk(verify)) {
    const r2 = await runCells(args);
    recoveries.push({ kind: "retry-cells-kill", ok: r2.exitCode === 0 });
    verify = await computeVerify();
  }

  // Last-ditch: well still live → direct DELETE via the well API.
  if (!verify.well) {
    const direct = await directWellDestroyApi(name);
    recoveries.push({ kind: "direct-well-destroy", httpStatus: direct.httpStatus, ok: direct.ok });
    verify = await computeVerify();
  }

  const ok = verifyOk(verify);

  return {
    name, command: cmd,
    exitCode: r.exitCode, durationMs: Date.now() - t0,
    stdoutTail: tail(r.stdout), stderrTail: tail(r.stderr),
    verify, recoveries, ok, reason,
  };
}

// ───── orphans + aged scan ─────
//
// Anything in the registry whose name starts with `harden-` is potentially
// a leftover from a prior failed run. The loop's planner decides which to
// kill (passed in via --orphans=...). We surface the full list so the loop
// can also write it into state.json.

// Discover every cell that looks like a test artifact — `harden-*` from this
// loop, `eval-*` from `scripts/eval-birth.ts` (which has no orphan sweep of
// its own; if eval's kill-verify failed, the cell sits in the registry until
// the next harden iteration sweeps it).
async function discoverHardenCells(): Promise<string[]> {
  const r = await loadRegistry();
  return r.cells.map((c) => c.name).filter((n) => n.startsWith("harden-") || n.startsWith("eval-"));
}

// ───── run record ─────

type RunRecord = {
  schemaVersion: 1;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  args: Args;
  hostHour: number;
  preExistingHardenCells: string[];
  combosPicked: Combo[];
  // Egg bakes that ran before the birth phase (only present in --hatch mode).
  // Empty array on slow-birth-only runs.
  eggBakes: EggBakeRecord[];
  birth: BirthRecord[];
  kill: KillRecord[];
  ok: boolean;
};

async function ensureDir(p: string) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

async function writeRunRecord(rec: RunRecord): Promise<string> {
  await ensureDir(RUNS_DIR);
  const path = join(RUNS_DIR, `${rec.startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(rec, null, 2));
  return path;
}

// ───── main ─────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const hour = startedAt.getHours();

  await acquireRunLock();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { releaseRunLock().finally(() => process.exit(130)); });
  }

  const preExisting = await discoverHardenCells();
  const combos = pickCombos(args.combos, hour, args.combo);
  const ts = startedAt;
  const plan = combos.map((c) => ({ combo: c, name: nameFor(c, ts) }));

  // Names within a single fire share H:M:S, but combo id differs, so no
  // collision. Sanity-check anyway.
  const names = new Set(plan.map((p) => p.name));
  if (names.size !== plan.length) {
    console.error("name collision in plan — aborting");
    process.exit(2);
  }

  console.log(`harden run @ ${startedAt.toISOString()}  hour=${hour}  combos=${combos.map((c) => c.id).join(",")}`);
  console.log(`pre-existing harden cells in registry: ${preExisting.length === 0 ? "(none)" : preExisting.join(", ")}`);
  console.log(`orphans to kill: ${args.orphans.length === 0 ? "(none)" : args.orphans.join(", ")}`);
  console.log(`aged cell to kill: ${args.age ?? "(none)"}`);
  console.log(`plan:`);
  for (const p of plan) console.log(`  ${p.name}  ←  ${p.combo.id}`);

  if (args.dryRun) {
    console.log("--dry-run: not executing");
    return;
  }

  // --hatch (opt-in): bake one egg per planned combo BEFORE the birth phase.
  // The subsequent `cells birth` for each matching combo will auto-hatch
  // from the egg pool. Eggs and births are mother-orchestrated, so we run
  // them sequentially under the same lock as the births. Egg-bake is slow
  // (~5min happy-path) so this nearly doubles iteration time.
  const eggBakeRecords: EggBakeRecord[] = [];
  if (args.hatch) {
    console.log(`\n--hatch: baking ${plan.length} egg(s) sequentially before births...`);
    for (const p of plan) {
      const r = await bakeEgg(p.combo);
      eggBakeRecords.push(r);
      console.log(`  egg ${p.combo.id} → ${r.ok ? "OK" : "FAIL"}  exit=${r.exitCode}  ${r.durationMs}ms${r.ok ? "" : "  stderr=" + r.stderrTail.slice(-200)}`);
    }
  }

  // Birth sequentially. Parallel mothers contend for the same OAuth /
  // proxy and time out at ~3 minutes — a one-mother bottleneck, not a
  // well-side race. Reliability is the goal; trading wall-clock for
  // success rate is the right call.
  console.log(`\nbirthing ${plan.length} cell(s) sequentially...`);
  const birthRecords: BirthRecord[] = [];
  for (const p of plan) birthRecords.push(await birthOne(p.name, p.combo));
  for (const b of birthRecords) {
    console.log(`  birth ${b.name} → ${b.ok ? "OK" : "FAIL"}  exit=${b.exitCode}  ${b.durationMs}ms  well=${b.verify.well.exists ? b.verify.well.status : "absent"}`);
    if (b.fallbacks.length > 0) {
      for (const fb of b.fallbacks) {
        console.log(`    ↩ fallback: ${fb.fromModel} → ${fb.toModel}  (trigger: ${fb.triggerError})`);
      }
    }
    if (b.motherUsage.length > 0) {
      const totalIn = b.motherUsage.reduce((s, u) => s + u.inputTokens, 0);
      const totalOut = b.motherUsage.reduce((s, u) => s + u.outputTokens, 0);
      const totalCacheR = b.motherUsage.reduce((s, u) => s + u.cacheReadTokens, 0);
      const totalCacheW = b.motherUsage.reduce((s, u) => s + u.cacheWriteTokens, 0);
      const perModel = b.motherUsage
        .map((u) => `${u.modelKey}=${u.inputTokens}in/${u.outputTokens}out/${u.messageCount}msgs`)
        .join("  ");
      console.log(`    mother tokens: ${totalIn}in ${totalOut}out (cache ${totalCacheR}r/${totalCacheW}w) · ${perModel}`);
    }
    if (b.timings && b.timings.length) {
      const top = [...b.timings].filter((t) => t.durationSec !== null).sort((a, c) => (c.durationSec! - a.durationSec!)).slice(0, 3);
      if (top.length) console.log(`    top steps: ${top.map((t) => `${t.step}/${t.label}=${t.durationSec}s`).join("  ")}`);
    } else {
      console.log(`    (no timing log — skill may not have logged steps for this cell)`);
    }
  }

  // Kill plan: all paired births + orphans + aged cell. Dedupe.
  const killTargets: Array<{ name: string; reason: KillRecord["reason"] }> = [];
  for (const b of birthRecords) killTargets.push({ name: b.name, reason: "paired" });
  for (const n of args.orphans) if (!killTargets.some((t) => t.name === n)) killTargets.push({ name: n, reason: "orphan" });
  if (args.age && !killTargets.some((t) => t.name === args.age)) killTargets.push({ name: args.age, reason: "aged" });

  // Kill is mother-orchestrated too — same concurrency rule. Sequential.
  console.log(`\nkilling ${killTargets.length} cell(s) sequentially...`);
  const killRecords: KillRecord[] = [];
  for (const t of killTargets) killRecords.push(await killOne(t.name, t.reason));
  for (const k of killRecords) {
    const failed = Object.entries(k.verify).filter(([, ok]) => !ok).map(([key]) => key);
    console.log(`  kill ${k.name} (${k.reason}) → ${k.ok ? "OK" : "FAIL"}  exit=${k.exitCode}  ${k.durationMs}ms  ${failed.length === 0 ? "" : "failed: " + failed.join(",")}`);
    for (const r of k.recoveries) {
      const status = r.kind === "direct-well-destroy" ? `http=${r.httpStatus}` : "";
      console.log(`    ↻ recovery: ${r.kind} ${status} → ${r.ok ? "OK" : "FAIL"}`);
    }
  }

  const endedAt = new Date();
  const eggBakesOk = eggBakeRecords.every((e) => e.ok);
  const ok = eggBakesOk && birthRecords.every((b) => b.ok) && killRecords.every((k) => k.ok);
  const rec: RunRecord = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    args,
    hostHour: hour,
    preExistingHardenCells: preExisting,
    combosPicked: combos,
    eggBakes: eggBakeRecords,
    birth: birthRecords,
    kill: killRecords,
    ok,
  };

  const path = await writeRunRecord(rec);
  console.log(`\nrun record: ${path}`);
  console.log(`overall: ${ok ? "OK" : "FAIL"}  ${rec.durationMs}ms`);

  await releaseRunLock();
}

// Only run when invoked directly (`bun scripts/harden-birth.ts`). When this
// module is imported (e.g. for unit tests, type-checks via `bun -e`), skip
// `main()` so dynamic-import smoke-tests don't accidentally start a 15-min
// fleet birth/kill cycle. Bit me twice during /harden-process iter 5 + 7.
if (import.meta.main) {
  main().catch(async (e) => {
    console.error("harden-birth crashed:", e);
    await releaseRunLock();
    process.exit(1);
  });
}
