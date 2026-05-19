#!/usr/bin/env bun
//
// Targeted eval for birth/kill changes. Runs a chosen combo N times and
// asserts:
//   - `cells birth` exits 0
//   - the `born-<name>` checkpoint landed on the cell's well (ritual step 7)
//   - settings.json on the well has no surviving `__…__` placeholder and its
//     default* fields are self-consistent with modelChain[0]
//   - registry status flips warming → alive within ALIVE_TIMEOUT_MS
//   - cells talk <name> "ping" returns 0 with non-empty stdout (--talk-verify)
//   - kill leaves the cell absent from registry and well layer
//
// Usage:
//   bun scripts/eval-birth.ts --combo=<id> [--repeat=N]
//                              [--talk-verify] [--keep-on-fail]
//
//   bun scripts/eval-birth.ts --model=opus --thinking=high
//                              [--harness=pi] [--extensions=memory]
//                              [--packages=pi-web-access] [--channels=slack]
//                              [--repeat=N] ...
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
const POOL_PATH     = join(HOME, ".cells", "pool.json");

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
  harness: string;
  model: string;
  thinking: string;
  extensions: string[];
  packages: string[];
  channels: string[];
};

// Baseline = gpt-5.5 at low thinking — the free path (ChatGPT subscription
// via codex). Held-constant model on the thinking/extension/channel axes is
// gpt-5.5 for the same reason. The model axis exercises the paid providers
// (anthropic, gpt-5.5-pro both bill per-token).
const COMBOS: Combo[] = [
  { id: "smoke",          harness: "pi", model: "gpt-5.5",           thinking: "low",    extensions: [],                                    packages: [],                channels: [] },
  // model axis — the paid providers. Thinking at low to isolate the model
  // dimension; gpt-5.5-pro rejects sub-medium and the anthropic models
  // disable thinking below high, so those four hold at high.
  { id: "gpt55-pro",      harness: "pi", model: "gpt-5.5-pro",       thinking: "high",   extensions: [],                                    packages: [],                channels: [] },
  { id: "opus",           harness: "pi", model: "opus",              thinking: "high",   extensions: [],                                    packages: [],                channels: [] },
  { id: "sonnet",         harness: "pi", model: "sonnet",            thinking: "high",   extensions: [],                                    packages: [],                channels: [] },
  { id: "haiku",          harness: "pi", model: "haiku",             thinking: "high",   extensions: [],                                    packages: [],                channels: [] },
  // harness axis — claude-code runs Anthropic models through the Max sub,
  // codex runs gpt-5.5 through the ChatGPT sub (both flat subscription cost,
  // like pi's gpt-5.5); both skip extensions/packages/channels.
  { id: "cc-opus",        harness: "claude-code", model: "opus",      thinking: "high",   extensions: [],                                    packages: [],                channels: [] },
  { id: "codex-gpt55",    harness: "codex",       model: "gpt-5.5",   thinking: "low",    extensions: [],                                    packages: [],                channels: [] },
  // thinking axis — model held at gpt-5.5 (free); baseline covers `low`.
  { id: "think-off",      harness: "pi", model: "gpt-5.5",           thinking: "off",    extensions: [],                                    packages: [],                channels: [] },
  { id: "think-high",     harness: "pi", model: "gpt-5.5",           thinking: "high",   extensions: [],                                    packages: [],                channels: [] },
  // extension axis — model held at gpt-5.5 low (free).
  { id: "ext-mem",        harness: "pi", model: "gpt-5.5",           thinking: "low",    extensions: ["memory"],                            packages: [],                channels: [] },
  { id: "ext-memwiki",    harness: "pi", model: "gpt-5.5",           thinking: "low",    extensions: ["memory","wiki"],                      packages: [],                channels: [] },
  { id: "ext-all",        harness: "pi", model: "gpt-5.5",           thinking: "low",    extensions: ["memory","mentality","wiki","dream"],  packages: [],                channels: [] },
  // channel axis — model held at gpt-5.5 low (free).
  { id: "ch-slack",       harness: "pi", model: "gpt-5.5",           thinking: "low",    extensions: [],                                    packages: [],                channels: ["slack"] },
  { id: "ch-email",       harness: "pi", model: "gpt-5.5",           thinking: "low",    extensions: [],                                    packages: [],                channels: ["email"] },
  { id: "ch-both",        harness: "pi", model: "gpt-5.5",           thinking: "low",    extensions: [],                                    packages: [],                channels: ["slack","email"] },
  // crosses — multiple axes at once (paid models, occasional).
  { id: "combo-gpt",      harness: "pi", model: "gpt-5.5-pro",       thinking: "high",   extensions: ["memory"],                            packages: ["pi-web-access"], channels: ["slack"] },
  { id: "combo-opus",     harness: "pi", model: "opus",              thinking: "high",   extensions: ["memory"],                            packages: [],                channels: [] },
];

