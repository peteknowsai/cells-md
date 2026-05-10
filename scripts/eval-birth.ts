#!/usr/bin/env bun
//
// Targeted eval for birth/kill changes. Runs a chosen combo N times in
// either slow-birth or --hatch mode and asserts:
//   - per-phase checkpoints landed (phase-tools-v1, phase-installed-v1,
//     phase-proxy-v1) on the cells well (slow-birth) OR on the egg's
//     well (hatch — egg-bake is what writes those)
//   - registry status flips warming → alive within ALIVE_TIMEOUT_MS
//   - cells talk <name> "ping" returns 0 with non-empty stdout (--talk-verify)
//   - kill leaves the cell absent from registry and well layer
//
// Usage:
//   bun scripts/eval-birth.ts --combo=<id> [--repeat=N] [--hatch]
//                              [--talk-verify] [--keep-on-fail]
//
//   bun scripts/eval-birth.ts --model=opus --thinking=high
//                              [--extensions=memory] [--packages=pi-web-access]
//                              [--channels=slack] [--repeat=N] ...
//
// Exit code: 0 if every iteration passes; 1 otherwise.
//
// vs scripts/harden-birth.ts:
//   harden = hourly background sweep across the matrix; tolerant; reports.
//   eval   = focused, on-demand probe of one combo with assertions; loud
//            on failure; meant to verify a specific change.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const HOME = homedir();
const REGISTRY_PATH = join(HOME, ".cells", "cells.json");
const EGGS_PATH     = join(HOME, ".cells", "eggs.json");
const SECRETS_PATH  = join(HOME, ".cells", "secrets.json");

const PHASE_CHECKPOINTS = ["phase-tools-v1", "phase-installed-v1", "phase-proxy-v1"] as const;
const ALIVE_TIMEOUT_MS = 90_000;
const ALIVE_POLL_MS    = 2_000;
// 180s comfortably covers the worst case: cell's pi-ai exhausts retries on
// the primary model (~14s of backoff) then falls over to a chain tier via
// our patched _handleRetryableError, then waits on the fallback's first
// token. 60s was tight enough that a single Anthropic outage tripped it.
const TALK_TIMEOUT_MS  = 180_000;

// ───── combo presets (mirror harden-birth.ts; intentional duplication so
// the two scripts can drift in what they consider "interesting") ─────

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

// ───── args ─────

type Args = {
  combo: Combo;
  repeat: number;
  hatch: boolean;
  talkVerify: boolean;
  keepOnFail: boolean;
};

function parseArgs(argv: string[]): Args {
  let comboId: string | null = null;
  let model: string | null = null;
  let thinking: string | null = null;
  let extensions: string[] | null = null;
  let packages: string[] | null = null;
  let channels: string[] | null = null;
  let repeat = 1;
  let hatch = false;
  let talkVerify = false;
  let keepOnFail = false;

  for (const a of argv) {
    if (a.startsWith("--combo=")) comboId = a.slice(8);
    else if (a.startsWith("--model=")) model = a.slice(8);
    else if (a.startsWith("--thinking=")) thinking = a.slice(11);
    else if (a.startsWith("--extensions=")) extensions = a.slice(13).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--packages=")) packages = a.slice(11).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--channels=")) channels = a.slice(11).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--repeat=")) repeat = Math.max(1, parseInt(a.slice(9), 10) || 1);
    else if (a === "--hatch") hatch = true;
    else if (a === "--talk-verify") talkVerify = true;
    else if (a === "--keep-on-fail") keepOnFail = true;
    else if (a === "--help" || a === "-h") { printUsage(); process.exit(0); }
    else { console.error(`unknown flag: ${a}\n`); printUsage(); process.exit(2); }
  }

  let combo: Combo | null = null;
  if (comboId) {
    combo = COMBOS.find((c) => c.id === comboId) ?? null;
    if (!combo) {
      console.error(`unknown combo: ${comboId}. known: ${COMBOS.map((c) => c.id).join(", ")}`);
      process.exit(2);
    }
  }
  if (model || thinking || extensions || packages || channels) {
    if (!model || !thinking) {
      console.error("when overriding combo with individual flags, --model= and --thinking= are required");
      process.exit(2);
    }
    combo = {
      id: comboId ?? `${model}-${thinking}`,
      model,
      thinking,
      extensions: extensions ?? combo?.extensions ?? [],
      packages:   packages   ?? combo?.packages   ?? [],
      channels:   channels   ?? combo?.channels   ?? [],
    };
  }
  if (!combo) {
    console.error("must specify --combo=<id> or --model= --thinking= ...");
    printUsage();
    process.exit(2);
  }
  return { combo, repeat, hatch, talkVerify, keepOnFail };
}

function printUsage() {
  console.log(`usage:
  bun scripts/eval-birth.ts --combo=<id> [--repeat=N] [--hatch] [--talk-verify] [--keep-on-fail]
  bun scripts/eval-birth.ts --model=<m> --thinking=<t> [--extensions=...] [--packages=...] [--channels=...] [--repeat=N] ...

combos: ${COMBOS.map((c) => c.id).join(", ")}

modes:
  default  slow-birth path (no warm egg matched). Asserts per-phase checkpoints on the cells well.
  --hatch  bakes an egg first, then births (auto-hatches). Asserts per-phase checkpoints on the eggs well.

flags:
  --repeat=N        run N iterations (default 1). Sequential — mother concurrency = 1.
  --talk-verify     after alive, run 'cells talk <name> "ping"' to confirm WS + pi handshake.
  --keep-on-fail    don't kill the cell on iteration failure (so you can poke at it).
`);
}

// ───── shelling out ─────

type CmdResult = { exitCode: number; durationMs: number; stdout: string; stderr: string; timedOut: boolean };

async function runCmd(cmd: string[], opts?: { timeoutMs?: number; stdin?: string; quiet?: boolean }): Promise<CmdResult> {
  const t0 = Date.now();
  const timeoutMs = opts?.timeoutMs;
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts?.stdin !== undefined ? "pipe" : "ignore",
  });
  if (opts?.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs) {
    timer = setTimeout(() => { timedOut = true; try { proc.kill("SIGTERM"); } catch {} }, timeoutMs);
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { exitCode, durationMs: Date.now() - t0, stdout, stderr, timedOut };
}

const runCells = (args: string[], opts?: { timeoutMs?: number }) => runCmd(["cells", ...args], opts);

// ───── reading state ─────

type RegistryCell = { name: string; status?: "warming" | "alive"; hatched_from?: string | null };
type Registry = { cells: RegistryCell[] };

async function loadRegistry(): Promise<Registry> {
  if (!existsSync(REGISTRY_PATH)) return { cells: [] };
  try { return JSON.parse(await readFile(REGISTRY_PATH, "utf-8")); }
  catch { return { cells: [] }; }
}

type Egg = { id: string; well_name: string; state: string; claimed_by?: string | null };
type EggsFile = { eggs: Egg[] };

async function loadEggs(): Promise<EggsFile> {
  if (!existsSync(EGGS_PATH)) return { eggs: [] };
  try { return JSON.parse(await readFile(EGGS_PATH, "utf-8")); }
  catch { return { eggs: [] }; }
}

async function wellsToken(): Promise<string | null> {
  if (process.env.WELL_TOKEN) return process.env.WELL_TOKEN;
  if (!existsSync(SECRETS_PATH)) return null;
  try {
    const s = JSON.parse(await readFile(SECRETS_PATH, "utf-8"));
    return typeof s.WELL_TOKEN === "string" ? s.WELL_TOKEN : null;
  } catch { return null; }
}