// ───── args ─────

type Args = {
  combo: Combo;
  repeat: number;
  talkVerify: boolean;
  keepOnFail: boolean;
};

function parseArgs(argv: string[]): Args {
  let comboId: string | null = null;
  let harness: string | null = null;
  let model: string | null = null;
  let thinking: string | null = null;
  let extensions: string[] | null = null;
  let packages: string[] | null = null;
  let channels: string[] | null = null;
  let repeat = 1;
  let talkVerify = false;
  let keepOnFail = false;

  for (const a of argv) {
    if (a.startsWith("--combo=")) comboId = a.slice(8);
    else if (a.startsWith("--harness=")) harness = a.slice(10);
    else if (a.startsWith("--model=")) model = a.slice(8);
    else if (a.startsWith("--thinking=")) thinking = a.slice(11);
    else if (a.startsWith("--extensions=")) extensions = a.slice(13).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--packages=")) packages = a.slice(11).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--channels=")) channels = a.slice(11).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--repeat=")) repeat = Math.max(1, parseInt(a.slice(9), 10) || 1);
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
  if (harness || model || thinking || extensions || packages || channels) {
    if (!model || !thinking) {
      console.error("when overriding combo with individual flags, --model= and --thinking= are required");
      process.exit(2);
    }
    combo = {
      id: comboId ?? `${model}-${thinking}`,
      harness:    harness    ?? combo?.harness    ?? "pi",
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
  return { combo, repeat, talkVerify, keepOnFail };
}

function printUsage() {
  console.log(`usage:
  bun scripts/eval-birth.ts --combo=<id> [--repeat=N] [--talk-verify] [--keep-on-fail]
  bun scripts/eval-birth.ts --model=<m> --thinking=<t> [--harness=pi] [--extensions=...] [--packages=...] [--channels=...] [--repeat=N] ...

combos: ${COMBOS.map((c) => c.id).join(", ")}

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

// The egg pool. Birth claims one warm member; on success the member flips
// to `live` and carries the cell name. `id` is the stable handle the
// registry's `hatched_from` points at.
type PoolMember = { id: string; well_name: string; state: string; cell_name?: string | null };
type PoolFile = { version: number; members: PoolMember[] };

async function loadPool(): Promise<PoolFile> {
  if (!existsSync(POOL_PATH)) return { version: 1, members: [] };
  try { return JSON.parse(await readFile(POOL_PATH, "utf-8")); }
  catch { return { version: 1, members: [] }; }
}

// Does the well still exist? Queried through the `well` CLI, which
// authenticates via ~/.wells/token. `well info` exits 0 even on a 404 —
// it prints an error line instead of JSON — so absence shows up as the
// JSON parse failing.
async function wellExists(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["well", "info", "-s", name, "--json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return false;
    JSON.parse(stdout);
    return true;
  } catch {
    return false;
  }
}

async function findCell(name: string): Promise<RegistryCell | null> {
  const reg = await loadRegistry();
  return reg.cells.find((c) => c.name === name) ?? null;
}

// Resolve a cell to the well it actually runs on. Birth claims a generic
// egg from the pool, so the well name is the egg's permanent well_name —
// not the cell name. The registry's `hatched_from` points at the pool
// member's `id`; fall back to the cell name if the pool entry is gone.
async function wellForCell(name: string): Promise<string> {
  const cell = await findCell(name);
  if (!cell?.hatched_from) return name;
  const pool = await loadPool();
  const member = pool.members.find((m) => m.id === cell.hatched_from);
  return member?.well_name ?? name;
}

// `well checkpoint list -s <name>` prints a human table; grep it for the
// `born-<name>` marker the ritual's step 7 lays down. No JSON output flag
// exists today.
async function hasBornCheckpoint(wellName: string, cellName: string): Promise<boolean> {
  const r = await runCmd(["well", "checkpoint", "list", "-s", wellName], { timeoutMs: 30_000 });
  if (r.exitCode !== 0) return false;
  return r.stdout.includes(`born-${cellName}`);
}

// Read settings.json on the well and verify the birth-time substitutions
// landed: no surviving `__…__` placeholder (a no-op sed), modelChain is a
// non-empty array, and defaultProvider/defaultModel/defaultThinkingLevel
// agree with modelChain[0] (`<provider>/<modelId>:<thinking>`). Returns
// null on infra error (can't reach the well) — caller treats null as
// "couldn't check", not a failure.
async function verifySettingsOnWell(wellName: string): Promise<boolean | null> {
  const r = await runCmd(
    ["well", "exec", "-s", wellName, "--", "cat", "/root/.pi/settings.json"],
    { timeoutMs: 30_000 },
  );
  if (r.exitCode !== 0) return null;
  try {
    if (/__[A-Z_]+__/.test(r.stdout)) return false;
    const parsed = JSON.parse(r.stdout);
    const chain = parsed?.modelChain;
    if (!Array.isArray(chain) || chain.length === 0) return false;
    const m = String(chain[0] ?? "").match(/^([^/]+)\/(.+):([^:]+)$/);
    if (!m) return false;
    const [, provider, modelId, thinking] = m;
    if (parsed.defaultProvider !== provider) return false;
    if (parsed.defaultModel !== modelId) return false;
    if (parsed.defaultThinkingLevel !== thinking) return false;
    return true;
  } catch {
    return false;
  }
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
  birthOk: boolean;
  birthDurationMs: number;
  bornCheckpoint: boolean;
  settingsOk: boolean | null;
  aliveFlipMs: number | null;
  talkOk: boolean | null;
  killOk: boolean;
  failure: string | null;
};

function nameFor(combo: Combo, iter: number, ts: Date): string {
  const id = combo.id.replace(/[^a-z0-9-]+/g, "");
  const hh = String(ts.getHours()).padStart(2, "0");
  const mm = String(ts.getMinutes()).padStart(2, "0");
  const ss = String(ts.getSeconds()).padStart(2, "0");
  return `eval-${id}-${hh}${mm}${ss}-${iter}`;
}

function birthArgs(name: string, c: Combo): string[] {
  return [
    "birth", name,
    `--harness=${c.harness}`,
    `--model=${c.model}`,
    `--thinking=${c.thinking}`,
    `--extensions=${c.extensions.join(",")}`,
    `--packages=${c.packages.join(",")}`,
    `--channels=${c.channels.join(",")}`,
  ];
}

async function runIteration(iter: number, total: number, args: Args): Promise<IterResult> {
  const ts = new Date();
  const name = nameFor(args.combo, iter, ts);
  const result: IterResult = {
    iter, name,
    birthOk: false, birthDurationMs: 0,
    bornCheckpoint: false,
    settingsOk: null,
    aliveFlipMs: null,
    talkOk: null,
    killOk: false,
    failure: null,
  };

  process.stdout.write(`[${iter}/${total}] ${name} · `);

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

  const well = await wellForCell(name);

  // The ritual's step 7 checkpoints the configured cell as `born-<name>`.
  result.bornCheckpoint = await hasBornCheckpoint(well, name);
  if (!result.bornCheckpoint) {
    result.failure = `no born-${name} checkpoint on well=${well}`;
    process.stdout.write(`checkpoint ✗ · `);
  } else {
    process.stdout.write(`checkpoint ✓ · `);
  }

  // settings.json substitutions actually landed.
  result.settingsOk = await verifySettingsOnWell(well);
  if (result.settingsOk === false) {
    if (!result.failure) result.failure = `settings.json on well=${well} failed verification (placeholder left, or default*/chain mismatch)`;
    process.stdout.write(`settings ✗ · `);
  } else if (result.settingsOk === null) {
    process.stdout.write(`settings ? · `);
  } else {
    process.stdout.write(`settings ✓ · `);
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

  // Kill is deterministic now — `well destroy --force` + local fs cleanup,
  // no mother round-trip. 2 min is generous headroom over the few seconds
  // it actually takes.
  const kill = await runCells(["kill", name, "--yes"], { timeoutMs: 2 * 60_000 });
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

  console.log(`eval-birth · combo=${args.combo.id} · repeat=${args.repeat}${args.talkVerify ? " · talk-verify" : ""}`);
  console.log(`  harness=${args.combo.harness} model=${args.combo.model} thinking=${args.combo.thinking} ext=[${args.combo.extensions.join(",")}] pkg=[${args.combo.packages.join(",")}] ch=[${args.combo.channels.join(",")}]`);
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
  console.log(`${args.combo.id} · ${results.length} iterations · ${passed} passed · ${failed} failed · ${dur}s total`);
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