async function wellExists(name: string): Promise<boolean> {
  const token = await wellsToken();
  if (!token) return false;
  try {
    const r = await fetch(`https://api.sprites.dev/v1/wells/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 404) return false;
    return r.ok;
  } catch { return false; }
}

async function checkpointComments(wellName: string): Promise<string[]> {
  // `well checkpoint list -s <name>` prints a human table; we just grep
  // for the kebab-case phase markers. No JSON output flag exists today.
  const r = await runCmd(["well", "checkpoint", "list", "-s", wellName], { timeoutMs: 30_000 });
  if (r.exitCode !== 0) return [];
  const found: string[] = [];
  for (const cp of PHASE_CHECKPOINTS) {
    if (r.stdout.includes(cp)) found.push(cp);
  }
  return found;
}

async function findCell(name: string): Promise<RegistryCell | null> {
  const reg = await loadRegistry();
  return reg.cells.find((c) => c.name === name) ?? null;
}

async function wellForCell(name: string): Promise<string> {
  const cell = await findCell(name);
  if (!cell?.hatched_from) return name; // slow-birth: well name == cell name
  const eggs = await loadEggs();
  const egg = eggs.eggs.find((e) => e.id === cell.hatched_from);
  return egg?.well_name ?? name;
}

async function waitForAlive(name: string, deadline: number): Promise<{ ok: boolean; elapsedMs: number; lastStatus: string | null }> {
  const t0 = Date.now();
  let lastStatus: string | null = null;
  while (Date.now() < deadline) {
    const cell = await findCell(name);
    lastStatus = cell?.status ?? null;
    if (cell?.status === "alive") return { ok: true, elapsedMs: Date.now() - t0, lastStatus };
    await new Promise((r) => setTimeout(r, ALIVE_POLL_MS));
  }
  return { ok: false, elapsedMs: Date.now() - t0, lastStatus };
}

// ───── eval iteration ─────

type IterResult = {
  iter: number;
  name: string;
  mode: "slow" | "hatch";
  birthOk: boolean;
  birthDurationMs: number;
  checkpointsFound: string[];
  aliveFlipMs: number | null;
  talkOk: boolean | null;
  killOk: boolean;
  failure: string | null;
};

function nameFor(combo: Combo, mode: "slow" | "hatch", iter: number, ts: Date): string {
  const id = combo.id.replace(/[^a-z0-9-]+/g, "");
  const hh = String(ts.getHours()).padStart(2, "0");
  const mm = String(ts.getMinutes()).padStart(2, "0");
  const ss = String(ts.getSeconds()).padStart(2, "0");
  return `eval-${mode === "hatch" ? "h" : "s"}-${id}-${hh}${mm}${ss}-${iter}`;
}

function birthArgs(name: string, c: Combo): string[] {
  return [
    "birth", name,
    `--harness=pi`,
    `--model=${c.model}`,
    `--thinking=${c.thinking}`,
    `--extensions=${c.extensions.join(",")}`,
    `--packages=${c.packages.join(",")}`,
    `--channels=${c.channels.join(",")}`,
  ];
}

function eggArgs(c: Combo): string[] {
  // Eggs don't take --thinking or --channels; those are hatch-time.
  return [
    "egg",
    `--model=${c.model}`,
    `--extensions=${c.extensions.join(",")}`,
    `--packages=${c.packages.join(",")}`,
  ];
}

async function bakeEgg(c: Combo): Promise<{ ok: boolean; stderrTail: string; durationMs: number }> {
  const t0 = Date.now();
  const r = await runCells(eggArgs(c), { timeoutMs: 12 * 60_000 });
  return { ok: r.exitCode === 0, stderrTail: r.stderr.slice(-400), durationMs: Date.now() - t0 };
}

async function runIteration(iter: number, total: number, args: Args): Promise<IterResult> {
  const ts = new Date();
  const mode: "slow" | "hatch" = args.hatch ? "hatch" : "slow";
  const name = nameFor(args.combo, mode, iter, ts);
  const result: IterResult = {
    iter, name, mode,
    birthOk: false, birthDurationMs: 0,
    checkpointsFound: [],
    aliveFlipMs: null,
    talkOk: null,
    killOk: false,
    failure: null,
  };

  process.stdout.write(`[${iter}/${total}] ${name} · `);

  // Hatch mode pre-step: bake an egg matching the combo. Each iteration
  // consumes one egg, so we bake fresh per iteration.
  if (mode === "hatch") {
    process.stdout.write("baking egg... ");
    const egg = await bakeEgg(args.combo);
    if (!egg.ok) {
      result.failure = `egg-bake failed (${egg.durationMs}ms): ${egg.stderrTail}`;
      console.log(`\n  ✗ ${result.failure}`);
      return result;
    }
    process.stdout.write(`baked (${(egg.durationMs / 1000).toFixed(0)}s) · `);
  }

  // Birth.
  process.stdout.write("birth... ");
  const birth = await runCells(birthArgs(name, args.combo), { timeoutMs: 12 * 60_000 });
  result.birthDurationMs = birth.durationMs;
  if (birth.exitCode !== 0) {
    result.failure = `birth exit=${birth.exitCode}${birth.timedOut ? " (timed out)" : ""}: ${birth.stderr.slice(-400)}`;
    console.log(`\n  ✗ ${result.failure}`);
    return result;
  }
  result.birthOk = true;
  process.stdout.write(`✓ (${(birth.durationMs / 1000).toFixed(0)}s) · `);

  // Verify per-phase checkpoints on the appropriate well.
  const well = await wellForCell(name);
  result.checkpointsFound = await checkpointComments(well);
  const missing = PHASE_CHECKPOINTS.filter((c) => !result.checkpointsFound.includes(c));
  if (missing.length > 0) {
    result.failure = `missing phase checkpoints on well=${well}: ${missing.join(", ")}`;
    process.stdout.write(`checkpoints ✗ (missing: ${missing.join(",")}) · `);
  } else {
    process.stdout.write(`checkpoints ✓ · `);
  }

  // Wait for warming → alive flip.
  const alive = await waitForAlive(name, Date.now() + ALIVE_TIMEOUT_MS);
  result.aliveFlipMs = alive.elapsedMs;
  if (!alive.ok) {
    if (!result.failure) result.failure = `did not flip warming→alive within ${ALIVE_TIMEOUT_MS / 1000}s (lastStatus=${alive.lastStatus ?? "absent"})`;
    process.stdout.write(`alive ✗ · `);
  } else {
    process.stdout.write(`alive ✓ (${(alive.elapsedMs / 1000).toFixed(0)}s) · `);
  }

  // Optional talk-verify.
  if (args.talkVerify && alive.ok) {
    const talk = await runCells(["talk", name, "ping — reply with 'pong' and nothing else"], { timeoutMs: TALK_TIMEOUT_MS });
    const talkOk = talk.exitCode === 0 && talk.stdout.trim().length > 0;
    result.talkOk = talkOk;
    if (!talkOk) {
      if (!result.failure) result.failure = `talk-verify failed: exit=${talk.exitCode}${talk.timedOut ? " (timed out)" : ""}: ${talk.stderr.slice(-200)}`;
      process.stdout.write(`talk ✗ · `);
    } else {
      process.stdout.write(`talk ✓ · `);
    }
  }

  // Kill (skip if --keep-on-fail and we already failed something).
  const shouldKill = !(args.keepOnFail && result.failure !== null);
  if (!shouldKill) {
    process.stdout.write(`kill skipped (--keep-on-fail)`);
    console.log();
    return result;
  }

  // 10 min covers worst-case: mother lock contention (e.g. queued behind a
  // harden run) + opus retry-then-fallback + actual destroy. 5 min was tight
  // enough that a single race ended cells.ts cleanup mid-registry-write.
  const kill = await runCells(["kill", name, "--yes"], { timeoutMs: 10 * 60_000 });
  if (kill.exitCode !== 0) {
    if (!result.failure) result.failure = `kill exit=${kill.exitCode}: ${kill.stderr.slice(-300)}`;
    process.stdout.write(`kill ✗`);
    console.log();
    return result;
  }
  // Verify cleanup.
  const stillRegistered = (await findCell(name)) !== null;
  const stillWell = await wellExists(well);
  if (stillRegistered || stillWell) {
    result.failure = `kill left orphans: ${stillRegistered ? "registry" : ""}${stillRegistered && stillWell ? "+" : ""}${stillWell ? "well" : ""}`;
    process.stdout.write(`kill ✗ (orphans)`);
    console.log();
    return result;
  }
  result.killOk = true;
  process.stdout.write(`kill ✓`);
  console.log();
  return result;
}

// ───── main ─────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  console.log(`eval-birth · combo=${args.combo.id} · mode=${args.hatch ? "hatch" : "slow-birth"} · repeat=${args.repeat}${args.talkVerify ? " · talk-verify" : ""}`);
  console.log(`  model=${args.combo.model} thinking=${args.combo.thinking} ext=[${args.combo.extensions.join(",")}] pkg=[${args.combo.packages.join(",")}] ch=[${args.combo.channels.join(",")}]`);
  console.log();

  const results: IterResult[] = [];
  for (let i = 1; i <= args.repeat; i++) {
    results.push(await runIteration(i, args.repeat, args));
  }

  const passed = results.filter((r) => r.failure === null).length;
  const failed = results.length - passed;
  const dur = ((Date.now() - startedAt.getTime()) / 1000).toFixed(0);

  console.log();
  console.log(`──────`);
  console.log(`${args.combo.id} · ${args.hatch ? "hatch" : "slow-birth"} · ${results.length} iterations · ${passed} passed · ${failed} failed · ${dur}s total`);
  if (failed > 0) {
    console.log();
    for (const r of results) {
      if (r.failure) console.log(`  ✗ iter ${r.iter} (${r.name}): ${r.failure}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("eval-birth crashed:", e);
  process.exit(2);
});
