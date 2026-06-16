#!/usr/bin/env bun
import { $ } from "bun";
import { readFile, writeFile, appendFile, mkdir, unlink, symlink, cp, readdir, stat, rm, rename, mkdtemp, copyFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, basename, relative } from "node:path";
import { existsSync, statSync, readFileSync, unlinkSync, writeFileSync, readdirSync, openSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { createHash, randomBytes } from "node:crypto";
import { planReconcileEvictions, selectStaleRevCull } from "./lib/reconcile";
import { findOrphanWells } from "./lib/orphan-wells";
import { dnaRev, summarizeDnaDrift } from "./lib/dna-rev";
import { CELLS_ENV_SH_BODY } from "./lib/cells-env";
import {
  parseSecretArgs,
  buildSecretSetScript,
  buildSecretRmScript,
  buildSecretListScript,
  parseSecretListOutput,
  stripTrailingNewlines,
  type SecretSource,
} from "./lib/secret-cli";
import { ulid } from "./shared/agent-envelope";
import { needsSeal } from "./lib/hibernate-ready";
import { SECRETS_PATH, readSecret } from "./lib/secrets";
import {
  validateCellName,
  isValidCellName,
  describeCellNameRules,
  isMotherName,
  motherJobRefusalReason,
  projectOfMother,
  projectMotherName,
  projectCellName,
  isPulseName,
  projectOfPulse,
  projectPulseName,
} from "./lib/cell-name";
import { pulseOwner, projectScheduledCells } from "./lib/pulse-owner";
import { loadPostworkSummary, removePostwork, type PostworkSummary } from "./lib/postwork";
import { compileBrief, type BriefVocab } from "./lib/brief";
import { REGISTRY_DIR } from "./lib/paths";
import {
  loadRegistry,
  mutateRegistry,
  findCell,
  findCellIn,
  isNameTaken,
  upsertBirthingCell,
  promoteCell,
  removeCell,
  cullStaleWarming,
  type Cell,
  type Registry,
} from "./lib/registry";
import {
  V1_POOL_VARIANT_SIGNATURE,
  V1_POOL_TARGET_DEPTH,
  V1_RUNNING_POOL_TARGET,
  loadPool,
  savePool,
  withPoolLock,
  countOpenPoolMembers,
  type PoolMember,
  type PoolMemberState,
  type PoolFile,
} from "./lib/pool";
import { tryAcquireRefillLock, releaseRefillLock, refillLockHolder } from "./lib/refill-lock";
import {
  CHANNELS_PATH,
  type ChannelKind,
  type ChannelsFile,
  CHANNEL_ID_PATTERNS,
  loadChannels,
  saveChannels,
  kvUpsert,
  kvDelete,
  evictChannelBindingsForCell,
  ensureSlackChannel,
  resolveSlackUserId,
  inviteSlackUser,
  updateCellStatusChannels,
} from "./lib/channels";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const DNA_ROOT = join(REPO_ROOT, "dna");
const SPECIALS_DIR = join(DNA_ROOT, "specials");
const MOTHER_ROOT = join(SPECIALS_DIR, "mother");
const PULSE_ROOT = join(SPECIALS_DIR, "pulse");
const DNA_DIR = join(DNA_ROOT, "cells/base");
// REGISTRY_DIR + REGISTRY_PATH are canonical in ./lib/paths — imported
// above. Pool paths live there too; pool.ts owns the pool functions.
const CONFIG_PATH = join(REGISTRY_DIR, "config.json");
const MOTHER_LOCK_PATH = join(REGISTRY_DIR, "mother.lock");

// Cells-side control-panel for the wells substrate. Operator-owned.
// We tell wells what suffix to dispatch on (welld's WELL_PUBLIC_BASE)
// and we use that same suffix everywhere we construct a per-well
// hostname (deploy-cell-worker.sh, tryConnectLocalWelld, etc.). One
// source of truth on disk so a misalignment is visible.
type CellsConfig = {
  /** Host suffix welld dispatches on. <well-name>.<this> resolves to the well's site server. */
  well_public_base: string;
};
const DEFAULT_CONFIG: CellsConfig = {
  well_public_base: "cells.md",
};
async function loadCellsConfig(): Promise<CellsConfig> {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  try {
    const j = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as Partial<CellsConfig>;
    return { ...DEFAULT_CONFIG, ...j };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
async function saveCellsConfig(cfg: CellsConfig): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(REGISTRY_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
async function wellPublicBase(): Promise<string> {
  return process.env.WELL_PUBLIC_BASE ?? (await loadCellsConfig()).well_public_base;
}

// Model registry — short name → { provider, modelId }. "opus" is deliberately
// NOT version-stamped (Pete 2026-06-11: opus always means the latest Opus).
// Two layers make that real with nothing to bump when a new Opus ships:
//   1. the claude CLI resolves the bare `opus` alias to the newest Opus, and
//   2. the proxy rewrites ANY opus-family ID in a request body to the latest
//      Opus discovered from GET /v1/models (cli/lib/model-normalizer.ts) —
//      covering stale binaries and old pinned settings too.
// sonnet/haiku stay major-version-stamped; nothing chats on them.
const MODEL_IDS = {
  opus:                { provider: "anthropic", modelId: "opus" },
  sonnet:              { provider: "anthropic", modelId: "claude-sonnet-4-6" },
  haiku:               { provider: "anthropic", modelId: "claude-haiku-4-5" },
  "gpt-5.5":           { provider: "openai-codex", modelId: "gpt-5.5" },
  "gpt-5.5-pro":       { provider: "openai",    modelId: "gpt-5.5-pro" },
} as const;
type ModelKey = keyof typeof MODEL_IDS;

// Default fallback chain: if the cell's primary model fails (e.g. terminated
// SSE, 5xx, overloaded, usage_limit), pi-coding-agent's patched
// _handleRetryableError advances to the next entry. Sticky for the rest of
// the session — user can /model back manually. Each entry is
// `<provider>/<modelId>:<thinking>` shorthand; pi-coding-agent's
// parseModelPattern resolves it.
//
// Two-subscription pattern, no per-token leaf:
//   - anthropic primary (claude-code harness only — the Max sub is
//     claude-code-exclusive, Pete 2026-06-11) → opus → gpt-5.5:high
//   - openai-codex primary → gpt-5.5 (no fallback — already the cheap leaf)
//
// If both subscriptions degrade simultaneously (observed 2026-05-06), the
// fleet pauses until one recovers. Deepseek was the API-billed third tier
// for exactly this scenario; dropped 2026-05-19 to stop the per-token bill.
// Add a leaf back if dual-degradation starts costing us real downtime.
function buildDefaultChain(
  primary: { provider: string; modelId: string; thinking: string },
  _harness: string,
): string[] {
  const head = `${primary.provider}/${primary.modelId}:${primary.thinking}`;
  if (primary.provider === "anthropic") {
    return [head, "openai-codex/gpt-5.5:high"];
  }
  return [head];
}

// In-tree extensions a user can opt into at create time. Each lives at
// dna/cells/base/.pi/extensions/<name>/ — birth pushes the whole dna, then
// deletes the unselected ones from the cell.
const OPTIONAL_EXTENSIONS = ["memory", "mentality", "wiki", "dream", "deep-research"] as const;
type OptionalExtension = (typeof OPTIONAL_EXTENSIONS)[number];

// Curated list of npm/git packages a cell CAN install via `pi install` at
// birth time. Most common extensions are now pre-loaded onto cell-base
// during bake, so this list is for things that need per-cell choice.
// `defaultChecked` is for when this list grows again — none of the
// current entries are auto-selected since they're already in the image.
const OPTIONAL_PACKAGES = [
  { value: "pi-web-access", label: "pi-web-access", hint: "web search · fetch · code search (pre-installed)", defaultChecked: false },
] as const;

const RESERVED_NAMES = new Set([
  "mother", "keeper",
  // Names that collide with tmux/well plumbing.
  "tmux", "shell", "agent", "pi", "sprite", "well", "localhost",
  // Names that collide with cells subcommands.
  "create", "birth", "talk", "list", "sleep", "stop", "wake",
  "checkpoint", "destroy", "kill", "dream", "tui", "sync", "doctor",
  "schedule-pi-patches", "unschedule-pi-patches",
  "schedule-host-bridge", "unschedule-host-bridge",
  "refresh-extensions", "heartbeat", "pulse",
  "channel", "channels",
  "menubar",
]);

type SelectOption = {
  value: string;
  label: string;
  hint?: string;       // dim text after label, e.g. "(coming soon)"
  disabled?: boolean;
};

const HARNESS_OPTIONS: SelectOption[] = [
  { value: "pi",          label: "pi" },
  { value: "claude-code", label: "claude-code", hint: "(Anthropic models via Max)" },
  { value: "codex",       label: "codex",       hint: "(OpenAI models via ChatGPT sub)" },
  { value: "hermes",      label: "hermes",      hint: "(Nous Research agent · GPT-5.5 via ChatGPT sub)" },
];

// The executable a `cells run` job invokes for each harness — used by the
// refresh readiness-gate to confirm a job could actually spawn (the harness
// resolves on the job PATH) before `cells refresh` returns ✓.
const HARNESS_JOB_BIN: Record<string, string> = {
  "pi": "pi",
  "claude-code": "claude",
  "codex": "codex",
  "hermes": "hermes",
};

const MODEL_OPTIONS: SelectOption[] = [
  { value: "opus",        label: "opus",        hint: "(Anthropic · via Max sub)" },
  { value: "sonnet",      label: "sonnet",      hint: "(Anthropic · via Max sub)" },
  { value: "haiku",       label: "haiku",       hint: "(Anthropic · via Max sub)" },
  { value: "gpt-5.5",     label: "gpt-5.5",     hint: "(sub · ChatGPT Plus)" },
  { value: "gpt-5.5-pro", label: "gpt-5.5-pro", hint: "(api · paid)" },
];

// Pi thinking levels — `xhigh` only takes effect on a few codex-max models;
// it silently downgrades elsewhere. Models that don't support thinking at
// all just ignore the setting. Pass through whatever the user picks.
//
// `adaptive` is opus-only sugar: pi-ai already sends `type: "adaptive"` for
// every opus thinking level, so the levels tune the effort knob inside
// adaptive mode. This shortcut means "let the model decide depth, balanced
// effort" — submit-time it's translated to "medium" for pi-ai consumption.
const THINKING_OPTIONS_BASE: SelectOption[] = [
  { value: "off",     label: "off" },
  { value: "minimal", label: "minimal" },
  { value: "low",     label: "low" },
  { value: "medium",  label: "medium" },
  { value: "high",    label: "high" },
  { value: "xhigh",   label: "xhigh", hint: "(codex-max only; ignored elsewhere)" },
];
const ADAPTIVE_OPTION: SelectOption = {
  value: "adaptive",
  label: "adaptive",
  hint: "(opus only — model decides depth, no effort hint)",
};
const THINKING_OPTIONS = THINKING_OPTIONS_BASE;
const THINKING_VALUES = [...THINKING_OPTIONS_BASE.map((o) => o.value), "adaptive"];
const DEFAULT_THINKING = "medium";

// claude-code's effortLevel scale (what the in-cell `/effort` slider shows).
// Substituted verbatim into .claude/settings.json's `effortLevel` field.
const THINKING_OPTIONS_CLAUDE_CODE: SelectOption[] = [
  { value: "auto",   label: "auto",   hint: "(let the model decide)" },
  { value: "low",    label: "low" },
  { value: "medium", label: "medium" },
  { value: "high",   label: "high" },
  { value: "xhigh",  label: "xhigh" },
  { value: "max",    label: "max" },
];

// codex's model_reasoning_effort scale. `xhigh` is codex's value; the
// codex TUI labels it "Extra high".
const THINKING_OPTIONS_CODEX: SelectOption[] = [
  { value: "low",    label: "low" },
  { value: "medium", label: "medium" },
  { value: "high",   label: "high" },
  { value: "xhigh",  label: "extra high" },
];

// Anthropic models silently disable thinking at sub-high levels — their
// thinkingLevelMap only contains entries for high/xhigh, so medium maps
// to "off". Default Claude cells to high so birth doesn't quietly produce
// a thinking-less cell. Other providers honor medium fine.
function defaultThinkingFor(modelKey: ModelKey): string {
  const provider = MODEL_IDS[modelKey].provider;
  return provider === "anthropic" ? "high" : DEFAULT_THINKING;
}

function thinkingOptionsFor(modelKey: ModelKey): SelectOption[] {
  return modelKey === "opus" ? [...THINKING_OPTIONS_BASE, ADAPTIVE_OPTION] : THINKING_OPTIONS_BASE;
}

// Harness-aware picker: claude-code and codex have their own effort scales
// (different value sets, different labels). pi keeps the per-model picker.
function thinkingOptionsForHarness(harness: string, modelKey: ModelKey): SelectOption[] {
  if (harness === "claude-code") return THINKING_OPTIONS_CLAUDE_CODE;
  if (harness === "codex") return THINKING_OPTIONS_CODEX;
  // hermes runs gpt-5.5 — same reasoning-effort scale as codex.
  if (harness === "hermes") return THINKING_OPTIONS_CODEX;
  return thinkingOptionsFor(modelKey);
}

// Models offered for a given harness. The coding-machine harnesses each run
// a single subscription-backed model, so the picker shows just that one
// pinned option. The Model step is still always rendered — the user should
// always see (and confirm) what their cell will run, even when there's
// nothing to choose between.
function modelOptionsForHarness(harness: string): SelectOption[] {
  if (harness === "claude-code") {
    return [{ value: "opus", label: "opus", hint: "(Anthropic · via Max sub)" }];
  }
  if (harness === "codex" || harness === "hermes") {
    return [{ value: "gpt-5.5", label: "gpt-5.5", hint: "(OpenAI · via ChatGPT sub)" }];
  }
  // pi: no Anthropic rows — the Max sub is claude-code-harness-only
  // (Pete, 2026-06-11). pi rides the ChatGPT sub, gpt-5.5-pro is the
  // metered escape hatch.
  return MODEL_OPTIONS.filter((o) => MODEL_IDS[o.value as ModelKey].provider !== "anthropic");
}

function defaultThinkingForHarness(harness: string, modelKey: ModelKey): string {
  if (harness === "claude-code") return "high";
  if (harness === "codex") return "medium";
  if (harness === "hermes") return "medium";
  return defaultThinkingFor(modelKey);
}

// Match each harness's own terminology so the picker mirrors what the
// user sees once they're inside the cell.
function thinkingPromptFor(harness: string): string {
  if (harness === "claude-code") return "Effort?";
  if (harness === "codex") return "Reasoning?";
  if (harness === "hermes") return "Reasoning?";
  return "Thinking?";
}

// Models that reject low-effort thinking levels server-side. gpt-5.5-pro
// returns 400 if you give it off/minimal/low. Grow this set as new
// reasoning-only models surface.
const MIN_MEDIUM_THINKING_MODELS = new Set<ModelKey>(["gpt-5.5-pro"]);
const SUB_MEDIUM_THINKING = new Set<string>(["off", "minimal", "low"]);

// Models that accept "adaptive" — only opus today.
const ADAPTIVE_THINKING_MODELS = new Set<ModelKey>(["opus"]);

const EXTENSION_OPTIONS: SelectOption[] = OPTIONAL_EXTENSIONS.map((p) => ({
  value: p,
  label: p,
}));

// Channels — what messaging surfaces the cell is reachable on. Each
// implies its own infra setup at birth (Slack: auto-create channel,
// bind, deploy CF worker). Keep the list short and additive.
const CHANNEL_VALUES = ["slack", "email"] as const;
type ChannelValue = (typeof CHANNEL_VALUES)[number];
const CHANNEL_OPTIONS: SelectOption[] = [
  { value: "slack", label: "slack" },
  { value: "email", label: "email", hint: "<cell>@cells.md" },
];

const PACKAGE_OPTIONS: SelectOption[] = OPTIONAL_PACKAGES.map((p) => ({
  value: p.value,
  label: p.label,
  hint: p.hint,
}));

const PACKAGE_DEFAULTS: string[] = OPTIONAL_PACKAGES.filter((p) => p.defaultChecked).map((p) => p.value);

// Cell / Registry types + loadRegistry / saveRegistry / findCell are
// canonical in ./lib/registry — imported above.

// ───── pool.json — pre-warmed cell pool ─────
//
// Eggs are wells with the toolchain installed but no agent identity.
// Hatching = claiming an egg, sed-substituting (NAME, MODEL, PROVIDER,
// THINKING) onto it, registering its site service, and starting pi.
// Auto-hatch in cmdCreate looks for a open egg matching the requested
// variant signature; if none, falls back to the slow build-from-scratch
// path. See docs/eggs-phase-1.md for the full design.

// Atomically claim a open egg matching the predicate. Returns the
// claimed egg (state transitioned to "claimed", claimed_at + claimed_by
// populated) or null if no match.
async function claimEgg(
  match: (e: PoolMember) => boolean,
  claimedBy: string,
): Promise<PoolMember | null> {
  return withPoolLock(async () => {
    const file = await loadPool();
    const egg = file.members.find((e) => e.state === "open" && match(e));
    if (!egg) return null;
    egg.state = "claimed";
    egg.claimed_at = new Date().toISOString();
    egg.claimed_by = claimedBy;
    await savePool(file);
    return egg;
  });
}

// Mark an egg as live (after its hatch's site service registered and pi
// is up). Pete can then `cells pool list` and see claimed members that have
// graduated into cells. Phase 3 may auto-cull these once the cell is
// killed; v1 leaves them as breadcrumbs.
async function markEggLive(eggId: string): Promise<void> {
  await withPoolLock(async () => {
    const file = await loadPool();
    const egg = file.members.find((e) => e.id === eggId);
    if (!egg) return;
    egg.state = "live";
    await savePool(file);
  });
}

// Mark an egg for culling (after a hatch failure). Pete cleans up via
// `cells pool cull <id>`.
async function markEggCulling(eggId: string): Promise<void> {
  await withPoolLock(async () => {
    const file = await loadPool();
    const egg = file.members.find((e) => e.id === eggId);
    if (!egg) return;
    egg.state = "culling";
    await savePool(file);
  });
}

async function requireCell(name: string): Promise<Cell> {
  const c = await findCell(name);
  if (!c) {
    console.error(`cell '${name}' not found in registry`);
    process.exit(1);
  }
  return c;
}

function needName(args: string[], cmd: string): string {
  if (!args[0]) {
    console.error(`usage: cell ${cmd} <name>`);
    process.exit(1);
  }
  return args[0];
}

async function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim();
}

// ───── TUI primitives (raw stdin, no deps) ─────

function tuiBegin() {
  if (!process.stdin.isTTY) throw new Error("TUI requires a TTY");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l"); // hide cursor
}

function tuiEnd() {
  process.stdout.write("\x1b[?25h"); // show cursor
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

function clearFrame(height: number) {
  if (height > 0) process.stdout.write(`\x1b[${height}A\x1b[J`);
}

// Number of visual rows a frame occupies, accounting for line wrapping in the
// terminal. `frame.split("\n").length` undercounts when any line is wider than
// the terminal — that miscount causes ghost headers to accumulate on redraw.
function visualHeight(frame: string): number {
  const cols = Math.max(1, process.stdout.columns ?? 80);
  let rows = 0;
  for (const line of frame.split("\n")) {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    rows += Math.max(1, Math.ceil(stripped.length / cols));
  }
  return rows;
}

function renderOption(
  opt: SelectOption,
  isCursor: boolean,
  prefix: string, // pointer + (optional) checkbox glyph
): string {
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const cyan = "\x1b[36m";
  const hint = opt.hint ? ` ${dim}${opt.hint}${reset}` : "";
  if (opt.disabled) return `${prefix} ${dim}${opt.label}${reset}${hint}`;
  if (isCursor) return `${cyan}${prefix} ${opt.label}${reset}${hint}`;
  return `${prefix} ${opt.label}${hint}`;
}

// Sentinel returned from selectOne/selectMany when the user hits the back
// key (Left arrow / Backspace) and `canGoBack` was true. The caller is then
// responsible for clearing the previous prompt's summary and re-running it.
const BACK = Symbol("back");
type Back = typeof BACK;

const BACK_KEYS = new Set(["\x1b[D", "\x7f", "\x08"]); // ←, DEL, BS

async function selectOne(
  prompt: string,
  options: SelectOption[],
  opts: { initialValue?: string; canGoBack?: boolean } = {},
): Promise<string | Back> {
  const enabled = options
    .map((o, i) => (o.disabled ? -1 : i))
    .filter((i) => i >= 0);
  if (enabled.length === 0) throw new Error("no enabled options");

  const initialIdx = opts.initialValue
    ? options.findIndex((o) => o.value === opts.initialValue && !o.disabled)
    : -1;
  let cursor = initialIdx >= 0 ? initialIdx : enabled[0]!;
  let lastHeight = 0;
  const canGoBack = opts.canGoBack ?? false;

  const drawMenu = (): string => {
    const lines: string[] = [`\x1b[1m${prompt}\x1b[0m`];
    for (let i = 0; i < options.length; i++) {
      const isCursor = i === cursor;
      const pointer = isCursor ? "❯" : " ";
      lines.push(renderOption(options[i]!, isCursor, pointer));
    }
    const back = canGoBack ? " · ←/⌫ back" : "";
    lines.push(`\x1b[2m  ↑↓ move · enter select${back} · esc cancel\x1b[0m`);
    return lines.join("\n");
  };

  const drawSummary = (): string =>
    `\x1b[1m${prompt}\x1b[0m \x1b[36m${options[cursor]!.value}\x1b[0m`;

  const writeMenu = () => {
    clearFrame(lastHeight);
    const frame = drawMenu();
    process.stdout.write(frame + "\n");
    lastHeight = visualHeight(frame);
  };

  tuiBegin();
  return new Promise<string | Back>((resolve) => {
    writeMenu();
    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      if (s === "\x03" || s === "\x1b") {
        // Ctrl-C or bare ESC → cancel cleanly. (Arrow keys arrive as
        // multi-byte escape sequences like "\x1b[A", so a single-byte
        // "\x1b" is unambiguously ESC.)
        process.stdin.off("data", onData);
        clearFrame(lastHeight);
        tuiEnd();
        process.stdout.write("\x1b[2mcancelled\x1b[0m\n");
        process.exit(130);
      }
      if (s === "\r" || s === "\n") {
        process.stdin.off("data", onData);
        clearFrame(lastHeight);
        process.stdout.write(drawSummary() + "\n");
        tuiEnd();
        resolve(options[cursor]!.value);
        return;
      }
      if (canGoBack && BACK_KEYS.has(s)) {
        process.stdin.off("data", onData);
        clearFrame(lastHeight);
        tuiEnd();
        resolve(BACK);
        return;
      }
      let move: -1 | 0 | 1 = 0;
      if (s === "\x1b[A" || s === "k") move = -1;
      else if (s === "\x1b[B" || s === "j") move = 1;
      if (move !== 0) {
        const idx = enabled.indexOf(cursor);
        const next = (idx + move + enabled.length) % enabled.length;
        cursor = enabled[next]!;
        writeMenu();
      }
    };
    process.stdin.on("data", onData);
  });
}

async function selectMany(
  prompt: string,
  options: SelectOption[],
  opts: { initialChecked?: string[]; canGoBack?: boolean } = {},
): Promise<string[] | Back> {
  const enabled = options
    .map((o, i) => (o.disabled ? -1 : i))
    .filter((i) => i >= 0);
  if (enabled.length === 0) throw new Error("no enabled options");

  let cursor = enabled[0]!;
  const initialChecked = opts.initialChecked ?? [];
  const checked = new Set<number>(
    initialChecked
      .map((v) => options.findIndex((o) => o.value === v))
      .filter((i) => i >= 0 && !options[i]!.disabled),
  );
  let lastHeight = 0;
  const canGoBack = opts.canGoBack ?? false;

  const drawMenu = (): string => {
    const lines: string[] = [`\x1b[1m${prompt}\x1b[0m`];
    for (let i = 0; i < options.length; i++) {
      const isCursor = i === cursor;
      const isChecked = checked.has(i);
      const pointer = isCursor ? "❯" : " ";
      const box = isChecked ? "[\x1b[36mx\x1b[0m]" : "[ ]";
      lines.push(renderOption(options[i]!, isCursor, `${pointer} ${box}`));
    }
    const back = canGoBack ? " · ←/⌫ back" : "";
    lines.push(`\x1b[2m  ↑↓ move · space toggle · enter confirm${back} · esc cancel\x1b[0m`);
    return lines.join("\n");
  };

  const drawSummary = (): string => {
    const picked = Array.from(checked)
      .sort((a, b) => a - b)
      .map((i) => options[i]!.value);
    const list = picked.length === 0 ? "\x1b[2m(none)\x1b[0m" : `\x1b[36m${picked.join(", ")}\x1b[0m`;
    return `\x1b[1m${prompt}\x1b[0m ${list}`;
  };

  const writeMenu = () => {
    clearFrame(lastHeight);
    const frame = drawMenu();
    process.stdout.write(frame + "\n");
    lastHeight = visualHeight(frame);
  };

  tuiBegin();
  return new Promise<string[] | Back>((resolve) => {
    writeMenu();
    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      if (s === "\x03" || s === "\x1b") {
        // Ctrl-C or bare ESC → cancel cleanly. (Arrow keys arrive as
        // multi-byte escape sequences like "\x1b[A", so a single-byte
        // "\x1b" is unambiguously ESC.)
        process.stdin.off("data", onData);
        clearFrame(lastHeight);
        tuiEnd();
        process.stdout.write("\x1b[2mcancelled\x1b[0m\n");
        process.exit(130);
      }
      if (s === "\r" || s === "\n") {
        process.stdin.off("data", onData);
        clearFrame(lastHeight);
        process.stdout.write(drawSummary() + "\n");
        tuiEnd();
        const picked = Array.from(checked)
          .sort((a, b) => a - b)
          .map((i) => options[i]!.value);
        resolve(picked);
        return;
      }
      if (s === " ") {
        if (!options[cursor]!.disabled) {
          if (checked.has(cursor)) checked.delete(cursor);
          else checked.add(cursor);
          writeMenu();
        }
        return;
      }
      if (canGoBack && BACK_KEYS.has(s)) {
        process.stdin.off("data", onData);
        clearFrame(lastHeight);
        tuiEnd();
        resolve(BACK);
        return;
      }
      let move: -1 | 0 | 1 = 0;
      if (s === "\x1b[A" || s === "k") move = -1;
      else if (s === "\x1b[B" || s === "j") move = 1;
      if (move !== 0) {
        const idx = enabled.indexOf(cursor);
        const next = (idx + move + enabled.length) % enabled.length;
        cursor = enabled[next]!;
        writeMenu();
      }
    };
    process.stdin.on("data", onData);
  });
}

function spawnInRepo(cmd: string[], env?: Record<string, string>) {
  return Bun.spawn(cmd, {
    cwd: MOTHER_ROOT,
    env: env ? { ...process.env, ...env } : undefined,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function runPi(slashCommand: string, args: string[]): Promise<number> {
  const message = `/${slashCommand} ${args.join(" ")}`.trim();
  const proc = spawnInRepo(["pi", "-p", message]);
  return await proc.exited;
}

type Outcome = { success: boolean; message: string };

// Mother concurrency = 1. Two parallel `pi -p` invocations against
// mother contend for the OAuth/proxy session and one gets SIGTERMed
// after ~175s (per project_mother_concurrency.md). Symptom: the user
// sees "terminated" + "agent did not report outcome" — observed when
// the harden cron fired during a manual `cells birth`. The lock below
// serializes every mother-orchestrated command across all processes
// on this machine. Holders include their PID and label so a stuck
// holder is diagnosable. Stale locks (process gone) are reclaimed.
let weHoldMotherLock = false;

function cleanupMotherLockSync(): void {
  if (!weHoldMotherLock) return;
  try {
    const raw = readFileSync(MOTHER_LOCK_PATH, "utf-8");
    const holder = JSON.parse(raw) as { pid: number };
    if (holder.pid === process.pid) unlinkSync(MOTHER_LOCK_PATH);
  } catch {
    // best-effort
  }
  weHoldMotherLock = false;
}

let signalHandlersInstalled = false;
function ensureSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on("exit", cleanupMotherLockSync);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      cleanupMotherLockSync();
      process.exit(130);
    });
  }
}

async function withMotherLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  ensureSignalHandlers();

  // Wait for any existing holder to clear, then claim.
  let warned = false;
  while (existsSync(MOTHER_LOCK_PATH)) {
    let holder: { pid: number; startedAt: string; label: string } | null = null;
    try {
      holder = JSON.parse(await readFile(MOTHER_LOCK_PATH, "utf-8"));
    } catch {
      // malformed — fall through to reclaim
    }
    if (holder) {
      try {
        process.kill(holder.pid, 0);
        // Holder is alive. Wait.
        if (!warned) {
          const elapsed = Math.round((Date.now() - new Date(holder.startedAt).getTime()) / 1000);
          console.warn(`waiting on mother — '${holder.label}' is in flight (pid ${holder.pid}, ${elapsed}s ago)`);
          warned = true;
        }
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      } catch {
        // Holder is dead — reclaim.
        console.warn(`mother lock: removing stale lock (pid ${holder.pid} no longer alive)`);
      }
    }
    try { await unlink(MOTHER_LOCK_PATH); } catch {}
    break;
  }

  await writeFile(
    MOTHER_LOCK_PATH,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), label }),
  );
  weHoldMotherLock = true;

  try {
    return await fn();
  } finally {
    try { await unlink(MOTHER_LOCK_PATH); } catch {}
    weHoldMotherLock = false;
  }
}

// Run mother's birthing ritual under the claude-code harness instead of pi.
// Same contract as runPiWithOutcome: writes outcome to CELL_OUTCOME_FILE,
// returns {exit, outcome}. claude-code reads CLAUDE.md from cwd (MOTHER_ROOT)
// and resolves the /cell-create slash command from .claude/commands/cell-create.md.
//
// "No outcome" + nonzero exit signals a *pre-flight* failure (rate limit,
// auth failure, empty stream) — that's what the birth orchestrator falls
// over on. An outcome with success=false is a real ritual failure and is
// accepted as the verdict (no fallover).
async function runClaudeWithOutcome(
  slashCommand: string,
  args: string[],
  extraEnv?: Record<string, string>,
  opts?: { progressName?: string },
): Promise<{ exit: number; outcome: Outcome | null }> {
  return withMotherLock(`claude:${slashCommand} ${args[0] ?? ""}`.trim(), async () => {
    const outcomeFile = join(
      tmpdir(),
      `cell-outcome-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    if (existsSync(outcomeFile)) await unlink(outcomeFile);

    const message = `/${slashCommand} ${args.join(" ")}`.trim();

    const chipName = opts?.progressName;
    const useChip = !!chipName && process.stderr.isTTY;
    if (useChip) process.stderr.write(`\r\x1b[2K· birthing ${chipName} (claude-code)…`);

    // --dangerously-skip-permissions: this is mother running her own ritual
    // in her own dir; the interactive permission prompt would block the
    // one-shot. claude inherits stdin/stdout/stderr but in --print mode
    // it doesn't actually read stdin past the initial prompt.
    //
    // --effort=low: birth is mostly imperative bash execution, not reasoning.
    // Drops per-turn thinking time without hurting correctness in practice.
    // All other tools (Read, Grep, etc.) stay available as an escape hatch
    // for anomalies; the skill prose tells her to default to Bash.
    const proc = Bun.spawn(
      ["claude", "--print", "--dangerously-skip-permissions", "--effort", "low", message],
      {
        cwd: MOTHER_ROOT,
        env: {
          ...process.env,
          CELL_OUTCOME_FILE: outcomeFile,
          ...(extraEnv ?? {}),
        },
        stdin: "ignore",
        stdout: useChip ? "ignore" : "inherit",
        stderr: useChip ? "ignore" : "inherit",
      },
    );

    const exit = await proc.exited;
    if (useChip) process.stderr.write("\r\x1b[2K");

    let outcome: Outcome | null = null;
    if (existsSync(outcomeFile)) {
      try {
        outcome = JSON.parse(await readFile(outcomeFile, "utf-8"));
      } catch { /* malformed — leave null */ }
      try { await unlink(outcomeFile); } catch { /* best-effort cleanup */ }
    }
    return { exit, outcome };
  });
}

async function runPiWithOutcome(
  slashCommand: string,
  args: string[],
  extraEnv?: Record<string, string>,
  opts?: { progressName?: string },
): Promise<{ exit: number; outcome: Outcome | null }> {
  return withMotherLock(`${slashCommand} ${args[0] ?? ""}`.trim(), async () => {
    const outcomeFile = join(
      tmpdir(),
      `cell-outcome-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    if (existsSync(outcomeFile)) await unlink(outcomeFile);

    const message = `/${slashCommand} ${args.join(" ")}`.trim();

    // P2.5 streaming chip: when caller passes progressName + stderr is TTY,
    // tail ~/.cells/logs/birth-timings/<name>.log and render the latest step
    // marker on a single stderr line (\r overwrite). Skip if not TTY (script
    // mode keeps clean output) or if no progress file (other slash commands).
    const chipName = opts?.progressName;
    const useChip = !!chipName && process.stderr.isTTY;
    const progressPath = chipName
      ? join(homedir(), ".cells", "logs", "birth-timings", `${chipName}.log`)
      : null;
    const startSize = useChip && progressPath && existsSync(progressPath)
      ? statSync(progressPath).size
      : 0;

    const proc = spawnInRepo(["pi", "-p", message], { CELL_OUTCOME_FILE: outcomeFile, ...extraEnv });

    let chipStop = false;
    const chipTask = useChip && progressPath
      ? (async () => {
          let lastChip = "";
          let lastSize = startSize;
          while (!chipStop) {
            try {
              if (existsSync(progressPath)) {
                const size = statSync(progressPath).size;
                if (size > lastSize) {
                  const buf = await readFile(progressPath, "utf-8");
                  const lines = buf.split("\n").filter(Boolean);
                  const latest = lines[lines.length - 1];
                  if (latest) {
                    // format: <unix-ts>\t<step>\t<label>
                    const parts = latest.split("\t");
                    if (parts.length >= 3) {
                      const chip = `· birthing ${chipName} — step ${parts[1]}: ${parts[2]}…`;
                      if (chip !== lastChip) {
                        process.stderr.write(`\r\x1b[2K${chip}`);
                        lastChip = chip;
                      }
                    }
                  }
                  lastSize = size;
                }
              }
            } catch {
              // best-effort — chip is cosmetic
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          if (lastChip) process.stderr.write("\r\x1b[2K");
        })()
      : null;

    const exit = await proc.exited;
    chipStop = true;
    if (chipTask) await chipTask;

    let outcome: Outcome | null = null;
    if (existsSync(outcomeFile)) {
      try {
        outcome = JSON.parse(await readFile(outcomeFile, "utf-8"));
      } catch {
        // malformed — leave null
      }
      try {
        await unlink(outcomeFile);
      } catch {
        // best-effort cleanup
      }
    }
    return { exit, outcome };
  });
}

// ───── talkAndAwaitOutcome: mother-as-cell birth path ─────
//
// Phase 2 replacement for runPiWithOutcome. Instead of spawning pi on
// the Mac in MOTHER_ROOT, this:
//   1. generates a short birthId
//   2. `cells talk mother /<slashCommand> <birthId> <args...>` — fire and forget
//   3. long-polls ~/.cells/birth-outcomes/<birthId>.json (written by mother's
//      birth_outcome tool via proxy.cells.md/bridge/birth/outcome)
//
// Gated behind CELLS_USE_MOTHER_CELL=1 during the cutover. Phase 4
// deletes runPiWithOutcome + this flag once the new path is verified live.

const BIRTH_OUTCOMES_DIR_LOCAL = join(REGISTRY_DIR, "birth-outcomes");
const BIRTH_LOCK_PATH = join(REGISTRY_DIR, "birth.lock");
// 10 min — cells-mother adds latency (per-tool bridge round trips) on top
// of the legacy ~90-140s envelope, especially on early births when she's
// still mapping her tools.
const TALK_OUTCOME_TIMEOUT_MS = 600_000;

async function withBirthLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // One birth at a time — mirrors mother.lock's serialization invariant
  // (project_mother_concurrency) without the proto-cell ceremony.
  let attempts = 0;
  while (existsSync(BIRTH_LOCK_PATH) && attempts++ < 1800) {
    let holder: { pid?: number; label?: string; at?: number } = {};
    try { holder = JSON.parse(readFileSync(BIRTH_LOCK_PATH, "utf-8")); } catch {}
    // Stale lock detection: if the holder pid is gone or the lock is > 10 min old.
    const ageMs = Date.now() - (holder.at ?? 0);
    if (ageMs > 10 * 60 * 1000 || (holder.pid && !pidAlive(holder.pid))) {
      try { unlinkSync(BIRTH_LOCK_PATH); } catch {}
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  writeFileSync(BIRTH_LOCK_PATH, JSON.stringify({ pid: process.pid, label, at: Date.now() }));
  try {
    return await fn();
  } finally {
    try { unlinkSync(BIRTH_LOCK_PATH); } catch {}
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Birth-log surface that mother.cells.md reads — one JSON file per birth,
// written at start with {birthId, name, harness, model, started_at}, updated
// on outcome with {ended_at, elapsed_ms, success, message}. Files survive;
// the activity page sorts by started_at desc and shows the last N.
const BIRTH_LOG_DIR = join(REGISTRY_DIR, "birth-log");

async function talkAndAwaitOutcome(
  slashCommand: string,
  args: string[],
  opts?: { progressName?: string },
): Promise<{ exit: number; outcome: Outcome | null }> {
  return withBirthLock(`${slashCommand} ${args[0] ?? ""}`.trim(), async () => {
    const birthId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const outcomeFile = join(BIRTH_OUTCOMES_DIR_LOCAL, `${birthId}.json`);
    await mkdir(BIRTH_OUTCOMES_DIR_LOCAL, { recursive: true });
    if (existsSync(outcomeFile)) await unlink(outcomeFile);

    // Capture start-of-birth record for mother.cells.md. Best-effort: a
    // failure here doesn't break the birth.
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    let meta: { name?: string; harness?: string; model?: string } = {};
    if (slashCommand === "cell-create") {
      const [name, , blobJson] = args;
      meta.name = name;
      try {
        const blob = JSON.parse(blobJson ?? "{}");
        meta.harness = blob.harness;
        meta.model = blob.model;
      } catch {/* leave meta partial */}
    }
    const logFile = join(BIRTH_LOG_DIR, `${birthId}.json`);
    try {
      await mkdir(BIRTH_LOG_DIR, { recursive: true });
      await writeFile(logFile, JSON.stringify({
        birthId, started_at: startedAtIso, ...meta,
      }, null, 2));
    } catch {/* log surface is best-effort */}

    const message = `/${slashCommand} ${birthId} ${args.join(" ")}`.trim();
    // Fire `cells talk mother <message>` in the background. Mother runs
    // the ritual; her final tool call (report_outcome) writes outcomeFile
    // via /bridge/birth/outcome. We don't care about the talk exit code —
    // outcome presence is the source of truth.
    const proc = Bun.spawn(["bun", join(REPO_ROOT, "cli/cells.ts"), "talk", "mother", message], {
      stdio: ["ignore", "ignore", "ignore"],
    });

    const deadline = Date.now() + TALK_OUTCOME_TIMEOUT_MS;
    let chip = 0;
    while (Date.now() < deadline) {
      if (existsSync(outcomeFile)) break;
      // Lightweight progress chip — mirrors runPiWithOutcome's UX.
      if (opts?.progressName && process.stderr.isTTY) {
        const dots = ".".repeat((chip++ % 4));
        process.stderr.write(`\r${opts.progressName} ${dots}${" ".repeat(4 - dots.length)}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (opts?.progressName && process.stderr.isTTY) process.stderr.write("\r\x1b[2K");

    let outcome: Outcome | null = null;
    if (existsSync(outcomeFile)) {
      try {
        outcome = JSON.parse(await readFile(outcomeFile, "utf-8"));
      } catch {/* malformed */}
      try { await unlink(outcomeFile); } catch {}
    }

    // Update birth-log with end record (whether outcome came or timed out).
    try {
      const endedAt = Date.now();
      const record = {
        birthId,
        ...meta,
        started_at: startedAtIso,
        ended_at: new Date(endedAt).toISOString(),
        elapsed_ms: endedAt - startedAt,
        success: outcome?.success ?? false,
        message: outcome?.message ?? "no outcome (timeout or mother crash)",
      };
      await writeFile(logFile, JSON.stringify(record, null, 2));
    } catch {/* best-effort */}

    // Don't wait on proc — mother's talk session may still be flushing.
    // Outcome presence is what we care about.
    try { proc.kill(); } catch {}
    return { exit: outcome ? 0 : 1, outcome };
  });
}

// ───── direct (no Pi) ─────

async function launchMotherTui(extraArgs: string[] = []) {
  // Direct pi spawn — no tmux wrapper. Pete runs this on his Mac in his own
  // terminal; there's no SSH-disconnect / hibernation problem to solve here.
  // Pi persists sessions to ~/.pi/agent/sessions/ on its own, so closing the
  // terminal and re-running picks up where you left off.
  const proc = Bun.spawn(["pi", ...extraArgs], {
    cwd: MOTHER_ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}

async function cmdPi() {
  await launchMotherTui();
}

function humanDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function readCellModel(name: string): Promise<string | null> {
  // Registry is the source of truth — that's where the modelChain lives,
  // derived from the cell's actual settings.json at bake time.
  let reg: Awaited<ReturnType<typeof loadRegistry>> | null = null;
  try { reg = await loadRegistry(); } catch { /* fall through */ }
  const cell = reg?.cells.find((c: any) => c.name === name);

  // For specials, ONLY the registry — never the vault. Legacy proto-mother
  // had a stale Obsidian IDENTITY.md frontmatter that shadowed reality and
  // made `cells list` lie about what mother was actually running.
  if (cell?.special) {
    const chain: string[] | undefined = cell.modelChain;
    if (chain && chain.length > 0) {
      return parseChainEntry(chain[0]!).display;
    }
    return null;
  }

  // Non-specials: prefer the vault IDENTITY.md `model:` line if present
  // (legacy mother-born cells), else fall back to the registry chain.
  const p = join(VAULT_DIR, name, "IDENTITY.md");
  if (existsSync(p)) {
    try {
      const txt = await readFile(p, "utf-8");
      const m = txt.match(/^model:\s*(\S+)/m);
      if (m) return m[1]!;
    } catch { /* fall through */ }
  }
  const chain: string[] | undefined = cell?.modelChain;
  if (chain && chain.length > 0) {
    return parseChainEntry(chain[0]!).display;
  }
  return null;
}

// Read post-birth deployment status. Prefers the structured signal in
// ~/.cells/postwork/<name>.json (scripts/birth-postwork.sh writes a
// status per step + completed_at when the chain finishes) so we can
// distinguish "ok", "fail:<which-steps>", and "running" with no
// log-grep heuristics. Falls back to the legacy plain-text log for
// cells born before the JSON format landed.
//
//   "ok"           — every step finished cleanly
//   "fail:<steps>" — the chain finished but one or more steps failed
//   "running"      — the chain is still in flight
//   "—"            — no postwork artifact (legacy/special/pre-split)
async function postBirthStatus(name: string): Promise<string> {
  const summary = await loadPostworkSummary(name);
  if (summary) {
    if (summary.status === "ok") return "ok";
    if (summary.status === "failed") return `fail:${summary.failed_steps.join(",")}`;
    return "running";
  }
  // Legacy: a plain log written by the pre-PR-5 SKILL.md nohup. Once
  // every live cell has been re-birthed under birth-postwork.sh this
  // branch can go.
  const logPath = join(homedir(), ".cells", "logs", "birth-postwork", `${name}.log`);
  if (!existsSync(logPath)) return "—";
  try {
    const txt = readFileSync(logPath, "utf-8");
    return txt.includes("post-birth done") ? "ok" : "running";
  } catch {
    return "—";
  }
}

async function cmdList() {
  const reg = await loadRegistry();
  if (reg.cells.length === 0) {
    console.log("no cells");
    return;
  }
  const sorted = [...reg.cells].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows = await Promise.all(
    sorted.map(async (c) => ({
      name: c.name,
      model: (await readCellModel(c.name)) ?? "?",
      born: humanDate(c.created_at),
      deploy: await postBirthStatus(c.name),
    })),
  );

  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
  const modelWidth = Math.max(5, ...rows.map((r) => r.model.length));
  const deployWidth = Math.max(6, ...rows.map((r) => r.deploy.length));
  const header = `${"name".padEnd(nameWidth)}  ${"model".padEnd(modelWidth)}  ${"deploy".padEnd(deployWidth)}  birthday`;

  // Non-TTY (piped/scripted): plain columns with header, no picker.
  if (!process.stdout.isTTY) {
    console.log(header);
    for (const r of rows) {
      console.log(`${r.name.padEnd(nameWidth)}  ${r.model.padEnd(modelWidth)}  ${r.deploy.padEnd(deployWidth)}  ${r.born}`);
    }
    return;
  }

  // TTY: interactive picker → launches `cells talk <name>` on selection.
  // Indent header by 2 to line up with the picker's "❯ " pointer column.
  const options: SelectOption[] = rows.map((r) => ({
    value: r.name,
    label: `${r.name.padEnd(nameWidth)}  ${r.model.padEnd(modelWidth)}  ${r.deploy.padEnd(deployWidth)}  ${r.born}`,
  }));
  // Embed header as a dim second line of the prompt so it sits between
  // "pick a cell..." and the options. \x1b[22m turns off bold from the
  // surrounding bold span; \x1b[2m dims the header.
  const promptWithHeader = `pick a cell to talk to\x1b[22m\n  \x1b[2m${header}`;
  const picked = await selectOne(promptWithHeader, options);
  if (typeof picked !== "string") return;
  await cmdTalk(picked, []);
}

async function cmdTalk(name: string, args: string[]) {
  if (name === "mother") {
    // Two routes during cutover:
    //  - cells-mother registered → talk to her like any cell (host-bridge → SSH → pi).
    //  - otherwise → legacy on-Mac pi TUI (mother accepts pi flags through).
    // The registry check makes this self-healing: once cells-mother is
    // baked, the special-case dissolves automatically.
    const reg = await loadRegistry();
    const motherIsCell = reg.cells.some(c => c.name === "mother" && c.special);
    if (!motherIsCell) {
      await launchMotherTui(args);
      return;
    }
  }
  await requireCell(name);

  // V1.5/V1.6: wake the cell's well if it's hibernated or stopped before
  // we dial the bridge. host-bridge spawns ssh+pi inside the cell, so the
  // VM must be running and accepting SSH first. No-op if already serving.
  try {
    const wellName = await wellNameForCell(name);
    if (wellName) await ensureWellRunningForTalk(wellName);
  } catch (e) {
    console.error(`! wake failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (args.length === 0) {
    // No args → interactive bridge chat. Same session as Slack; each
    // prompt mirrors to the bound channel so Slack stays the journal.
    await streamCellBridge(name, { interactive: true });
    return;
  }
  // Flag parsing for the new fork-based one-shot path. Recognized flags:
  //   --await       (default for one-shot now — Pete wants the answer back)
  //   --main        (write to receiver's main thread; default is fork)
  //   --timeout=Ns  (defaults to 120s)
  // Anything we don't recognize falls through to streamCellBridge so older
  // habits (cells talk <name> --foo "msg") still surface a useful error.
  let useMain = false;
  let session = "";
  // 180s — must clear the peer's forkAndAsk ceiling (pi: 150s) plus
  // inbox→DO→WS→reply routing. See dna/.../bin/cells parseTalkArgs.
  let timeoutS = 180;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--await") { /* await is the default for one-shot; flag harmless */ continue; }
    if (a === "--main") { useMain = true; continue; }
    if (a.startsWith("--session=")) { session = a.slice("--session=".length); continue; }
    if (a === "--session") { session = args[++i] ?? ""; continue; }
    if (a.startsWith("--timeout=")) {
      const v = a.slice("--timeout=".length);
      const m = v.match(/^(\d+)\s*([smh]?)$/);
      timeoutS = m ? Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1) : 120;
      continue;
    }
    if (a === "--timeout") {
      const v = args[++i] ?? "120s";
      const m = v.match(/^(\d+)\s*([smh]?)$/);
      timeoutS = m ? Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1) : 120;
      continue;
    }
    if (a.startsWith("-")) {
      console.error(
        `flag '${a}' isn't supported on cells talk. Use 'cells talk ${name}' for an interactive chat, 'cells talk ${name} "<msg>"' for one-shot, --main to write to main, --timeout=Ns to override the wait, or 'cells tui ${name}' to drop into the well shell.`,
      );
      process.exit(1);
    }
    positional.push(a);
  }
  const message = positional.join(" ");
  // --session main/fork are aliases for the existing target routing; any other
  // name is a durable named session on the peer's interactive talk pool.
  if (session === "main") { useMain = true; session = ""; }
  else if (session === "fork") { session = ""; }
  // One-shot uses the new fork-based agent-comms path: SSH into the cell and
  // run the on-cell CLI, which POSTs the envelope and long-polls for the
  // reply. Default target is "fork" (receiver answers from main context but
  // main stays untouched); --main escalates to writing the exchange into the
  // receiver's main thread (Slack/email equivalent); --session=<name> drives a
  // named durable session in the peer's pool.
  await macTalkOneShotFork(name, message, { timeoutS, useMain, session });
}

async function macTalkOneShotFork(
  cellName: string,
  message: string,
  opts: { timeoutS: number; useMain: boolean; session?: string },
): Promise<void> {
  const result = await runTalkOnCell(cellName, message, opts);
  if (!result.ok) {
    console.error(`! cells talk failed (exit ${result.exitCode}): ${result.error.slice(0, 500)}`);
    if (result.text) console.error(result.text);
    process.exit(result.exitCode);
  }
  if (result.text) console.log(result.text);
}

// Run a one-shot `cells talk` inside the peer's well and return the
// response. Wrapped because cmdTalk wants print-and-exit semantics, while
// cmdVerify wants parallel collection. Both share this transport.
async function runTalkOnCell(
  cellName: string,
  message: string,
  opts: { timeoutS: number; useMain: boolean; session?: string },
): Promise<{ ok: true; text: string } | { ok: false; exitCode: number; error: string; text: string }> {
  const wellName = await wellNameForCell(cellName);
  if (!wellName) {
    return { ok: false, exitCode: 1, error: `unknown cell or well-mapping for: ${cellName}`, text: "" };
  }
  const escaped = message.replace(/'/g, "'\\''");
  const flag = opts.useMain ? "--main" : "";
  // session is user input — single-quote-escape like the message before it
  // rides the SSH'd shell command.
  const sessFlag = opts.session
    ? `--session='${opts.session.replace(/'/g, "'\\''")}'`
    : "";
  const remote = `/root/bin/cells talk '${cellName}' --await --timeout=${opts.timeoutS}s ${flag} ${sessFlag} '${escaped}'`;
  const proc = Bun.spawn(
    [
      "well", "exec", "-s", wellName, "--",
      "sudo", "bash", "-lc", `export HOME=/root; ${remote}`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdoutRaw, stderrRaw] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const stdoutTrimmed = stdoutRaw.trim();
  if (exitCode !== 0) {
    return { ok: false, exitCode, error: stderrRaw.trim(), text: stdoutTrimmed };
  }
  return { ok: true, text: stdoutTrimmed };
}

// ── jobs lane — `cells run` / `cells jobs` (docs/proposals/jobs.html) ──
//
// Talk is conversation; run is work. A job submit POSTs a kind:"job" event
// to the cell's DO and prints the job id immediately — no wake, no SSH, no
// held socket. The on-cell runner executes it in a fresh detached session
// under a frame-progress watchdog (kill, retry once, durably mark failed).

async function cmdRun(cellName: string, rest: string[]): Promise<void> {
  // Jobs on a mother were once refused outright. They're now allowed for a
  // PROJECT mother under the default Mac-side-ritual mode — that's what lets
  // zero-mother run a durable birth as her own job. The global mother and the
  // legacy in-cell-ritual mode stay refused (see motherJobRefusalReason).
  const motherRefusal = motherJobRefusalReason(cellName, process.env.CELLS_USE_MOTHER_CELL === "1");
  if (motherRefusal) {
    console.error(`! jobs on '${cellName}' are refused — ${motherRefusal}`);
    process.exit(1);
  }
  await requireCell(cellName);
  let timeoutS = 3600;
  let sessionTarget = "";
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--timeout" || a.startsWith("--timeout=")) {
      const raw = a.includes("=") ? a.slice("--timeout=".length) : (rest[++i] ?? "");
      const m = raw.match(/^(\d+)([smh]?)$/);
      if (!m) {
        console.error(`! bad --timeout value: '${raw}' (use 90s / 30m / 2h)`);
        process.exit(1);
      }
      const n = Number(m[1]);
      timeoutS = m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : n;
    } else if (a === "--session" || a.startsWith("--session=")) {
      // Which session the job binds to: fresh (default, no context), fork
      // (inherit the cell's main context read-only, write to a throwaway fork —
      // main untouched), or main (continue main). Honored only when the cell
      // runs the interactive job runner; otherwise the job is fresh.
      const v = a.includes("=") ? a.slice("--session=".length) : (rest[++i] ?? "");
      if (v !== "fresh" && v !== "fork" && v !== "main") {
        // Named durable sessions (buyer, staff, …) are a TALK concept — they're
        // single-owner, held warm by the cell's interactive pool. A detached job
        // co-writing one would corrupt the live conversation (the same reason
        // main is rejected). Use `cells talk <cell> --session=<name>` for those.
        console.error(`! bad --session value: '${v}' for run (use fresh | fork). Named durable sessions live on 'cells talk --session=<name>', not detached jobs.`);
        process.exit(1);
      }
      if (v === "main") {
        console.error(`! --session main is not yet supported — main is single-owner (the persistent talk session holds it open), so a detached job can't write to it without corrupting the live conversation. Use 'fork' (inherits main's context, leaves main untouched) or 'fresh'.`);
        process.exit(1);
      }
      // fresh is the default + the old behavior — leave sessionTarget unset so
      // the worker/supervisor capability gates (which only matter for fork)
      // don't reject an explicit `--session fresh` on an un-refreshed cell.
      sessionTarget = v === "fresh" ? "" : v;
    } else if (a.startsWith("--")) {
      console.error(`! unknown flag for run: ${a}`);
      process.exit(1);
    } else {
      positional.push(a);
    }
  }
  const task = positional.join(" ").trim();
  if (!task) {
    console.error(`usage: cells run <name> "<task>" [--timeout 30m] [--session fresh|fork]`);
    process.exit(1);
  }
  const secret = await readSecret("CELLS_PROXY_SECRET");
  if (!secret) {
    console.error(`! no CELLS_PROXY_SECRET in ${SECRETS_PATH}`);
    process.exit(1);
  }
  const base = `https://${cellName}.cells.md`;

  // Capability probe — an old worker misroutes kind:"job" into the
  // conversation path (the DO's default kind is a slack prompt), which
  // would inject the task into the cell's chat. /debug grew a `jobs` key
  // with the lane; refuse to submit without it.
  let debug: any = null;
  try {
    const res = await fetch(`${base}/debug`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) debug = await res.json();
  } catch {}
  // Capable = exposes the jobs lane AND, when a session target is requested,
  // persists/forwards session_target. An older worker exposes `jobs` but drops
  // session_target, so `--session fork` would silently run a fresh job — probe
  // for the capability and self-heal rather than do the wrong thing quietly.
  const capable = (d: any) =>
    d && Array.isArray(d.jobs) && (!sessionTarget || d.job_session_targets === true);
  const lacks = () => (!debug || !Array.isArray(debug.jobs))
    ? "predates the jobs lane"
    : `predates --session targets (needed for --session ${sessionTarget})`;
  if (!capable(debug)) {
    // Old cell, or a fresh birth whose worker deploy hasn't propagated. Self-heal:
    // redeploy the current worker once and re-probe rather than dead-ending the
    // operator (the friction homezero hit firing Phase B on a just-born advisor).
    console.error(`! ${cellName}'s worker ${lacks()} — redeploying it…`);
    const wn = await wellNameForCell(cellName);
    const redeploy = Bun.spawn(
      ["bash", join(REPO_ROOT, "scripts/deploy-cell-worker.sh"), cellName, wn],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await redeploy.exited) !== 0) {
      console.error(`! worker redeploy failed for ${cellName} — fix manually: bash scripts/deploy-cell-worker.sh ${cellName}`);
      process.exit(1);
    }
    // A fresh `wrangler deploy` takes a few seconds to go live at the edge, so
    // re-probing once immediately would race the propagation and false-fail the
    // exact just-born case this self-heal targets. Poll with backoff (~15s).
    debug = null;
    for (let attempt = 0; attempt < 6 && !capable(debug); attempt++) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const res2 = await fetch(`${base}/debug`, {
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (res2.ok) debug = await res2.json();
      } catch {}
    }
    if (!capable(debug)) {
      console.error(`! ${cellName}'s worker still ${lacks()} ~15s after redeploy — investigate the worker deploy.`);
      process.exit(1);
    }
    console.error(`  ✓ worker redeployed; ${sessionTarget ? "--session support" : "jobs lane"} present`);
  }

  // The Worker now persists session_target, but the cell-side SUPERVISOR is
  // what actually honors it — and they deploy separately (Worker via
  // deploy-cell-worker.sh, supervisor via `cells refresh`). A Worker redeploy
  // can't update an old supervisor, so refuse rather than let it silently run a
  // fresh job with the wrong context.
  if (sessionTarget && debug.supervisor_session_targets !== true) {
    console.error(`! ${cellName} won't honor --session ${sessionTarget} — it would otherwise run a fresh job with the wrong context.`);
    console.error(`  --session fork needs a claude-code cell running the interactive jobs runner: a current supervisor (\`cells refresh ${cellName}\`) with CELLS_JOBS_INTERACTIVE=1.`);
    console.error(`  Enable those, and if you just changed either, wake the cell once (e.g. \`cells talk ${cellName} hi\`) so it re-advertises — then retry.`);
    process.exit(1);
  }

  const jobId = ulid();
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${base}/inbox/append`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          event: {
            kind: "job",
            job_id: jobId,
            text: task,
            timeout_seconds: timeoutS,
            ...(sessionTarget ? { session_target: sessionTarget } : {}),
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        console.log(`job ${jobId}  queued at ${cellName} (timeout ${timeoutS}s)`);
        console.log(`      check: cells jobs ${cellName}`);
        return;
      }
      lastErr = `${res.status}: ${(await res.text()).slice(0, 200)}`;
      // Policy refusals are deterministic — retrying re-asks the same question.
      if ([400, 413, 429].includes(res.status)) break;
    } catch (e) {
      lastErr = String(e).slice(0, 200);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  console.error(`! job submit failed: ${lastErr}`);
  process.exit(1);
}

async function isWellServing(wellName: string): Promise<boolean> {
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  try {
    const token = await wellsToken();
    const info = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    }).then((r) => r.json());
    return info?.status === "running";
  } catch {
    return false;
  }
}

async function cmdJobs(cellName: string, rest: string[]): Promise<void> {
  await requireCell(cellName);
  const jobId = rest.find((a) => !a.startsWith("--")) ?? "";
  // The id is interpolated into a root `bash -lc` on the cell (the awake
  // path curls http://127.0.0.1:8080/jobs/<id>). Constrain it to the job-id
  // charset BEFORE it can reach a shell — a metacharacter would otherwise
  // execute as root inside the VM (codex P2).
  if (jobId && !/^[0-9A-Za-z][0-9A-Za-z_-]{7,39}$/.test(jobId)) {
    console.error(`! invalid job id: ${jobId}`);
    process.exit(1);
  }
  const wellName = await wellNameForCell(cellName);

  // Awake cell: full detail straight from the job files. If the local
  // /jobs endpoint is missing (running cell, supervisor not yet refreshed
  // to a jobs-capable build — the documented version-skew window), don't
  // error out: fall through to the DO status view, which the new Worker
  // serves regardless of supervisor version.
  if (wellName && (await isWellServing(wellName))) {
    const path = jobId ? `/jobs/${jobId}` : "/jobs";
    // The /jobs route is bearer-gated (it serves durable result text). The
    // secret is in the guest env via cells-env.sh; -lc sources it. jobId is
    // already validated to the job-id charset above, so the interpolation
    // is shell-safe.
    const r = await wellExecCapture(
      wellName,
      `curl -sf --max-time 5 -H "Authorization: Bearer $CELLS_PROXY_SECRET" http://127.0.0.1:8080${path}`,
      { user: "root" },
    );
    let j: any = null;
    if (r.ok) { try { j = JSON.parse(r.stdout); } catch { j = null; } }
    if (j) {
      if (jobId) {
        const { result, ...meta } = j;
        console.log(JSON.stringify(meta, null, 2));
        if (result) console.log(`\n── result ──\n${result}`);
        return;
      }
      const jobs: any[] = Array.isArray(j.jobs) ? j.jobs : [];
      if (!jobs.length) { console.log(`no jobs on ${cellName}`); return; }
      for (const rec of jobs) {
        const flags = [rec.reason, rec.attempts > 1 ? `attempts=${rec.attempts}` : ""].filter(Boolean).join(" ");
        console.log(`${rec.id}  ${String(rec.status).padEnd(7)}  ${rec.created_at}${flags ? `  [${flags}]` : ""}`);
      }
      console.log(`\ndetail: cells jobs ${cellName} <job-id>`);
      return;
    }
    // Local read failed — note it and fall through to the DO view.
    console.error(`(note: ${cellName} is awake but its /jobs endpoint didn't answer — supervisor may predate the jobs lane; showing the DO view)`);
  }

  const secret = await readSecret("CELLS_PROXY_SECRET");
  if (!secret) {
    console.error(`! no CELLS_PROXY_SECRET in ${SECRETS_PATH}`);
    process.exit(1);
  }
  let j: any = null;
  try {
    const res = await fetch(`https://${cellName}.cells.md/jobs`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) j = await res.json();
    else if (res.status === 404) {
      console.error(`! ${cellName}'s worker predates the jobs lane — redeploy it: bash scripts/deploy-cell-worker.sh ${cellName}`);
      process.exit(1);
    }
  } catch {}
  if (!j) {
    console.error(`! could not reach ${cellName}.cells.md/jobs`);
    process.exit(1);
  }
  const jobs: any[] = Array.isArray(j.jobs) ? j.jobs : [];
  const filtered = jobId ? jobs.filter((r) => r.id === jobId) : jobs;
  if (!filtered.length) { console.log(`no jobs at ${cellName} (DO view — cell is asleep)`); return; }
  for (const rec of filtered) {
    console.log(`${rec.id}  ${String(rec.status).padEnd(7)}  ${rec.created_at}${rec.summary ? `  ${String(rec.summary).split("\n")[0].slice(0, 100)}` : ""}`);
  }
  console.log(`\n(cell asleep — DO status view; wake it for full detail + results)`);
}

// `cells verify` — fan out a decision to N peers in parallel, return their
// takes side-by-side. The killer-app pattern over `cells talk`: every
// Pete-affecting decision a cell makes can be cross-checked against a
// sibling on a different model before committing.
//
// Each peer forks its main read-only (existing cells talk default), so the
// verifier query never pollutes anyone's main thread. v1 doesn't try to
// route to model-specific siblings automatically — caller names the peers
// explicitly via --to. Future: --models=opus,gpt-5.5 resolves to peers
// once the capability/model registry lands.
async function cmdVerify(args: string[]) {
  let decision = "";
  let context = "";
  let timeoutS = 90;
  const peers: string[] = [];
  // Deduped at end so --to=foo,foo,bar doesn't run two forks of foo.
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a.startsWith("--to=")) {
      peers.push(...a.slice("--to=".length).split(",").map(s => s.trim()).filter(Boolean));
      continue;
    }
    if (a === "--to") {
      const v = args[++i] ?? "";
      peers.push(...v.split(",").map(s => s.trim()).filter(Boolean));
      continue;
    }
    if (a.startsWith("--context=")) {
      context = a.slice("--context=".length);
      continue;
    }
    if (a === "--context") {
      context = args[++i] ?? "";
      continue;
    }
    if (a.startsWith("--context-file=")) {
      const p = a.slice("--context-file=".length);
      try { context = await readFile(p, "utf-8"); }
      catch (e) { console.error(`--context-file: cannot read ${p}: ${(e as Error).message}`); process.exit(1); }
      continue;
    }
    if (a.startsWith("--timeout=")) {
      const v = a.slice("--timeout=".length);
      const m = v.match(/^(\d+)\s*([smh]?)$/);
      timeoutS = m ? Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1) : 90;
      continue;
    }
    if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    }
    decision = decision ? decision + " " + a : a;
  }
  const uniquePeers = Array.from(new Set(peers));
  if (!decision || uniquePeers.length === 0) {
    console.error("usage: cells verify \"<decision>\" --to=<cellA>[,<cellB>...] [--context=<text>] [--context-file=<path>] [--timeout=<Ns>]");
    process.exit(1);
  }
  const prompt = verifierPrompt(decision, context);
  // Parallel fan-out. Each peer answers from its own main context in a fork.
  const t0 = Date.now();
  const results = await Promise.all(
    uniquePeers.map(async (peer) => {
      const r = await runTalkOnCell(peer, prompt, { timeoutS, useMain: false });
      return { peer, result: r };
    })
  );
  const dt = Date.now() - t0;

  // Render pretty + summary. Counts AGREE / DISAGREE / UNCLEAR by simple
  // keyword sniff at the head of each response — good enough for v1.
  let agree = 0;
  let disagree = 0;
  let unclear = 0;
  const takes: Array<{ peer: string; stance: string; ok: boolean; text: string; exit_code?: number; error?: string }> = [];
  console.log(`# cells verify · ${uniquePeers.length} peers · ${Math.round(dt / 100) / 10}s`);
  console.log(`# decision: ${decision}`);
  if (context) console.log(`# context: ${context.length > 80 ? context.slice(0, 77) + "..." : context}`);
  console.log("");
  for (const { peer, result } of results) {
    if (!result.ok) {
      console.log(`## ${peer} — ERROR`);
      console.log(`  exit ${result.exitCode}: ${result.error.slice(0, 240)}`);
      console.log("");
      unclear++;
      takes.push({ peer, stance: "error", ok: false, text: result.text, exit_code: result.exitCode, error: result.error });
      continue;
    }
    const stance = classifyStance(result.text);
    if (stance === "agree") agree++;
    else if (stance === "disagree") disagree++;
    else unclear++;
    const label = stance === "agree" ? "AGREE" : stance === "disagree" ? "DISAGREE" : "UNCLEAR";
    console.log(`## ${peer} — ${label}`);
    for (const line of result.text.split("\n")) console.log(`  ${line}`);
    console.log("");
    takes.push({ peer, stance, ok: true, text: result.text });
  }
  // Consensus header — useful for scripts that grep the last line.
  const verdict =
    agree > 0 && disagree === 0 ? "CONSENSUS-AGREE" :
    disagree > 0 && agree === 0 ? "CONSENSUS-DISAGREE" :
    agree > 0 && disagree > 0 ? "SPLIT" :
    "UNCLEAR";
  console.log(`# verdict: ${verdict} (agree=${agree} disagree=${disagree} unclear=${unclear})`);
  // Append to the daily audit log. Best-effort — never fail the verify on
  // a log write error.
  try { await appendVerifyLog({ decision, context, peers: uniquePeers, takes, verdict, dt_ms: dt }); }
  catch (e) { console.error(`# (log append failed: ${(e as Error).message})`); }
}

// One line per `cells verify` invocation. Daily file. Mostly for "what did
// the cells decide last week?" — no schema dependents yet, evolve freely.
async function appendVerifyLog(rec: {
  decision: string;
  context: string;
  peers: string[];
  takes: Array<{ peer: string; stance: string; ok: boolean; text: string; exit_code?: number; error?: string }>;
  verdict: string;
  dt_ms: number;
}): Promise<void> {
  const dir = join(homedir(), ".cells", "verify-log");
  await mkdir(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = join(dir, `${date}.jsonl`);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n";
  await appendFile(file, line);
}

function verifierPrompt(decision: string, context: string = ""): string {
  const lines = [
    "[PEER VERIFIER QUERY]",
    "Another cell is considering a decision and wants your take before acting.",
    "You're being consulted in a forked read-only branch — don't update your plans",
    "or memory based on this; just give your honest read using what you already know.",
    "",
  ];
  if (context.trim()) {
    lines.push("CALLER CONTEXT:");
    lines.push(context.trim());
    lines.push("");
  }
  lines.push("DECISION: " + decision);
  lines.push("");
  lines.push("Respond in this exact format (2-3 short sentences total):");
  lines.push("  AGREE or DISAGREE: <one word>");
  lines.push("  WHY: <1 sentence>");
  lines.push("  CONCERN: <flag any risk, or \"none\">");
  return lines.join("\n");
}

function classifyStance(text: string): "agree" | "disagree" | "unclear" {
  const head = text.slice(0, 200).toUpperCase();
  // Look at the first line / first 200 chars for the canonical AGREE/DISAGREE marker.
  if (/\bDISAGREE\b/.test(head)) return "disagree";
  if (/\bAGREE\b/.test(head)) return "agree";
  return "unclear";
}

async function cmdTui(name: string, extra: string[] = []) {
  const cell = await requireCell(name);
  const wellName = await wellNameForCell(name);
  const harness = cell.harness ?? "pi";
  // Open the cell's harness TUI inside the well, wrapped in tmux so:
  //   - the per-cell status bar (~/.tmux.conf) is visible
  //   - reattach across well hibernate is automatic — same agent process,
  //     same in-flight conversation, no resume dance
  //
  // Behavior on an existing tmux session:
  //   - no extra args → attach-or-create (`tmux new -A -s tui`). You land
  //     back in whatever the agent is already running there.
  //   - any extra args  → kill the old `tui` session first, then create
  //     fresh with the new flags. Otherwise tmux silently ignores the
  //     command on attach and the flags would be a no-op.
  //
  // For a bare shell (no agent), use `cells shell <name>`.
  const quote = (a: string) => `'${a.replace(/'/g, "'\\''")}'`;
  const reset = extra.length > 0 ? "tmux kill-session -t tui 2>/dev/null; " : "";
  // The agent invocation is the only harness-specific piece — everything
  // around it (tmux, TERM, well exec --tty, sudo to root, HOME=/root) is identical.
  let mkdir = "";
  let agentInvocation: string;
  if (harness === "claude-code") {
    // claude-code's own TUI. --resume pins to the birth-time main session id
    // so TUI lands in the Slack/email main conversation by default. The user
    // can run `claude --resume` (no id) from inside to pick another session.
    // If extra args were passed, the user's calling the shots — honor them
    // verbatim. Otherwise default to --resume <main>; if the cache file is
    // missing (pre-fix cells until upgraded), fall back to bare claude.
    if (extra.length) {
      agentInvocation = `claude ${extra.map(quote).join(" ")}`;
    } else {
      agentInvocation = `if [ -s /root/.cell/claude-main-session ]; then claude --resume "$(cat /root/.cell/claude-main-session)"; else claude; fi`;
    }
  } else if (harness === "codex") {
    // codex's TUI lands in the Slack main thread via `codex resume <id>` —
    // codex's session_id and thread_id are the same UUID, stored at birth in
    // /root/.cell/codex-main-thread. User can run `codex resume` (no id)
    // from inside to pick another session, or `codex resume --last` for the
    // most recent. Falls back to bare codex when the cache is missing
    // (pre-fix cells).
    if (extra.length) {
      agentInvocation = `codex ${extra.map(quote).join(" ")}`;
    } else {
      agentInvocation = `if [ -s /root/.cell/codex-main-thread ]; then codex resume "$(cat /root/.cell/codex-main-thread)"; else codex; fi`;
    }
  } else if (harness === "hermes") {
    // hermes's own Ink TUI. Bare `hermes` (no subcommand) launches it; extra
    // args pass through. hermes manages session resume itself — the in-TUI
    // resume picker, or display.tui_auto_resume_recent in its config.
    agentInvocation = extra.length
      ? `hermes ${extra.map(quote).join(" ")}`
      : `hermes`;
  } else {
    // pi's TUI. Point at the canonical session dir (root-<name>/) — pi
    // auto-loads main.jsonl by default, so TUI lands in the same thread
    // Slack/email drive. The user runs `pi -r` inside to pick a side
    // conversation. extra args pass through (e.g. `-c`, `-r`, `--session=`).
    const sessionDir = `~/.pi/agent/sessions/root-${name}`;
    mkdir = `mkdir -p ${sessionDir} && `;
    agentInvocation = `pi ${["--session-dir", sessionDir, ...extra].map(quote).join(" ")}`;
  }
  // pi's TUI is tuned for the DNA .tmux.conf default (`mouse off` — pi's
  // drag-select and wheel→copy-mode get in the way). claude-code and codex
  // are full-screen TUIs that handle their own mouse + scroll; without
  // `mouse on` the terminal translates the wheel into arrow keys and the
  // harness scrolls its input history instead of the conversation. Flip it
  // on for those — `\;`-chained onto new-session so it also applies on attach.
  const tmuxOpts = harness === "pi" ? "" : ` \\; set -g mouse on`;
  // Force TERM to a value the cell's terminfo definitely has. Pete's
  // local terminal exports things like xterm-ghostty / xterm-kitty that
  // well VMs don't ship terminfo for, which makes tmux refuse to
  // start. tmux's own `default-terminal "tmux-256color"` takes over
  // once it's running, so the override only affects the outer shell.
  const remote =
    `export TERM=xterm-256color; ` +
    `${mkdir}cd /root && ${reset}` +
    `exec tmux new-session -A -s tui -c /root "${agentInvocation}"${tmuxOpts}`;
  // Sudo to root so the agent's session/memory/tmux conf can write
  // anywhere under /root. HOME=/root is set inline so HOME-relative paths
  // resolve there regardless of the sudo'd user's home. well is in
  // NOPASSWD sudoers so the wrap is silent.
  const proc = Bun.spawn(
    [
      "well", "exec", "-s", wellName, "--tty", "--",
      "sudo", "bash", "-lc", `export HOME=/root; ${remote}`,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  await proc.exited;
}

async function cmdShell(name: string) {
  if (name === "mother") {
    // Two routes during cutover (same shape as cmdTalk):
    //  - cells-mother registered → fall through and shell into the well.
    //  - otherwise → legacy on-Mac mother (print anatomy and return).
    // Registry check is self-healing: once mother is fully on-cell, the
    // legacy branch never fires.
    const reg = await loadRegistry();
    const motherIsCell = reg.cells.some(c => c.name === "mother" && c.special);
    if (motherIsCell) {
      // intentional fall-through to the normal cell-shell path below
    } else {
    console.log(`mother lives on this Mac. her anatomy:`);
    console.log(`  entrypoint: ${MOTHER_ROOT}/AGENTS.md         (cross-harness contract)`);
    console.log(`  soul:       ${MOTHER_ROOT}/SOUL.md           (persona — read by use-max into systemPrompt)`);
    console.log(`  identity:   ${MOTHER_ROOT}/IDENTITY.md       (metadata: name, model, provider)`);
    console.log(`  tools:      ${MOTHER_ROOT}/TOOLS.md          (capability inventory)`);
    console.log(`  contacts:   ${MOTHER_ROOT}/CONTACTS.md       (who she interacts with)`);
    console.log(`  memory ptr: ${MOTHER_ROOT}/MEMORY.md         (root-level pointer to state/memory/)`);
    console.log(`  heartbeat:  ${MOTHER_ROOT}/HEARTBEAT.md      (declared schedule)`);
    console.log(`  config:     ${MOTHER_ROOT}/.pi/settings.json`);
    console.log(`  extensions: ${MOTHER_ROOT}/.pi/extensions/`);
    console.log(`  skills:     ${MOTHER_ROOT}/.pi/skills/`);
    console.log(`  memory:     ${MOTHER_ROOT}/state/memory/`);
    console.log(`  pi data:    ${process.env.HOME}/.pi/agent/  (sessions, auth.json — shared with the proxy)`);
    console.log(`  runs from:  ${MOTHER_ROOT}  (mother's agent root; pi auto-discovers .pi/ here)`);
    return;
    }
  }
  await requireCell(name);
  // Pool-hatched cells live in a well whose name is `egg-<id>`, not the
  // cell name. Every other command uses wellNameForCell() to map; shell
  // forgot to, so `cells shell <cell>` on hatched cells errored with
  // "well not found in registry". Resolve here too.
  const wellName = await wellNameForCell(name);
  // Best-effort self-heal: push the latest /etc/profile.d/cells-env.sh
  // before opening the shell so existing cells pick up PS1/banner
  // niceness updates without a re-bake. Fast enough not to be felt;
  // failures don't block the shell.
  await refreshShellNiceness(wellName);
  // Spawn tmux directly under well exec --tty as root (sudo from the
  // ubuntu ssh user). Bypasses the login-shell auto-attach shim (which
  // would dump us into pi); inside tmux, the shim's `[ -z "$TMUX" ]`
  // guard is false, so it no-ops on subsequent shell invocations.
  // -A on new-session: attach if "shell" exists, create if not.
  // bash -l inside tmux sources /etc/profile → /etc/profile.d/cells-env.sh
  // (PATH, secrets re-export). Ctrl+D exits bash, ends the tmux session,
  // drops us back to the Mac.
  // sudo -H sets HOME=/root (root's actual home — the agent's home).
  // Wrap in bash -c to override TERM. Pete's terminal exports things
  // like xterm-ghostty that well VMs don't ship terminfo for; tmux
  // refuses to start with "missing or unsuitable terminal". tmux's
  // own default-terminal takes over once it's running.
  const proc = Bun.spawn(
    [
      "well", "exec", "-s", wellName, "--tty", "--",
      "sudo", "-H", "bash", "-c",
      `export TERM=xterm-256color; exec tmux new-session -A -s shell -c /root bash -l`,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  await proc.exited;
}

// `cells exec <name> [--] <command…>` — run a command as root on a cell,
// non-interactively, in the agent's own context (HOME=/root, cwd /root,
// /etc/profile.d/cells-env.sh sourced for PATH + proxy secret). The
// cells-layer counterpart to `cells shell`: shell is the interactive
// tmux drop-in, exec is the scriptable one-shot. Wraps the well-exec →
// sudo-to-root plumbing once so callers never hand-roll it (and never
// trip over `well exec` landing as the unprivileged `well` user).
async function cmdExec(name: string, rest: string[]) {
  // Everything after an optional `--` is the command; without one, the
  // remaining args are the command. `cells exec c -- ls -la` and
  // `cells exec c ls -la` both work.
  const dd = rest.indexOf("--");
  const cmdParts = dd >= 0 ? rest.slice(dd + 1) : rest;
  if (cmdParts.length === 0) {
    console.error("usage: cells exec <name> [--] <command…>");
    process.exit(1);
  }
  await requireCell(name);
  const wellName = await wellNameForCell(name);
  // Preserve argv boundaries end-to-end. The old `cmdParts.join(" ")` +
  // `bash -lc <joined>` re-shell-parsed every arg, so a quoted arg like
  // `cells exec c -- echo 'a "b c" d'` lost its inner quoting on the
  // way through. `well exec --` itself passes args verbatim — the bug
  // was in the cells-side join.
  //
  // Fix: use bash's positional form. `bash -lc 'cd /root; "$@"' bash <args…>`
  // sets $0=bash and $1..=our cmdParts, then "$@" re-expands them as
  // distinct words exactly as received. The -l still sources cells-env.sh;
  // sudo -H still anchors HOME=/root.
  const proc = Bun.spawn(
    [
      "well", "exec", "-s", wellName, "--",
      "sudo", "-H", "bash", "-lc", 'cd /root; "$@"', "bash",
      ...cmdParts,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  process.exit(await proc.exited);
}

function die(msg: string): never {
  console.error(`! ${msg}`);
  process.exit(1);
}

// Read a value with the terminal echo off (interactive `cells secret set` with
// no source flag and a TTY). On a non-TTY (piped / background job) this never
// fires — cmdSecret routes "auto" to stdin there instead.
async function readHiddenLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const isTTY = !!process.stdin.isTTY;
  if (isTTY) Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    const rl = (await import("node:readline")).createInterface({ input: process.stdin });
    const line: string = await new Promise((res) => rl.once("line", (l: string) => res(l)));
    rl.close();
    return line;
  } finally {
    if (isTTY) {
      Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
      process.stderr.write("\n");
    }
  }
}

// Resolve the secret value from its source. IO lives here (the pure parse in
// lib/secret-cli decided WHICH source); the value never round-trips through
// that module. Strips trailing newlines — a trailing \n silently breaks
// bearer tokens, and the in-cell write strips them too, so the reported
// byte-length matches what's stored.
async function resolveSecretValue(source: SecretSource, key: string): Promise<string> {
  let raw: string;
  switch (source.kind) {
    case "env": {
      const v = process.env[source.name];
      if (v == null) die(`--from-env ${source.name}: not set in this environment`);
      raw = v;
      break;
    }
    case "file": {
      try { raw = await Bun.file(source.path).text(); }
      catch (e) { die(`--from-file ${source.path}: ${(e as Error).message}`); }
      break;
    }
    case "stdin": {
      raw = await Bun.stdin.text();
      break;
    }
    case "auto": {
      // Piped → read all of stdin; interactive TTY → hidden prompt.
      raw = process.stdin.isTTY
        ? await readHiddenLine(`secret value for ${key} (input hidden): `)
        : await Bun.stdin.text();
      break;
    }
  }
  return stripTrailingNewlines(raw);
}

// Push the current /etc/profile.d/cells-env.sh to a cell (idempotent). A cell
// baked before the app-secret sourcing block existed won't export a secret we
// write until its shim is refreshed — so `secret set` refreshes it first,
// making the secret immediately live for new shells/jobs (a running supervisor
// still picks it up on its next restart). Body goes via stdin → no heredoc
// escaping. New births/bakes already carry the current shim; this is the
// catch-up for existing cells.
async function ensureCellsEnvShim(well: string): Promise<{ ok: boolean; stderr: string }> {
  const r = await wellExecStdin(
    well,
    `sudo tee /etc/profile.d/cells-env.sh >/dev/null && sudo chmod 644 /etc/profile.d/cells-env.sh && echo SHIM_OK`,
    CELLS_ENV_SH_BODY,
  );
  return { ok: r.ok && r.stdout.includes("SHIM_OK"), stderr: r.stderr || r.stdout };
}

// `cells secret set|list|rm` — per-cell app secrets. Mac-side only (like
// birth/kill): an in-cell caller can't reach welld, so secret plumbing stays
// with the keeper. Value is read from --from-env/--from-file/stdin/hidden-
// prompt and piped via exec stdin — never argv, never echoed, never in DNA.
// Lands as a root:root 0600 file under /etc/cells.secrets.d/<KEY>, picked up
// by cells-env.sh (shells + jobs + supervisor). See docs/proposals/cell-secrets.html.
async function cmdSecret(rest: string[]): Promise<void> {
  const cmd = parseSecretArgs(rest);
  if (cmd.action === "usage") {
    if (cmd.error) console.error(`! ${cmd.error}`);
    console.error("usage:");
    console.error("  cells secret set <cell[,cell2,…]> <KEY> [--from-env VAR | --from-file PATH | --stdin]");
    console.error("  cells secret list <cell>");
    console.error("  cells secret rm  <cell[,cell2,…]> <KEY>");
    console.error("");
    console.error("  the value is read from the named source (or, with no flag: piped stdin,");
    console.error("  else a hidden prompt) — never passed as an argument. Stored root:root 0600");
    console.error("  under /etc/cells.secrets.d/ and exported into every shell, job, and the");
    console.error("  site supervisor via cells-env.sh. `list` shows key NAMES only.");
    process.exit(cmd.error ? 1 : 0);
  }

  // Resolve each named cell → its well up front, so a typo fails before any write.
  const wells: Array<{ cell: string; well: string }> = [];
  for (const cell of cmd.cells) {
    await requireCell(cell);
    wells.push({ cell, well: await wellNameForCell(cell) });
  }

  if (cmd.action === "list") {
    const { cell, well } = wells[0]!;
    const r = await wellExecCapture(well, buildSecretListScript());
    if (!r.ok) die(`secret list on ${cell} failed: ${r.stderr.slice(0, 300)}`);
    const keys = parseSecretListOutput(r.stdout);
    if (keys.length === 0) {
      console.log(`${cell}: (no cells-managed secrets)`);
    } else {
      console.log(`${cell}: ${keys.length} secret${keys.length === 1 ? "" : "s"}`);
      for (const k of keys) console.log(`  ${k}`);
    }
    return;
  }

  if (cmd.action === "rm") {
    let cleared = 0; // confirmed gone on the cell (removed OR already-absent)
    let failed = 0;  // couldn't reach/run on the cell — the key may still be there
    for (const { cell, well } of wells) {
      const r = await wellExecCapture(well, buildSecretRmScript(cmd.key));
      if (!r.ok) { console.error(`! ${cell}: rm ${cmd.key} failed: ${r.stderr.slice(0, 200)}`); failed++; continue; }
      const state = r.stdout.includes("REMOVED") ? "removed" : "absent";
      console.log(`${cell}: ${cmd.key} ${state}`);
      cleared++;
    }
    console.log(`✓ ${cmd.key} cleared on ${cleared}/${wells.length} cell${wells.length === 1 ? "" : "s"}`);
    // Exit nonzero on any failure so a revocation/rotation script can't mistake
    // a partial removal for a complete one (mirrors `set` below).
    if (failed > 0) process.exit(1);
    return;
  }

  // action === "set": resolve the value ONCE, fan it out to every cell.
  const value = await resolveSecretValue(cmd.source, cmd.key);
  if (!value) die(`refusing to set an empty ${cmd.key} (source produced no value)`);
  const script = buildSecretSetScript(cmd.key);
  let ok = 0;
  for (const { cell, well } of wells) {
    // Refresh the env shim first so the secret is actually sourced on cells
    // baked before the app-secret block existed. If the shim push fails, don't
    // claim success — the value would land but never be exported.
    const shim = await ensureCellsEnvShim(well);
    if (!shim.ok) {
      console.error(`! ${cell}: could not refresh env shim, skipping set: ${shim.stderr.slice(0, 160)}`);
      continue;
    }
    const r = await wellExecStdin(well, script, value);
    if (r.ok && r.stdout.includes("SET")) {
      // Byte-length only — the value itself is never printed or logged.
      console.log(`${cell}: set ${cmd.key} (${Buffer.byteLength(value)} bytes, 0600)`);
      ok++;
    } else {
      console.error(`! ${cell}: set ${cmd.key} failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
    }
  }
  console.log(`✓ ${cmd.key} set on ${ok}/${wells.length} cell${wells.length === 1 ? "" : "s"}`);
  console.log("  (new shells and jobs see it immediately — they're fresh processes; a running");
  console.log("   supervisor picks it up on its next restart.)");
  if (ok < wells.length) process.exit(1);
}

async function cmdSleep(name: string) {
  // `cells sleep` = hibernate the agent (release VM RAM, restore on inbound
  // traffic). Distinct from `cells stop`, which is an explicit power-off
  // intended for reset/recovery.
  await requireCell(name);
  const wellName = await wellNameForCell(name);
  let res: Response;
  try {
    res = await fetch(
      `http://127.0.0.1:7878/v1/wells/${encodeURIComponent(wellName)}/hibernate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${await wellsToken()}` },
      },
    );
  } catch (e) {
    if (String(e).includes("ECONNREFUSED")) {
      throw new Error(`welld unreachable on 127.0.0.1:7878 — start it first`);
    }
    throw e;
  }
  if (res.ok) {
    console.log(`✓ ${name} hibernated`);
    return;
  }
  // Idempotency: hibernating an already-stopped well returns 500
  // `hibernate_failed: Virtual machine not running`. Treat as no-op.
  const body = await res.text();
  if (/not running|already stopped/i.test(body)) {
    console.log(`✓ ${name} already asleep`);
    return;
  }
  // Hibernate-not-supported (older welld) is its own state. Don't silently
  // fall back to a cold stop — that throws away in-VM state, which is the
  // exact semantic `cells stop` exists for. Tell the user to make the call.
  if (res.status === 404) {
    throw new Error(
      `welld has no /hibernate endpoint (404). 'cells stop ${name}' will cold-stop the well — that loses in-VM state, so we don't do it implicitly.`,
    );
  }
  throw new Error(`hibernate failed: ${res.status} ${body}`);
}

async function cmdStop(name: string) {
  // `cells stop` = explicit VM power-off. Reserved for reset/recovery —
  // when you want to clear in-VM state, not just release RAM. Use
  // `cells sleep` for normal pause-the-agent semantics.
  await requireCell(name);
  const wellName = await wellNameForCell(name);
  await $`well stop -s ${wellName}`;
  console.log(`✓ ${name} stopped (cold). Use 'cells wake ${name}' to bring it back.`);
}

async function cmdWake(name: string) {
  await requireCell(name);
  const wellName = await wellNameForCell(name);
  await $`well start -s ${wellName}`;
}

// `cells pin <name>` — mark the cell never-auto-hibernate. Use for cells
// whose surface must stay live (dashboard narrator, cron-like cells, any
// cell doing silent in-guest work welld's activity probe can't see). The
// underlying knob is welld's auto_sleep_seconds=null override.
//
// `cells unpin <name>` — restore welld-default sleep (60s idle → hibernate).
// `cells wake` (above) is separate — it's a one-shot wake-up regardless of
// pin state. Pinning prevents future sleeps; waking ends an existing sleep.
async function cmdPin(name: string) {
  await requireCell(name);
  const wellName = await wellNameForCell(name);
  await setAutoSleep(wellName, null);
  console.log(`✓ ${name} pinned (auto-sleep disabled)`);
}

async function cmdUnpin(name: string) {
  await requireCell(name);
  const wellName = await wellNameForCell(name);
  await setAutoSleep(wellName, DEFAULT_AUTO_SLEEP_SECONDS);
  console.log(`✓ ${name} unpinned (auto-sleep ${DEFAULT_AUTO_SLEEP_SECONDS}s)`);
}

// ───── menubar ─────
//
// Native macOS status item, built from cli/menubar/swift/main.swift. No
// SwiftBar dependency.
//
// `cells menubar install`    — build the .app, drop it at
//                              ~/.cells/menubar/CellsMenubar.app, and install
//                              a LaunchAgent that auto-starts it at login.
// `cells menubar uninstall`  — unload the agent and remove both files.
// `cells menubar status`     — report whether the app + agent are installed
//                              and the agent is loaded.
// `cells menubar build`      — rebuild the .app in place (handy after editing
//                              the Swift source).

const MENUBAR_APP_PATH = join(homedir(), ".cells", "menubar", "CellsMenubar.app");
const MENUBAR_AGENT_LABEL = "md.cells.menubar";
const MENUBAR_AGENT_PLIST = join(homedir(), "Library", "LaunchAgents", `${MENUBAR_AGENT_LABEL}.plist`);

async function cmdMenubar(args: string[]) {
  const sub = args[0] ?? "status";
  if (sub === "install")   { await cmdMenubarInstall();   return; }
  if (sub === "uninstall") { await cmdMenubarUninstall(); return; }
  if (sub === "status")    { await cmdMenubarStatus();    return; }
  if (sub === "build")     { await buildMenubarApp();     return; }
  console.error(`unknown menubar subcommand: ${sub}`);
  console.error("usage: cells menubar [install|uninstall|status|build]");
  process.exit(1);
}

// Resolved cells entrypoint we want the menubar app's actions (Open shell /
// TUI) to call. Prefer the user's stable shim at ~/.local/bin/cells so a
// project-folder rename doesn't break the installed agent.
function resolveCellsBin(): string {
  const preferred = join(homedir(), ".local", "bin", "cells");
  return existsSync(preferred) ? preferred : (process.argv[1] ?? preferred);
}

async function buildMenubarApp(): Promise<string> {
  const outDir = dirname(MENUBAR_APP_PATH);
  await mkdir(outDir, { recursive: true });
  const buildScript = join(REPO_ROOT, "cli", "menubar", "swift", "build.sh");
  const proc = Bun.spawn(["bash", buildScript, outDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`menubar build failed (swiftc exit ${code})`);
    process.exit(1);
  }
  return MENUBAR_APP_PATH;
}

// Old-world SwiftBar plugin + helper. Predates the native app. If present on
// install or uninstall, scrub them so we don't end up with two cells icons in
// the menubar.
const LEGACY_SWIFTBAR_PLUGIN = join(
  homedir(), "Library", "Application Support", "SwiftBar", "Plugins", "cells.10s.sh",
);
const LEGACY_RUN_HELPER = join(homedir(), ".cells", "menubar", "run.sh");

async function cleanLegacySwiftBar() {
  for (const p of [LEGACY_SWIFTBAR_PLUGIN, LEGACY_RUN_HELPER]) {
    if (existsSync(p)) {
      await unlink(p);
      console.log(`✓ removed legacy ${p}`);
    }
  }
}

async function cmdMenubarInstall() {
  await buildMenubarApp();
  await cleanLegacySwiftBar();

  // LaunchAgent: KeepAlive restarts on crash, RunAtLoad starts it now and at
  // every login. CELLS_BIN is read by the Swift app to resolve shell/tui
  // actions back to the right `cells` entrypoint.
  const cellsBin = resolveCellsBin();
  const exec = join(MENUBAR_APP_PATH, "Contents", "MacOS", "CellsMenubar");
  const plist =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n` +
    `<dict>\n` +
    `  <key>Label</key><string>${MENUBAR_AGENT_LABEL}</string>\n` +
    `  <key>ProgramArguments</key>\n` +
    `  <array><string>${exec}</string></array>\n` +
    `  <key>EnvironmentVariables</key>\n` +
    `  <dict><key>CELLS_BIN</key><string>${cellsBin}</string></dict>\n` +
    `  <key>RunAtLoad</key><true/>\n` +
    `  <key>KeepAlive</key><true/>\n` +
    `  <key>StandardOutPath</key><string>${join(homedir(), ".cells", "menubar", "stdout.log")}</string>\n` +
    `  <key>StandardErrorPath</key><string>${join(homedir(), ".cells", "menubar", "stderr.log")}</string>\n` +
    `</dict>\n` +
    `</plist>\n`;
  await mkdir(dirname(MENUBAR_AGENT_PLIST), { recursive: true });
  await writeFile(MENUBAR_AGENT_PLIST, plist);

  // Reload the agent — unload (ignore failure if not loaded) then load.
  await Bun.spawn(["launchctl", "unload", MENUBAR_AGENT_PLIST], {
    stdout: "ignore", stderr: "ignore",
  }).exited;
  const load = Bun.spawn(["launchctl", "load", MENUBAR_AGENT_PLIST], {
    stdout: "inherit", stderr: "inherit",
  });
  const lcode = await load.exited;
  if (lcode !== 0) {
    console.error(`launchctl load failed (exit ${lcode})`);
    process.exit(1);
  }

  console.log(`✓ built  ${MENUBAR_APP_PATH}`);
  console.log(`✓ agent  ${MENUBAR_AGENT_PLIST} (loaded)`);
  console.log(`✓ cells bin → ${cellsBin}`);
}

async function cmdMenubarUninstall() {
  let removed = false;
  if (existsSync(MENUBAR_AGENT_PLIST)) {
    await Bun.spawn(["launchctl", "unload", MENUBAR_AGENT_PLIST], {
      stdout: "ignore", stderr: "ignore",
    }).exited;
    await unlink(MENUBAR_AGENT_PLIST);
    console.log(`✓ removed ${MENUBAR_AGENT_PLIST}`);
    removed = true;
  }
  if (existsSync(MENUBAR_APP_PATH)) {
    await rm(MENUBAR_APP_PATH, { recursive: true, force: true });
    console.log(`✓ removed ${MENUBAR_APP_PATH}`);
    removed = true;
  }
  // Also kill any process still running from a previous copy (e.g. one
  // launched by hand without the LaunchAgent).
  await Bun.spawn(["pkill", "-f", "CellsMenubar"], {
    stdout: "ignore", stderr: "ignore",
  }).exited;
  await cleanLegacySwiftBar();
  if (!removed) console.log("not installed");
}

async function cmdMenubarStatus() {
  const appPresent = existsSync(MENUBAR_APP_PATH);
  const plistPresent = existsSync(MENUBAR_AGENT_PLIST);
  let loaded = false;
  if (plistPresent) {
    const proc = Bun.spawn(["launchctl", "list", MENUBAR_AGENT_LABEL], {
      stdout: "pipe", stderr: "pipe",
    });
    loaded = (await proc.exited) === 0;
  }
  console.log(`app:    ${appPresent ? "installed" : "missing"} (${MENUBAR_APP_PATH})`);
  console.log(`agent:  ${plistPresent ? (loaded ? "loaded" : "installed (not loaded)") : "missing"} (${MENUBAR_AGENT_PLIST})`);
}

// First-line diagnostic for "auth feels broken." See docs/oauth-refresh.md.
// One refill at a time — both the steward sweep and the empty-pool birth
// path use this guard so a drought doesn't stack bakes.
async function isRefillInFlight(): Promise<boolean> {
  const p = Bun.spawn(["pgrep", "-f", "cells.ts pool refill"], { stdout: "pipe", stderr: "ignore" });
  await p.exited;
  return (await new Response(p.stdout).text()).trim().length > 0;
}

// Shared by the human doctor (section 8) and `doctor --json` (the steward's
// food). One probe pass per cell: welld service def, power, in-guest unit/
// health/OOM/clock. Hibernated cells get the def check only — never woken.
type TransportRow = {
  name: string;
  well: string;
  power: "running" | "hibernated" | "unknown";
  status: "ok" | "warn" | "fail";
  reasons: string[];
  // Runtime-DNA rev read from the running cell's /root/.dna-rev ("" when
  // hibernated/unprobed/pre-DNA-rev). Compared Mac-side in the doctor's dna
  // block — kept OUT of the transport verdict so DNA staleness never reads
  // as a transport fault (the steward's transport fixes must not fire on it).
  dna_rev: string;
};

async function collectFleetTransport(): Promise<TransportRow[]> {
  const { GUEST_PROBE_SCRIPT, parseGuestProbe, classifyCellTransport } = await import("./lib/fleet-probe");
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  const token = await wellsToken().catch(() => "");
  const wellsByName = new Map<string, any>();
  try {
    const data: any = await fetch(`${base}/dashboard/data`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    }).then((r) => (r.ok ? r.json() : null));
    for (const w of data?.wells ?? []) wellsByName.set(w.name, w);
  } catch {
    /* welld unreachable — every cell reports power unknown below */
  }

  const reg = await loadRegistry();
  const rows: TransportRow[] = [];
  await Promise.all(
    // Skip "warming" entries: a cell mid-birth (or a leaked crash artifact) is
    // not yet a probeable live cell — probing it yields a false transport FAIL.
    reg.cells.filter((c) => c.status !== "warming").map(async (c) => {
      const wellName = await wellNameForCell(c.name);
      const well = wellsByName.get(wellName);
      const power: "running" | "hibernated" | "unknown" =
        well?.status === "running" ? "running" : well?.status === "stopped" ? "hibernated" : "unknown";

      let defPresent = false;
      try {
        const svc: any = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}/services`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        }).then((r) => (r.ok ? r.json() : null));
        defPresent = (svc?.services ?? []).some((s: any) => s.id === "site");
      } catch {
        /* treated as missing — surfaces as fail, which is the safe loud default */
      }

      let guest: ReturnType<typeof parseGuestProbe> = null;
      if (power === "running") {
        try {
          const proc = Bun.spawn(
            ["well", "exec", "-s", wellName, "--", "sudo", "bash", "-lc", GUEST_PROBE_SCRIPT],
            { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
          );
          const out = await new Response(proc.stdout).text();
          await proc.exited;
          guest = parseGuestProbe(out);
        } catch {
          /* guest stays null → classified as warn */
        }
      }

      const verdict = classifyCellTransport({
        defPresent,
        power,
        guest,
        macEpochS: Math.floor(Date.now() / 1000),
      });
      rows.push({ name: c.name, well: wellName, power, status: verdict.status, reasons: verdict.reasons, dna_rev: guest?.dna_rev ?? "" });
    }),
  );
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

// `cells doctor --json` — the machine-readable subset the steward sweep
// consumes. Substrate + service health as booleans, pool depth, and the
// per-cell transport verdicts. Everything best-effort: an unreachable
// service reports ok:false rather than throwing, so the steward always
// gets a complete picture to act on.
async function cmdDoctorJson() {
  const probe = async (url: string): Promise<any> => {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null));
    } catch {
      return null;
    }
  };
  const token = await wellsToken().catch(() => "");
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";

  const welld = await (async () => {
    try {
      return await fetch(`${base}/healthz`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      }).then((r) => (r.ok ? r.json() : null));
    } catch {
      return null;
    }
  })();
  const proxyHealth = await probe("https://proxy.cells.md/_proxy/health");
  const hostBridge = await probe("http://127.0.0.1:7880/healthz");
  const waPort = process.env.WA_BRIDGE_PORT ?? "7891";
  const waBridge = await probe(`http://127.0.0.1:${waPort}/health`);

  const pool = await loadPool().catch(() => ({ members: [] as any[] }));
  const open = pool.members.filter((m: any) => m.state === "open").length;

  const reg = await loadRegistry();
  const specials: Record<string, { power: string; pinned: boolean }> = {};
  for (const c of reg.cells.filter((c) => c.special)) {
    const info: any = await (async () => {
      try {
        return await fetch(`${base}/v1/wells/cells-${c.name}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        }).then((r) => (r.ok ? r.json() : null));
      } catch {
        return null;
      }
    })();
    specials[c.name] = {
      power: info?.status ?? "unknown",
      pinned: info ? info.auto_sleep_seconds === null : false,
    };
  }

  const cells = await collectFleetTransport();

  // DNA drift: current runtime-DNA rev vs what eggs/cells carry. Pool eggs
  // judged from pool.json (zero wakes); live cells from the probe's dna_rev
  // (running only). tree_clean gates the steward's auto-refresh — see
  // dnaTreeClean(). The steward consumes .dna.stale_cells + .dna.tree_clean.
  const dna = summarizeDnaDrift({
    currentRev: dnaRev(DNA_DIR),
    treeClean: dnaTreeClean(),
    poolRevs: pool.members
      .filter((m: any) => m.state === "open" && m.variant_signature === V1_POOL_VARIANT_SIGNATURE)
      .map((m: any) => m.dna_rev),
    cellRevs: cells
      .filter((c) => c.power === "running")
      .map((c) => ({ name: c.name, rev: c.dna_rev })),
  });

  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        welld: { ok: welld?.ok === true, degraded: welld?.degraded === true },
        proxy: { ok: proxyHealth?.ok === true },
        hostBridge: { ok: hostBridge?.ok === true },
        waBridge: {
          ok: waBridge?.ok === true,
          wa: waBridge?.wa ?? "unreachable",
          // Delivery-asymmetry signals: "connected" can lie. After a WA
          // socket bounce the bridge kept accepting inbound and logging
          // "completed" while every outbound send silently died (buyer saw
          // nothing, 2026-06-12). Fresh inbound + stale outbound is that
          // failure's signature — the steward alerts on it.
          inboundAgeS: typeof waBridge?.lastInboundAgeS === "number" ? waBridge.lastInboundAgeS : null,
          outboundAgeS: typeof waBridge?.lastOutboundAgeS === "number" ? waBridge.lastOutboundAgeS : null,
        },
        pool: { open, target: V1_POOL_TARGET_DEPTH },
        dna,
        specials,
        cells,
      },
      null,
      2,
    ),
  );
}

async function cmdDoctor() {
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const red = "\x1b[31m";
  const green = "\x1b[32m";
  const yellow = "\x1b[33m";

  // 1. auth.json on disk
  const authPath = join(homedir(), ".pi/agent/auth.json");
  if (!existsSync(authPath)) {
    console.log(`${red}✗ no ${authPath}${reset} — run pi /login`);
    process.exit(1);
  }
  let auth: any;
  try {
    auth = JSON.parse(await readFile(authPath, "utf-8"));
  } catch (e) {
    console.log(`${red}✗ ${authPath} unreadable: ${e}${reset}`);
    process.exit(1);
  }
  const ant = auth.anthropic;
  if (!ant?.access || !ant?.refresh) {
    console.log(`${red}✗ auth.json has no anthropic OAuth tokens${reset} — run pi /login`);
    process.exit(1);
  }
  const remainingMin = Math.round((ant.expires - Date.now()) / 60000);
  const expColor = remainingMin > 60 ? green : remainingMin > 0 ? yellow : red;
  console.log(`anthropic access: ${ant.access.slice(0, 20)}…`);
  console.log(`  expires in:    ${expColor}${remainingMin} min${reset}`);
  console.log(`refresh token:  ${ant.refresh.slice(0, 20)}…`);

  // 2. Flag file
  const flagPath = join(homedir(), ".cells/auth-needs-login");
  if (existsSync(flagPath)) {
    const ts = (await readFile(flagPath, "utf-8")).trim();
    console.log(`${red}⚠ auth-needs-login flag set at ${ts}${reset} — refresh token revoked, run pi /login`);
  }

  // 3. Proxy health
  const port = process.env.CELLS_PROXY_PORT ?? "8787";
  try {
    const res = await fetch(`http://localhost:${port}/_proxy/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data: any = await res.json();
      console.log(`\nproxy on :${port} — ${green}up${reset}`);
      console.log(`  expires_in_min: ${data.expires_in_min}`);
      if (data.last_refresh) {
        const ago = Math.round((Date.now() - data.last_refresh.at) / 60000);
        const oc = data.last_refresh.outcome;
        const color = oc === "ok" ? green : oc === "429" ? yellow : red;
        console.log(`  last_refresh:   ${color}${oc}${reset} (${ago} min ago)`);
        if (data.last_refresh.detail) console.log(`    detail: ${dim}${data.last_refresh.detail}${reset}`);
      } else {
        console.log(`  last_refresh:   ${dim}none yet${reset}`);
      }
      if (data.blocked_until) {
        console.log(`  ${yellow}blocked_until:  ${data.blocked_until}${reset} (rate-limit backoff)`);
      }
      if (data.needs_login) {
        console.log(`  ${red}needs_login:    true${reset}`);
      }
    } else {
      console.log(`\nproxy on :${port} — ${red}HTTP ${res.status}${reset}`);
    }
  } catch (e) {
    console.log(`\nproxy on :${port} — ${yellow}not reachable${reset} (${dim}${String(e).slice(0, 80)}${reset})`);
  }

  // 4. pi-ai patches on the global install (mother + pulse both read these).
  // If pi gets reinstalled/updated, the patches blow away.
  const piPatchesOk = await checkPiPatches();
  console.log("");
  if (piPatchesOk.ok) {
    console.log(`pi patches:    ${green}applied${reset} (${piPatchesOk.detail})`);
  } else {
    console.log(`pi patches:    ${red}missing${reset} — ${piPatchesOk.detail}`);
    console.log(`  fix:         bash ${join(MOTHER_ROOT, "dna/scripts/apply-pi-patches.sh")}`);
  }

  // 5. The launchd watcher that re-applies patches when pi-ai is reinstalled.
  // Without it, every pi update silently breaks pulse + cells until next doctor run.
  const watcherInstalled = existsSync(piPatchesPlistPath());
  if (watcherInstalled) {
    console.log(`pi watcher:    ${green}installed${reset} (auto-reapplies on pi-ai update)`);
  } else {
    console.log(`pi watcher:    ${yellow}not installed${reset}`);
    console.log(`  fix:         cells schedule-pi-patches`);
  }

  // well shim probe — catches gitignored bin wrappers that point at
  // stale absolute paths after a project folder rename. A single
  // `well --help` probe catches this in milliseconds.
  console.log("");
  try {
    const probe = Bun.spawn(["well", "--help"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(probe.stderr).text();
    const code = await probe.exited;
    if (code === 0) {
      console.log(`well shim:     ${green}responsive${reset}`);
    } else {
      console.log(`well shim:     ${red}exit ${code}${reset} — ${stderr.slice(0, 200)}`);
      console.log(`  fix:         check ${homedir()}/.local/bin/well exec path; common after wells repo rename`);
    }
  } catch (e) {
    console.log(`well shim:     ${red}unreachable${reset} (${dim}${String(e).slice(0, 80)}${reset})`);
    console.log(`  fix:         check ${homedir()}/.local/bin/well is in PATH and executable`);
  }

  // 6b. Post-birth deployment status across the fleet. Reads the
  // structured signal at ~/.cells/postwork/<name>.json (written by
  // scripts/birth-postwork.sh) — per-step status + completed_at
  // timestamp. Distinguishes ok / failed (with which steps) / running /
  // legacy (no postwork.json), and surfaces failed-step detail Pete
  // would otherwise only see by tailing the per-cell log.
  //
  // Stale-run heuristic: a chain that hasn't completed within 5 minutes
  // is probably hung — most postworks finish in ~10s.
  console.log("");
  const regForDeploy = await loadRegistry();
  const STALE_THRESHOLD_MS = 5 * 60 * 1000;
  let failedCount = 0;
  let staleCount = 0;
  for (const c of regForDeploy.cells) {
    const summary = await loadPostworkSummary(c.name);
    if (!summary) {
      // Fallback for cells born before postwork.json: classify from the
      // legacy plain log if present, so a stuck pre-JSON postwork still
      // gets flagged STALE rather than silently dismissed as "legacy".
      const legacyLog = join(homedir(), ".cells", "logs", "birth-postwork", `${c.name}.log`);
      if (!existsSync(legacyLog)) {
        console.log(`deploy ${c.name.padEnd(18)} ${dim}— (legacy or pre-postwork.json birth)${reset}`);
        continue;
      }
      try {
        const txt = await readFile(legacyLog, "utf-8");
        const done = txt.includes("post-birth done");
        const ageMs = Date.now() - statSync(legacyLog).mtimeMs;
        if (done) {
          console.log(`deploy ${c.name.padEnd(18)} ${green}ok${reset} ${dim}(${Math.round(ageMs / 60000)} min ago, legacy log)${reset}`);
        } else if (ageMs > STALE_THRESHOLD_MS) {
          console.log(`deploy ${c.name.padEnd(18)} ${red}STALE${reset} (${Math.round(ageMs / 60000)} min, legacy log)`);
          console.log(`  log: ${legacyLog}`);
          staleCount++;
        } else {
          console.log(`deploy ${c.name.padEnd(18)} ${yellow}running${reset} (${Math.round(ageMs / 1000)}s in, legacy log)`);
        }
      } catch {
        console.log(`deploy ${c.name.padEnd(18)} ${dim}— (legacy log unreadable)${reset}`);
      }
      continue;
    }
    if (summary.status === "ok") {
      const completedMs = summary.completed_at ? Date.parse(summary.completed_at) : Date.now();
      const ageMin = Math.round((Date.now() - completedMs) / 60000);
      console.log(`deploy ${c.name.padEnd(18)} ${green}ok${reset} ${dim}(${ageMin} min ago)${reset}`);
    } else if (summary.status === "failed") {
      const which = summary.failed_steps.join(", ");
      console.log(`deploy ${c.name.padEnd(18)} ${red}FAILED${reset} (${which})`);
      console.log(`  file: ${join(homedir(), ".cells/postwork", `${c.name}.json`)}`);
      failedCount++;
    } else {
      const startedMs = summary.started_at ? Date.parse(summary.started_at) : Date.now();
      const ageMs = Date.now() - startedMs;
      if (ageMs > STALE_THRESHOLD_MS) {
        console.log(`deploy ${c.name.padEnd(18)} ${red}STALE${reset} (${Math.round(ageMs / 60000)} min running, expected ~10s)`);
        console.log(`  file: ${join(homedir(), ".cells/postwork", `${c.name}.json`)}`);
        staleCount++;
      } else {
        console.log(`deploy ${c.name.padEnd(18)} ${yellow}running${reset} (${Math.round(ageMs / 1000)}s in)`);
      }
    }
  }
  if (failedCount > 0) {
    console.log(`  ${red}${failedCount} cell(s) have failed post-birth steps. cat the postwork JSON to see which.${reset}`);
  }
  if (staleCount > 0) {
    console.log(`  ${yellow}${staleCount} cell(s) have stuck post-birth tasks. tail the per-cell log for details.${reset}`);
  }

  // 7. Specials (mother, pulse) — if they've been baked as real cells,
  // verify each is alive + pinned. Silent skip if no special is registered
  // (still on the legacy on-Mac path).
  const reg = await loadRegistry();
  const specials = reg.cells.filter(c => c.special);
  if (specials.length === 0) {
    console.log(`\nspecials:      ${dim}none registered (legacy mother/pulse on Mac)${reset}`);
  } else {
    console.log("");
    const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
    const token = await wellsToken().catch(() => "");
    for (const s of specials) {
      const wellName = `cells-${s.name}`;
      try {
        const info = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2000),
        }).then(r => r.ok ? r.json() : null);
        if (!info) {
          console.log(`${s.name}:        ${red}well ${wellName} not found${reset}`);
          continue;
        }
        const aliveOk = info.status === "running" || info.status === "alive_running";
        const pinOk = info.auto_sleep_seconds === null;
        const aliveTag = aliveOk ? `${green}${info.status}${reset}` : `${yellow}${info.status}${reset}`;
        const pinTag = pinOk ? `${green}pinned${reset}` : `${red}not pinned (auto_sleep=${info.auto_sleep_seconds})${reset}`;
        console.log(`${s.name}:        ${aliveTag} · ${pinTag}`);
        if (!pinOk) console.log(`  fix:         cells pin ${s.name}`);
      } catch (e) {
        console.log(`${s.name}:        ${red}probe failed${reset} (${dim}${String(e).slice(0, 80)}${reset})`);
      }
    }
  }

  // 8. Fleet transport — the in-well probes. Everything above stops at the
  // Mac; these reach inside each cell and check the talk reply path end to
  // end: welld service definition present, well-site unit materialized in
  // the guest, supervisor :8080 answering, recent OOM kills, clock skew.
  // Hibernated wells get the definition check only — doctor never wakes a
  // cell. (Born from the 2026-06-09/10 incident, where all of the above was
  // green while mother had no supervisor for 18 days.)
  {
    console.log("\nfleet transport:");
    const rows = await collectFleetTransport();
    let transportFails = 0;
    for (const r of rows) {
      const tag =
        r.status === "ok"
          ? `${green}ok${reset}`
          : r.status === "warn"
            ? `${yellow}warn${reset}`
            : `${red}FAIL${reset}`;
      if (r.status === "fail") transportFails++;
      const powerTag = r.power === "running" ? "awake " : r.power === "hibernated" ? "asleep" : "?     ";
      console.log(`  ${r.name.padEnd(18)} ${powerTag} ${tag}${r.reasons.length ? `  ${dim}${r.reasons.join("; ")}${reset}` : ""}`);
    }
    if (transportFails > 0) {
      console.log(`  ${red}${transportFails} cell(s) cannot complete a talk round-trip. Fix before trusting the fleet.${reset}`);
    }

    // 8b. DNA drift — does each egg/cell carry the current runtime DNA?
    // Reuses the transport probe's dna_rev (no extra round-trips). Pool eggs
    // judged from pool.json (zero wakes). A stale running cell self-heals on
    // the steward's next sweep (when the tree is clean); a stale egg is
    // culled + rebaked by reconcile. Informational here — never a hard fail.
    try {
      const pool = await loadPool();
      const drift = summarizeDnaDrift({
        currentRev: dnaRev(DNA_DIR),
        treeClean: dnaTreeClean(),
        poolRevs: pool.members
          .filter((m) => m.state === "open" && m.variant_signature === V1_POOL_VARIANT_SIGNATURE)
          .map((m) => m.dna_rev),
        cellRevs: rows.filter((r) => r.power === "running").map((r) => ({ name: r.name, rev: r.dna_rev })),
      });
      const treeNote = drift.tree_clean ? "" : ` ${yellow}(working tree dirty — auto-heal paused)${reset}`;
      console.log(`\nDNA rev:        ${drift.current ? `${dim}${drift.current}${reset}` : `${yellow}unknown${reset}`}${treeNote}`);
      const poolColor = drift.pool.stale > 0 ? yellow : green;
      console.log(
        `  pool:         ${poolColor}${drift.pool.current}/${drift.pool.total} current${reset}` +
          (drift.pool.stale > 0 ? `${dim}, ${drift.pool.stale} stale${reset}` : "") +
          (drift.pool.unknown > 0 ? `${dim}, ${drift.pool.unknown} unknown (pre-rev egg)${reset}` : ""),
      );
      const unknownCells = drift.cells.filter((c) => c.state === "unknown").map((c) => c.name);
      if (drift.stale_cells.length > 0) {
        console.log(`  live cells:   ${yellow}${drift.stale_cells.length} stale${reset} ${dim}— ${drift.stale_cells.join(", ")} ${drift.tree_clean ? "(steward refreshes next sweep)" : "(commit DNA to let the steward refresh)"}${reset}`);
      } else if (unknownCells.length > 0) {
        console.log(`  live cells:   ${green}${drift.cells.length - unknownCells.length} current${reset}${dim}, ${unknownCells.length} pre-rev (refresh to adopt: ${unknownCells.join(", ")})${reset}`);
      } else if (drift.cells.length > 0) {
        console.log(`  live cells:   ${green}all current${reset} ${dim}(running, probed)${reset}`);
      }
    } catch (e) {
      console.log(`\nDNA rev:        ${yellow}skipped${reset} ${dim}(${String(e).slice(0, 80)})${reset}`);
    }
  }

  // 9. wa-bridge — the WhatsApp transport adapter (Zero's Mac daemon,
  // :7891). It's the single point of failure for the buyer-facing advisor
  // surface and its known failure mode is dying silently (Baileys session
  // expiry → QR re-pair). Probe /health: wa must be "connected", queues
  // empty. Absent daemon is a warn, not a fail — not every operator Mac
  // runs the HomeZero surface.
  {
    const waPort = process.env.WA_BRIDGE_PORT ?? "7891";
    let line: string;
    try {
      const h: any = await fetch(`http://127.0.0.1:${waPort}/health`, {
        signal: AbortSignal.timeout(2000),
      }).then((r) => (r.ok ? r.json() : null));
      if (h?.ok && h?.wa === "connected") {
        const depths = Object.entries(h.queueDepths ?? {}).filter(([, n]) => Number(n) > 0);
        line = depths.length
          ? `${yellow}connected, queued${reset} ${dim}(${depths.map(([k, n]) => `${k}:${n}`).join(", ")} — deliveries backing up)${reset}`
          : `${green}connected${reset} ${dim}(up ${Math.round((h.uptime ?? 0) / 3600)}h)${reset}`;
      } else if (h) {
        line = `${red}socket ${h.wa ?? "unknown"}${reset} ${dim}— WhatsApp surface down; may need QR re-pair${reset}`;
      } else {
        line = `${yellow}bad /health response${reset}`;
      }
    } catch {
      line = `${yellow}not running${reset} ${dim}(WhatsApp surface offline — fine if this Mac doesn't host HomeZero)${reset}`;
    }
    console.log(`\nwa-bridge:     ${line}`);
  }

  // 10. Orphan wells — welld VMs that nothing in cells owns. The signature of a
  // half-finished birth (classically `bake-egg.sh` run outside `cells birth`,
  // the wrapper that owns warming-register → promote): a configured well left
  // running, its egg consumed from the pool, never written to cells.json. It
  // "looks born" but is absent from `cells list`, holding RAM/disk no command
  // reaps. Advisory only — the known set below is GENEROUS (every naming
  // convention a real cell's well could carry, warming cells included) so a live
  // cell is never mistaken for junk; a flag is a candidate to inspect, not an
  // auto-reap target. welld unreachable → skip silently (section 3/8 surface that).
  try {
    const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
    const wr = await fetch(`${base}/v1/wells`, {
      headers: { Authorization: `Bearer ${await wellsToken()}` },
      signal: AbortSignal.timeout(3000),
    });
    if (wr.ok) {
      const body: any = await wr.json();
      const welldWells = (Array.isArray(body?.wells) ? body.wells : [])
        .map((w: any) => String(w?.name ?? "")).filter(Boolean);
      // The registry AND pool.json are both load-bearing: without either we
      // can't tell an owned cell/egg from an orphan. They throw on a malformed
      // file — DO NOT swallow that into an empty set, because then every real
      // cell/egg welld reports would be flagged an orphan and the operator told
      // to destroy valid wells (a state-file glitch becoming data loss). Skip
      // the check loudly instead.
      let known: string[] | null = null;
      let poolWells: string[] | null = null;
      try {
        const reg = (await loadRegistry()).cells;
        known = [];
        for (const c of reg) {
          known.push(await wellNameForCell(c.name), `cells-${c.name}`, c.name);
          if (c.hatched_from) known.push(`egg-${c.hatched_from}`);
        }
        poolWells = (await loadPool()).members.map((m: any) => String(m?.well_name ?? "")).filter(Boolean);
      } catch (e) {
        console.log(`\norphan wells:  ${yellow}skipped${reset} ${dim}(registry or pool.json unreadable — can't distinguish orphans from owned wells: ${String(e).slice(0, 80)})${reset}`);
      }
      if (known && poolWells) {
        const orphans = findOrphanWells({ welldWells, knownWells: known, poolWells });
        if (orphans.length === 0) {
          console.log(`\norphan wells:  ${green}none${reset} ${dim}(every welld VM is a registered cell or a pool egg)${reset}`);
        } else {
          console.log(`\norphan wells:  ${red}${orphans.length}${reset} ${dim}— welld VMs nothing in cells owns (half-finished birth? bake-egg.sh run outside \`cells birth\`?):${reset}`);
          for (const w of orphans) {
            console.log(`  ${red}${w}${reset} ${dim}— unowned. If confirmed orphan (not a birth in flight), destroy the well via welld.${reset}`);
          }
        }
      }
    }
  } catch {
    // welld unreachable / token missing — other sections already flag that.
  }
}

async function checkPiPatches(): Promise<{ ok: boolean; detail: string }> {
  // Check the codex extractAccountId stub — single most-load-bearing patch
  // and easy to detect (one-liner present or full JWT-decoder body).
  const candidates = [
    join(homedir(), ".bun/install/global/node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js"),
    join(homedir(), ".bun/install/global/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js"),
    join(homedir(), ".bun/install/global/node_modules/@mariozechner/pi-agent-core/node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js"),
  ];
  const found = candidates.filter((p) => existsSync(p));
  if (found.length === 0) return { ok: false, detail: "no pi-ai install found in ~/.bun/install/global" };
  const stubMarker = 'function extractAccountId(token) { return ""';
  const unpatched: string[] = [];
  for (const f of found) {
    const body = await readFile(f, "utf-8");
    if (!body.includes(stubMarker)) unpatched.push(f);
  }
  if (unpatched.length > 0) {
    return { ok: false, detail: `${unpatched.length}/${found.length} pi-ai copies unpatched (codex extractAccountId)` };
  }
  return { ok: true, detail: `${found.length}/${found.length} pi-ai copies stubbed` };
}

// ───── routed through local Pi ─────

type CreateOpts = {
  harness?: string;
  model?: ModelKey;
  thinking?: string;
  extensions?: string[];
  packages?: string[];
  channels?: ChannelValue[];
  slackChannel?: string;
  seed?: string;        // first message auto-sent post-birth (default: introduce-yourself)
  seedOff?: boolean;    // true if --seed=off — no seed greeting
  noPool?: boolean;     // deprecated no-op — birth is pool-only now (parsed for back-compat)
  project?: string;     // fleet-grouping label recorded in the registry (see `cells agents`)
  brief?: string;       // freeform brief (compiled to config + seed purpose); triggers preview
  yes?: boolean;        // --yes: skip the brief preview/confirm
  dryRun?: boolean;     // --dry-run/--plan: print the resolved birth plan and exit (no egg)
};

// Vocabulary the brief compiler recognizes as config tokens. Models come from
// MODEL_IDS (the single source of truth); harnesses + thinking levels are the
// fixed sets the validators in cmdCreate already enforce.
const BRIEF_THINKING_VOCAB = ["minimal", "low", "medium", "high", "xhigh", "max", "adaptive"];
const BRIEF_HARNESS_VOCAB = ["pi", "claude-code", "codex", "hermes"];
function briefVocab(): BriefVocab {
  return { models: Object.keys(MODEL_IDS), harnesses: BRIEF_HARNESS_VOCAB, thinkingLevels: BRIEF_THINKING_VOCAB };
}

// Default seed: the cell greets the user back in one sentence + offers help.
// Surfaces the magical-first-talk wedge — `cells birth bob` returns with bob
// already saying hi, no keystrokes from the user. Override with --seed=<text>
// or disable with --seed=off.
const DEFAULT_SEED = "introduce yourself in one sentence and tell me what you can help with";

// Env vars injected when invoking mother (and any host-side scripts it shells
// out to). Cells run on local wells (welld daemon on :7878; the agent runs as
// root, HOME=/root). The SPRITES_* names are kept as the env-var contract for
// scripts and mother's tools — they were established when wells was a wells
// drop-in. Internally, everything points at welld.
function wellsEnv(): Record<string, string> {
  const tokenPath = join(homedir(), ".wells", "token");
  if (!existsSync(tokenPath)) {
    console.error(`welld is required: ~/.wells/token missing — start welld and retry`);
    process.exit(1);
  }
  return {
    WELL_API_URL: "http://localhost:7878",
    WELL_TOKEN: readFileSync(tokenPath, "utf-8").trim(),
    WELL_BINARY: "well",
  };
}

const PACKAGE_VALUES = OPTIONAL_PACKAGES.map((p) => p.value);

function parseCreateArgs(args: string[]): { name: string | undefined; opts: CreateOpts } {
  const opts: CreateOpts = {};
  const positionals: string[] = [];
  for (const a of args) {
    if (a.startsWith("--harness=")) {
      opts.harness = a.slice("--harness=".length);
    } else if (a.startsWith("--model=")) {
      const v = a.slice("--model=".length);
      if (!(v in MODEL_IDS)) {
        console.error(`unknown model: ${v}. choose: ${Object.keys(MODEL_IDS).join(", ")}`);
        process.exit(1);
      }
      opts.model = v as ModelKey;
    } else if (a.startsWith("--extensions=")) {
      const v = a.slice("--extensions=".length);
      const parts = v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
      for (const p of parts) {
        if (!(OPTIONAL_EXTENSIONS as readonly string[]).includes(p)) {
          console.error(`unknown extension: ${p}. choose from: ${OPTIONAL_EXTENSIONS.join(", ")}`);
          process.exit(1);
        }
      }
      opts.extensions = parts;
    } else if (a.startsWith("--packages=")) {
      const v = a.slice("--packages=".length);
      const parts = v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
      for (const p of parts) {
        if (!PACKAGE_VALUES.includes(p as (typeof PACKAGE_VALUES)[number])) {
          console.error(`unknown package: ${p}. choose from: ${PACKAGE_VALUES.join(", ")}`);
          process.exit(1);
        }
      }
      opts.packages = parts;
    } else if (a.startsWith("--thinking=")) {
      // Defer scale validation to cmdCreate — it's the only place that
      // knows the chosen harness, and the scales differ by harness
      // (claude-code has auto/max, codex has neither, pi has adaptive).
      opts.thinking = a.slice("--thinking=".length);
    } else if (a.startsWith("--slack-channel=")) {
      const v = a.slice("--slack-channel=".length).trim();
      if (v && !CHANNEL_ID_PATTERNS.slack.test(v)) {
        console.error(`bad Slack channel ID: ${v} (expected ${CHANNEL_ID_PATTERNS.slack})`);
        process.exit(1);
      }
      opts.slackChannel = v;
    } else if (a.startsWith("--channels=")) {
      const v = a.slice("--channels=".length);
      const parts = v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
      for (const p of parts) {
        if (!(CHANNEL_VALUES as readonly string[]).includes(p)) {
          console.error(`unknown channel: ${p}. choose from: ${CHANNEL_VALUES.join(", ")}`);
          process.exit(1);
        }
      }
      opts.channels = parts as ChannelValue[];
    } else if (a.startsWith("--seed=")) {
      const v = a.slice("--seed=".length);
      if (v === "off" || v === "false" || v === "no") {
        opts.seedOff = true;
      } else {
        opts.seed = v;
      }
    } else if (a === "--no-pool") {
      opts.noPool = true;
    } else if (a === "--yes" || a === "-y") {
      opts.yes = true;
    } else if (a === "--dry-run" || a === "--plan") {
      opts.dryRun = true;
    } else if (a.startsWith("--project=")) {
      opts.project = a.slice("--project=".length).trim();
    } else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    } else {
      positionals.push(a);
    }
  }
  // The brief is the trailing positional that contains whitespace — names and
  // projects are single DNS tokens, so whitespace unambiguously marks the brief.
  // Strip it first, then disambiguate the remaining name/project positionals.
  if (positionals.length > 0 && /\s/.test(positionals[positionals.length - 1]!)) {
    opts.brief = positionals.pop()!.trim();
  }
  // Positional grammar on what remains:
  //   0 → auto-name (v1 fast-path);  1 → <name>;  2 → <project> <name>.
  let name: string | undefined;
  if (positionals.length === 1) {
    name = positionals[0];
  } else if (positionals.length === 2) {
    const project = positionals[0]!;
    if (!isValidCellName(project)) {
      console.error(`bad project '${project}' — ${describeCellNameRules()}`);
      process.exit(1);
    }
    // An explicit --project= flag pins and wins over the positional.
    if (!opts.project) opts.project = project;
    name = positionals[1];
  } else if (positionals.length > 2) {
    console.error(`too many arguments: ${positionals.join(" ")}\n  usage: cells birth [<project>] [<name>] ["brief"] [--flags]`);
    process.exit(1);
  }
  // Compile the brief into config hints + the seed purpose. Precedence: an
  // explicit --flag PINS (so ??= leaves it); otherwise the brief fills it;
  // otherwise cmdCreate's per-harness defaults fill it. The leftover purpose
  // becomes the cell's seed (its first message) unless --seed pinned one.
  if (opts.brief) {
    const c = compileBrief(opts.brief, briefVocab());
    if (c.harness !== undefined) opts.harness ??= c.harness;
    if (c.model !== undefined) opts.model ??= c.model as ModelKey;
    if (c.thinking !== undefined) opts.thinking ??= c.thinking;
    // Infer the harness from an Anthropic model when neither flags nor brief
    // pinned one: opus/sonnet/haiku only run on claude-code (the Max policy),
    // so the default "pi" would fail validation. This is the "mother infers
    // gaps" step, done deterministically Mac-side. Flags still win (??=).
    if (opts.harness === undefined && opts.model && MODEL_IDS[opts.model]?.provider === "anthropic") {
      opts.harness = "claude-code";
    }
    if (c.purpose && opts.seed === undefined && !opts.seedOff) opts.seed = c.purpose;
  }
  return { name, opts };
}

// Auto-name shape: `cell-` + 6 hex chars from 4 random bytes (~16M unique).
function generateCellName(): string {
  return `cell-${randomBytes(4).toString("hex").slice(0, 6)}`;
}

// Birth a cell: resolve config, claim a generic egg from the pool, hand
// [name, egg-well, config-blob] to mother — who follows the birthing ritual
// (docs/birthing-ritual.html). One linear path, no fast/slow split. Birth
// isn't a race; it's done when mother's end-test proves the cell works.
async function cmdCreate(name: string | undefined, opts: CreateOpts): Promise<void> {
  const t0 = Date.now();

  // ── 1. Resolve config ──
  // Interactive when given a name + a TTY + no config/scripting flags.
  // `cells birth` with no name births an auto-named default pi cell.
  const interactive =
    !!name && process.stdout.isTTY &&
    opts.harness === undefined && opts.model === undefined &&
    opts.thinking === undefined && opts.extensions === undefined &&
    opts.packages === undefined && opts.channels === undefined &&
    opts.slackChannel === undefined && opts.brief === undefined &&
    opts.seed === undefined && !opts.seedOff && !opts.noPool;

  let harness: string;
  let modelKey: ModelKey;
  let thinking: string;
  let extensions: string[];
  let packages: string[];
  let channels: ChannelValue[];

  if (interactive) {
    console.log(`\nbirthing cell '${name}'\n`);
    // Step machine so the user can ←/⌫ back to a previous prompt mid-flow.
    //   0 Harness · 1 Model · 2 Extensions · 3 Packages · 4 Thinking · 5 Channels
    // Extensions and Packages are pi-only concepts (.pi/extensions, npm
    // packages) — skipped, and left empty, for the coding-machine harnesses.
    // Every other step is always shown; the Model step renders even when the
    // harness pins a single model, so the user always sees what will run.
    const answers: (string | string[] | undefined)[] = [];
    const stepActive = (step: number, harnessSel: string): boolean =>
      (step === 2 || step === 3) ? harnessSel === "pi" : true;
    let i = 0;
    while (i < 6) {
      const harnessSel = (answers[0] as string | undefined) ?? "pi";
      // Skip pi-only steps for the coding-machine harnesses — record an
      // empty answer and move on without rendering anything.
      if (!stepActive(i, harnessSel)) {
        answers[i] = [];
        i++;
        continue;
      }
      const canGoBack = i > 0;
      let result: string | string[] | Back;
      if (i === 0) {
        result = await selectOne("Harness?", HARNESS_OPTIONS, {
          initialValue: answers[0] as string | undefined,
        });
      } else if (i === 1) {
        // pi → full chain picker; coding-machine harnesses → their single
        // pinned model. Always shown so the model is visible/confirmed.
        result = await selectOne("Model?", modelOptionsForHarness(harnessSel), {
          canGoBack,
          initialValue: answers[1] as string | undefined,
        });
      } else if (i === 2) {
        result = await selectMany("Extensions?", EXTENSION_OPTIONS, {
          canGoBack,
          initialChecked: answers[2] as string[] | undefined,
        });
      } else if (i === 3) {
        result = await selectMany("Packages?", PACKAGE_OPTIONS, {
          canGoBack,
          initialChecked: (answers[3] as string[] | undefined) ?? PACKAGE_DEFAULTS,
        });
      } else if (i === 4) {
        const modelSel = answers[1] as ModelKey;
        result = await selectOne(
          thinkingPromptFor(harnessSel),
          thinkingOptionsForHarness(harnessSel, modelSel),
          {
            canGoBack,
            initialValue:
              (answers[4] as string | undefined) ??
              defaultThinkingForHarness(harnessSel, modelSel),
          },
        );
      } else {
        result = await selectMany("Channels?", CHANNEL_OPTIONS, {
          canGoBack,
          initialChecked: answers[5] as string[] | undefined,
        });
      }
      if (result === BACK) {
        // selectOne/Many cleared its own menu; rewind one more line to wipe
        // the previous prompt's summary so it can be re-rendered fresh.
        process.stdout.write("\x1b[1A\x1b[2K");
        i--;
        // Step back over any skipped (pi-only) steps — they rendered
        // nothing, so they need no extra line wipe.
        while (i > 0 && !stepActive(i, harnessSel)) {
          answers[i] = undefined;
          i--;
        }
      } else {
        answers[i] = result;
        i++;
      }
    }
    harness = answers[0] as string;
    modelKey = answers[1] as ModelKey;
    extensions = answers[2] as string[];
    packages = answers[3] as string[];
    thinking = answers[4] as string;
    channels = (answers[5] as string[]).filter(
      (c) => (CHANNEL_VALUES as readonly string[]).includes(c),
    ) as ChannelValue[];
  } else {
    harness = opts.harness ?? "pi";
    // Per-harness default model: claude-code → Anthropic (opus); codex →
    // gpt-5.5 (ChatGPT sub); pi → gpt-5.5 (also ChatGPT sub, flat-cost).
    modelKey = opts.model ?? (
      harness === "claude-code" ? "opus" : "gpt-5.5"
    );
    thinking = opts.thinking ?? defaultThinkingFor(modelKey);
    extensions = opts.extensions ?? [];
    packages = opts.packages ?? PACKAGE_DEFAULTS;
    channels = opts.channels ?? (opts.slackChannel ? ["slack"] : []);
  }
  name = name ?? generateCellName();
  // Project cells are name-prefixed (<project>-<name>) so two projects can each
  // have an "abstractor" without colliding, and a fleet name self-documents its
  // project — same convention as <project>-mother. Idempotent if already
  // prefixed. Applies however the project was set (positional or --project=).
  if (opts.project) name = projectCellName(opts.project, name);

  // ── 2. Validate ──
  const nameCheck = validateCellName(name);
  if (!nameCheck.ok) {
    console.error(nameCheck.reason);
    process.exit(1);
  }
  if (RESERVED_NAMES.has(name)) {
    console.error(`'${name}' is reserved. Pick another name.`);
    process.exit(1);
  }
  // The `<project>-mother` namespace belongs to project mothers (special cells
  // born via `cells birth <project> mother`). Reserving it on the regular birth
  // path keeps the name a reliable mother marker: every `*-mother` cell is a
  // real mother, so the jobs-refusal + role checks can key off the name alone
  // and a non-mother cell can never accidentally claim a mother's identity.
  if (isMotherName(name)) {
    const proj = projectOfMother(name);
    console.error(`'${name}' is reserved for project mothers. To create it: cells birth ${proj} mother`);
    process.exit(1);
  }
  // Same reservation for the `*-pulse` namespace — every `*-pulse` cell is a
  // real pulse scheduler (born via `cells birth <project> pulse`), so the
  // ownership resolver (pulseOwner) can trust the name alone and a non-pulse
  // cell can never accidentally be picked as a project's scheduler.
  if (isPulseName(name)) {
    const proj = projectOfPulse(name);
    console.error(`'${name}' is reserved for project pulses. To create it: cells birth ${proj} pulse`);
    process.exit(1);
  }
  if (isNameTaken((await loadRegistry()).cells, name)) {
    console.error(`cell '${name}' already exists in registry`);
    process.exit(1);
  }
  if (harness !== "pi" && harness !== "claude-code" && harness !== "codex" && harness !== "hermes") {
    console.error(`unknown harness '${harness}' — choose: pi, claude-code, codex, hermes`);
    process.exit(1);
  }
  const isAnthropicModel = MODEL_IDS[modelKey].provider === "anthropic";
  if (harness === "claude-code" && !isAnthropicModel) {
    console.error(`the claude-code harness runs Anthropic models only (opus, sonnet, haiku)`);
    process.exit(1);
  }
  if (harness === "codex" && MODEL_IDS[modelKey].provider !== "openai-codex") {
    // The codex harness runs the `codex` CLI on the ChatGPT subscription
    // (via proxy.cells.md/codex). Only the openai-codex provider is the
    // subscription path — gpt-5.5-pro (provider "openai") is the metered
    // API, which the codex harness deliberately does not use.
    console.error(`the codex harness runs the ChatGPT-subscription model only — use --model=gpt-5.5`);
    process.exit(1);
  }
  if (harness === "hermes" && MODEL_IDS[modelKey].provider !== "openai-codex") {
    // The hermes harness runs Nous Research's hermes-agent on the ChatGPT
    // subscription (via proxy.cells.md/codex) — the same subscription path
    // codex uses. Only the openai-codex provider is that path.
    console.error(`the hermes harness runs the ChatGPT-subscription model only — use --model=gpt-5.5`);
    process.exit(1);
  }
  // The Claude Max sub is claude-code-harness-only (Pete, 2026-06-11):
  // Anthropic permits Max use through Claude Code; pi and hermes ride the
  // ChatGPT subscription (gpt-5.5 via openai-codex), which OpenAI permits.
  // The proxy enforces the same rule per-request (anthropicRouteVerdict in
  // cli/lib/proxy-oauth.ts) — this check just fails the birth early with a
  // usable message instead of a 403 at the cell's first call.
  if (harness === "pi" && isAnthropicModel) {
    console.error(
      `pi cells don't run Anthropic models — the Claude Max sub is claude-code-only.\n` +
      `  use --harness=claude-code for ${modelKey}, or --model=gpt-5.5 for pi`,
    );
    process.exit(1);
  }
  // Harness-aware thinking validation. The interactive Ink picker already
  // restricts choices via thinkingOptionsForHarness; this catches the
  // non-interactive `--thinking=X` path that bypassed the picker. Skip
  // when the user didn't pass --thinking (defaults are picked per harness
  // by defaultThinkingFor / defaultThinkingForHarness above).
  if (opts.thinking !== undefined) {
    const allowed = thinkingOptionsForHarness(harness, modelKey).map((o) => o.value);
    if (!allowed.includes(thinking)) {
      console.error(
        `thinking '${thinking}' is not valid for harness '${harness}' on ${modelKey}.\n` +
        `  choose: ${allowed.join(", ")}`,
      );
      process.exit(1);
    }
  }
  // 'adaptive' thinking is opus-only.
  if (thinking === "adaptive" && !ADAPTIVE_THINKING_MODELS.has(modelKey)) {
    console.error(`thinking 'adaptive' is only available for --model=opus`);
    process.exit(1);
  }
  // Some models reject low-effort thinking levels server-side. Auto-bump
  // rather than birth a cell that 400s on its first message.
  if (MIN_MEDIUM_THINKING_MODELS.has(modelKey) && SUB_MEDIUM_THINKING.has(thinking)) {
    console.warn(`note: ${modelKey} requires thinking ≥ medium; bumping '${thinking}' → 'medium'`);
    thinking = "medium";
  }
  if (opts.noPool) {
    console.warn(`note: --no-pool is deprecated and ignored — birth is pool-only now`);
  }

  // ── 3. Build the config blob handed to mother ──
  const choice = MODEL_IDS[modelKey];
  const chain = buildDefaultChain({ provider: choice.provider, modelId: choice.modelId, thinking }, harness);
  const blob = {
    harness,
    model: choice.modelId,
    provider: choice.provider,
    thinking,
    extensions,
    packages,
    channels,
    chain,
    // Runtime-DNA rev at birth time. bake-egg.sh re-overlays current DNA
    // onto the claimed egg, then stamps this onto /root/.dna-rev so a cell
    // born from a stale egg reads as CURRENT (the overlay made it current).
    // Computed Mac-side from the same working tree the overlay tars.
    dna_rev: dnaRev(DNA_DIR),
  };

  // Which mother owns this birth (project's own if registered + alive, else
  // global). Resolved here for the preview and reused at the birth line below.
  const owningMother = await motherFor(opts.project);

  // ── 3.5 Preview the resolved plan ──
  // A brief inferred config, so show exactly what will run and confirm before
  // spending an egg — the "trade speed for visibility" rule birth lives by.
  // --dry-run prints the plan and exits (no egg) regardless of TTY; otherwise
  // the confirm is shown only for a brief on a TTY, and --yes skips it.
  if (opts.dryRun || (opts.brief && !opts.yes && process.stdout.isTTY)) {
    const seedText = opts.seedOff ? "(none)" : (opts.seed ?? DEFAULT_SEED);
    console.log(`\nbirth plan for '${name}'${opts.project ? ` in project '${opts.project}'` : ""}:`);
    if (opts.project) console.log(`  mother:     ${owningMother}`);
    console.log(`  harness:    ${harness}`);
    console.log(`  model:      ${choice.modelId}  (${choice.provider}, thinking=${thinking})`);
    if (extensions.length) console.log(`  extensions: ${extensions.join(", ")}`);
    if (packages.length) console.log(`  packages:   ${packages.join(", ")}`);
    if (channels.length) console.log(`  channels:   ${channels.join(", ")}`);
    console.log(`  seed:       ${seedText}`);
    if (opts.dryRun) {
      console.log(`\n(dry run — no cell born)`);
      process.exit(0);
    }
    const ans = (await ask(`\nbirth ${name}? [Y/n] `)).toLowerCase();
    if (ans === "n" || ans === "no") {
      console.log("birth cancelled.");
      process.exit(0);
    }
  }

  // ── 4. Claim a generic egg from the pool ──
  if (!(await readSecret("CELLS_PROXY_SECRET"))) {
    console.error("CELLS_PROXY_SECRET missing from ~/.cells/secrets.json");
    process.exit(1);
  }
  // Lazy reconcile first — evict stale entries (welld bounced, pool.json
  // still says open) before we claim. Skip refill; we refill post-success.
  await reconcilePool({ silent: false, skipRefill: true }).catch(() => { /* don't fail birth on reconcile error */ });
  const claimAndReady = async () => {
    const c = await claimGenericEgg(name);
    if (!c) return null;
    try {
      await wakePoolMember(c.wellName, c.tier);
      await ensureWellHasIp(c.wellName);
      // Wait for SSH-ready before any post-wake SSH work. /wake returning
      // 200 only means "VZ restore complete," not "guest reachable" — the
      // guest's networking stack can take 1-5s more to fully come up.
      // Without this poll, stripAnthropicKeyFromWell below races that
      // window on roughly 1-in-many wakes and birth fails with "no route
      // to host" on the freshly-allocated IP. Bake-validate uses the
      // same helper so the symmetry is intentional.
      await waitForSshReady(c.wellName);
      // No harness uses a direct paid Anthropic key anymore — claude-code and
      // pi both reach Anthropic through proxy.cells.md (Max sub); codex/hermes
      // run the ChatGPT sub. Strip the latent key off every cell.
      await stripAnthropicKeyFromWell(c.wellName);
      return c;
    } catch (e) {
      console.error(
        `! egg ${c.wellName} couldn't be readied: ${e instanceof Error ? e.message : String(e)}`,
      );
      await directWellDestroy(c.wellName).catch(() => {});
      await withPoolLock(async () => {
        const file = await loadPool();
        file.members = file.members.filter((m) => m.well_name !== c.wellName);
        await savePool(file);
      });
      return null;
    }
  };
  let claim = await claimAndReady();
  if (!claim) {
    // Kick the refill before refusing — a drought should start fixing
    // itself the moment it's observed, not wait for the steward's next
    // pass. Detached so this process still exits promptly; the retry a
    // couple of minutes later lands on a fresh egg. (Scale test
    // 2026-06-11: 5 births drained the pool in 160s and the 6th failed
    // with no refill in flight.)
    if (!(await isRefillInFlight())) {
      const log = join(homedir(), ".cells/logs/pool-refill.log");
      await mkdir(dirname(log), { recursive: true }).catch(() => {});
      Bun.spawn(["bun", join(REPO_ROOT, "cli/cells.ts"), "pool", "refill"], {
        stdin: "ignore",
        stdout: openSync(log, "a"),
        stderr: openSync(log, "a"),
      }).unref();
      console.error(`  (pool refill started in the background — retry in ~2 minutes)`);
    }
    console.error(
      `birth failed: the egg pool is empty (or no egg could be readied).\n` +
      `  cells pool refill          # bake more pool members\n` +
      `  cells pool reconcile       # re-sync pool.json with welld`,
    );
    process.exit(1);
  }
  let eggWell = claim.wellName;
  const sweepEgg = async (well: string) => {
    await directWellDestroy(well).catch(() => {});
    await withPoolLock(async () => {
      const file = await loadPool();
      file.members = file.members.filter((m) => m.well_name !== well);
      await savePool(file);
    });
  };

  // ── 4.5 Pre-register the cell as "warming" BEFORE the handoff ──
  // Mother's end-test (ritual step 2) fires the cell's first Anthropic call
  // through the proxy, whose Max-policy gate (anthropicRouteVerdict) 403s any
  // cell it can't find in the registry. Registration is the gate's allowlist
  // (name + harness) — distinct from "proven alive" (the status, set on
  // success below). Without this the end-test of a fresh claude-code cell
  // always 403'd. Rolled back on every failure path.
  const warmingEntry = {
    name,
    created_at: new Date().toISOString(),
    hatched_from: claim.id,
    modelChain: chain,
    harness,
    ...(opts.project ? { project: opts.project } : {}),
  };
  // One locked read-modify-write: reap any warming orphans from a hard-crashed
  // prior birth, then register this cell. withRegistryLock keeps a concurrent
  // operator write (cells model/kill/...) from clobbering the warming entry.
  // The egg is already claimed + booted + SSH-ready by here, so a registry-lock
  // failure must SWEEP it, not strand a running VM with no registry entry
  // (reconcile never reclaims a "claimed" pool member that welld still knows).
  try {
    await mutateRegistry((cells) => upsertBirthingCell(cullStaleWarming(cells, Date.now()), warmingEntry));
  } catch (e) {
    console.error(`birth failed: could not register ${name} (${e instanceof Error ? e.message : String(e)}) — sweeping egg ${eggWell}`);
    await sweepEgg(eggWell).catch(() => {});
    process.exit(1);
  }
  const rollbackRegistration = async () => {
    try {
      await mutateRegistry((cells) => removeCell(cells, name));
    } catch { /* best-effort — a leaked "warming" entry is non-authoritative */ }
  };
  // Failure cleanup (caller follows with process.exit(1) so TS narrows the
  // outcome guards via the never-returning exit). Order matters: roll the
  // warming entry back FIRST (critical — a leaked "warming" entry causes
  // phantom cells / a 403 on the next birth of the same name), THEN reclaim
  // the egg as best-effort, so a pool-lock/disk error inside sweepEgg can
  // never strand the warming entry. Reads eggWell at call-time (a retry may
  // have reassigned it).
  const cleanupFailedBirth = async () => {
    await rollbackRegistration();
    await sweepEgg(eggWell).catch((e) =>
      console.warn(`note: egg sweep failed (reconcile will reclaim): ${e instanceof Error ? e.message : String(e)}`),
    );
  };

  // ── 5. Hand off to mother — she reads docs/birthing-ritual.html ──
  // Mother's registry modelChain encodes harness selection (mother is the
  // only cell with this today). Each entry is "<harness>:<provider>/<model>:<thinking>"
  // or, for legacy single-harness specials, "<provider>/<model>:<thinking>"
  // (treated as pi). The orchestrator walks the chain: try harness #1,
  // and on a pre-flight failure (no outcome written) sweep + reclaim a
  // fresh egg and try the next. An outcome with success=false is the
  // ritual's own verdict — accepted as-is, no fallover.
  //
  // Legacy gate CELLS_USE_MOTHER_CELL=1 still routes through cells-mother
  // via talkAndAwaitOutcome; that path is single-harness (pi on her well)
  // and bypasses the chain for now.
  // owningMother (resolved above for the preview) attributes the birth: the
  // project's own mother if registered, else the global mother. Stage 2 keeps
  // the ritual itself the shared MOTHER_ROOT skill on Pete's one Max session
  // (the birth-ritual lock serializes it globally — project mothers are
  // isolation/ownership, NOT parallel births).
  if (!process.stdout.isTTY) {
    console.log(owningMother === "mother" ? `birthing ${name}…` : `birthing ${name} (${owningMother})…`);
  }
  const useMotherCell = process.env.CELLS_USE_MOTHER_CELL === "1";
  const motherChain = await readMotherHarnessChain();

  // Birth-log surface for mother.cells.md. talkAndAwaitOutcome writes its
  // own entries; the legacy Mac-side path didn't, so mother.cells.md was
  // missing all default-flow births. Write start + end records here too.
  const birthId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const birthStartedAt = Date.now();
  const birthLogFile = join(BIRTH_LOG_DIR, `${birthId}.json`);
  const writeBirthLog = async (
    motherHarness: string | null,
    finalOutcome?: Outcome | null,
  ) => {
    try {
      await mkdir(BIRTH_LOG_DIR, { recursive: true });
      const record: any = {
        birthId,
        name,
        harness: blob.harness,
        model: blob.model,
        mother_harness: motherHarness,
        started_at: new Date(birthStartedAt).toISOString(),
      };
      if (finalOutcome !== undefined) {
        const endedAt = Date.now();
        record.ended_at = new Date(endedAt).toISOString();
        record.elapsed_ms = endedAt - birthStartedAt;
        record.success = finalOutcome?.success ?? false;
        record.message = finalOutcome?.message ?? "no outcome (timeout or mother crash)";
      }
      await writeFile(birthLogFile, JSON.stringify(record, null, 2));
    } catch { /* log surface is best-effort */ }
  };

  let outcome: Outcome | null = null;
  let usedMotherHarness: string | null = null;
  if (useMotherCell) {
    // talkAndAwaitOutcome handles its own birth-log entry. A throw here (the
    // legacy mother-cell path can fail mid-talk) must NOT leak the warming
    // entry — treat it as a no-outcome attempt so the !outcome handler rolls
    // the warming entry back.
    try {
      const r = await talkAndAwaitOutcome("cell-create", [name, eggWell, JSON.stringify(blob)], { progressName: name });
      outcome = r.outcome;
    } catch (e) {
      console.warn(`! mother-cell birth threw: ${e instanceof Error ? e.message : String(e)}`);
      outcome = null;
    }
  } else {
    for (let attempt = 0; attempt < motherChain.length; attempt++) {
      const { harness: motherHarness } = parseChainEntry(motherChain[attempt]!);
      const which = motherHarness ?? "pi";
      if (attempt > 0) {
        console.warn(`! retrying birth with mother harness '${which}' (fresh egg)`);
        let fresh: Awaited<ReturnType<typeof claimAndReady>> = null;
        try {
          await sweepEgg(eggWell);
          fresh = await claimAndReady();
        } catch (e) {
          // sweepEgg/claimAndReady can throw on a pool-lock/disk error — don't
          // let that leak the warming entry; fall into the !fresh rollback.
          console.error(`birth failed: retry egg prep threw: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!fresh) {
          console.error(`birth failed: could not claim a fresh egg for retry`);
          await writeBirthLog(which, null);
          await rollbackRegistration();
          process.exit(1);
        }
        claim = fresh;
        eggWell = fresh.wellName;
      }
      usedMotherHarness = which;
      await writeBirthLog(which);  // start record (refreshed per attempt)
      // claude-code mother uses /birth (her skill name); pi mother uses
      // /cell-create (her existing prompt name). Same args either way.
      let r: Awaited<ReturnType<typeof runClaudeWithOutcome>>;
      try {
        r = which === "claude-code"
          ? await runClaudeWithOutcome(
              "birth",
              [name, eggWell, JSON.stringify(blob)],
              wellsEnv(),
              { progressName: name },
            )
          : await runPiWithOutcome(
              "cell-create",
              [name, eggWell, JSON.stringify(blob)],
              wellsEnv(),
              { progressName: name },
            );
      } catch (e) {
        // A throw here (e.g. Bun.spawn when the harness binary isn't on PATH)
        // must NOT leak the pre-registered "warming" entry — treat it as a
        // no-outcome attempt so the chain falls over and, if none succeed, the
        // !outcome handler below rolls the warming entry back.
        console.warn(`! mother harness '${which}' threw: ${e instanceof Error ? e.message : String(e)}`);
        r = { outcome: null, exit: -1 };
      }
      if (r.outcome) {
        outcome = r.outcome;
        break;
      }
      // No outcome = pre-flight failure (auth, empty stream, etc.). Try
      // the next harness in mother's chain. If none left, fall through to
      // the null-outcome handler below.
      console.warn(`! mother harness '${which}' returned no outcome (exit ${r.exit})`);
    }
    await writeBirthLog(usedMotherHarness, outcome);
  }
  if (!outcome) {
    console.error(`birth failed: mother did not report an outcome — sweeping egg ${eggWell}`);
    await cleanupFailedBirth();
    process.exit(1);
  }
  if (!outcome.success) {
    console.error(`birth failed: ${outcome.message} — sweeping egg ${eggWell}`);
    await cleanupFailedBirth();
    process.exit(1);
  }

  // Guarantee the cell can hibernate before we register it as alive — no
  // cell reaches the registry that the hibernation system can't manage
  // (hibernation model, invariant 4).
  try {
    await ensureHibernateReady(eggWell);
  } catch (e) {
    console.error(
      `birth failed: '${name}' not hibernate-ready (${e instanceof Error ? e.message : String(e)}) — sweeping egg ${eggWell}`,
    );
    await cleanupFailedBirth();
    process.exit(1);
  }

  // ── 6. Success: promote the warming entry to alive (authoritative) ──
  // Promote BEFORE the pool bookkeeping below so a markPoolMemberLive failure
  // can't strand a proven-alive cell as "warming". A throw here (the promote
  // never persisted → the cell isn't authoritatively alive yet) rolls the
  // warming entry back; once promoted, no later step ever un-registers it.
  try {
    await mutateRegistry((cells) => {
      // hatched_from + modelChain are patched in case a retry swept the original
      // egg and re-claimed a fresh one. If the warming entry somehow vanished,
      // re-insert so a successful birth always lands a registered, alive cell.
      let next = promoteCell(cells, name, { hatched_from: claim.id, modelChain: chain });
      if (!findCellIn(next, name)) {
        next = [...next, {
          name,
          created_at: new Date().toISOString(),
          status: "alive" as const,
          hatched_from: claim.id,
          modelChain: chain,
          harness,
          ...(opts.project ? { project: opts.project } : {}),
        }];
      }
      return next;
    });
  } catch (e) {
    await rollbackRegistration();
    throw e;
  }

  // Pool bookkeeping is best-effort AFTER the promote — the cell is already a
  // live, registered VM, so a pool.json error must not crash or unregister it
  // (reconcile reconciles pool↔registry).
  await markPoolMemberLive(eggWell).catch((e) =>
    console.warn(`note: pool bookkeeping for ${name} failed (reconcile will fix): ${e instanceof Error ? e.message : String(e)}`),
  );

  // Kick host-bridge to spawn ssh+pi now so the first talk connects warm.
  void prewarmHostBridge(name);

  // Perf telemetry — alive_ms = birth complete (cell registered, ready).
  try {
    const perfDir = join(homedir(), ".cells", "logs", "perf");
    await mkdir(perfDir, { recursive: true });
    await writeFile(
      join(perfDir, "birth.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), cell: name, path: "pool", alive_ms: Date.now() - t0 }) + "\n",
      { flag: "a" },
    );
  } catch { /* telemetry non-critical */ }

  // Fire-and-forget: top the pool back up (this birth just claimed an
  // egg), sync the new cell into the vault. This is the ONLY routine
  // refill trigger — there is no background refiller. refillPoolToDepth
  // bakes until the pool is back at V1_POOL_TARGET_DEPTH, so one birth
  // bakes one egg; reconcile's cull pass catches any overshoot from
  // concurrent births.
  refillPoolToDepth().catch((e) =>
    console.warn(`! pool top-up failed: ${e instanceof Error ? e.message : String(e)}`),
  );
  void cmdSync(name).catch((e) => console.error(`! initial vault sync failed: ${e}`));

  // ── Talk UX ──
  const seedText = opts.seedOff ? undefined : (opts.seed ?? DEFAULT_SEED);
  if (!process.stdout.isTTY) {
    // Scripted birth: cell is alive + registered. Exit explicitly so the
    // bun process doesn't hang on the background refill/sync promises.
    console.log(`✓ ${name} alive`);
    process.exit(0);
  }
  if (!seedText) {
    console.log(`✓ ${name} alive`);
    await cmdTalk(name, []);
    return;
  }
  // Seed greeting: a short snap-to-alive animation plays while the seed's
  // LLM round-trip happens, then the captured greeting prints and we drop
  // into the interactive talk session on the same pi session.
  const firstTokenDef = makeDeferred<void>();
  const animPromise = (await import("./birth-ui.tsx")).runBirthAnimation({
    endSignal: firstTokenDef.promise,
    minDurationMs: 1500,
    maxDurationMs: 6000,
  });
  let greetingHandle: GreetingHandle | null = null;
  try {
    greetingHandle = await captureGreeting(name, seedText);
    greetingHandle.firstTokenSeen
      .then(() => firstTokenDef.resolve())
      .catch(() => { /* fallback handled below */ });
  } catch (e) {
    console.warn(
      `! pre-send greeting failed: ${e instanceof Error ? e.message : String(e)}; falling back to in-session seed`,
    );
    greetingHandle = null;
    firstTokenDef.resolve(); // don't make the animation wait on a dead handle
  }
  await animPromise;
  if (greetingHandle) {
    greetingHandle.release();
    try {
      await greetingHandle.done;
    } catch (e) {
      console.warn(`! greeting interrupted: ${e instanceof Error ? e.message : String(e)}`);
    }
    await streamCellBridge(name, { interactive: true });
  } else {
    await streamCellBridge(name, { interactive: true, initialMessage: seedText });
  }
}

// Fork a well directly via welld API, bypassing the mother agent. Used
// by the v1 fast-path (cmdCreateV1Fast) to skip the LLM-routed birth
// skill. Throws on failure — caller is responsible for cleanup via
// directWellDestroy.
async function directWellCreate(
  name: string,
  opts: { fromImage: string; env?: Record<string, string> },
): Promise<void> {
  const body: Record<string, unknown> = {
    name,
    from_image: opts.fromImage,
  };
  if (opts.env && Object.keys(opts.env).length > 0) {
    body.env = opts.env;
  }
  // Note: pre-Piece-3 (2026-05-12) we passed hibernate_ready: true here to
  // trigger inline warming. Pi3 (2026-05-13) deleted that path — wells's
  // createWell no longer accepts the field. Use sealWell() after
  // provisioning instead to flip the well hibernate-legal.
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  const r = await fetch(`${base}/v1/wells`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await wellsToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(
      `direct well create '${name}' failed: ${r.status} ${(await r.text()).slice(0, 300)}`,
    );
  }
}

// Flip the well's vhost auth mode to "public" — required so the local
// welld proxy passes WS traffic through to the cell's own /agent server,
// which validates CELLS_PROXY_SECRET itself. Wells defaults new wells to
// "well" auth (requires WELL_TOKEN at the proxy).
async function setWellAuthPublic(wellName: string): Promise<void> {
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  const r = await fetch(
    `${base}/v1/wells/${encodeURIComponent(wellName)}/url`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${await wellsToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ auth: "public" }),
    },
  );
  if (!r.ok) {
    throw new Error(
      `set auth=public for '${wellName}' failed: ${r.status} ${(await r.text()).slice(0, 300)}`,
    );
  }
}

// PATCH a well's auto-sleep override.
//   value=null   → never auto-hibernate ("pinned awake"). Used during bake
//                  (race protection: the watchdog can sleep a well mid-
//                  provision; applyToGuest's `sudo tee` truncates and
//                  hibernate mid-script leaves zero-byte unit files) and
//                  for cells the operator explicitly pins.
//   value=number → per-well override of welld's default (60s). Used at
//                  hatch time to undo the bake-time pin — the wake-
//                  regression that motivated the original blanket null
//                  (see wells/NEEDS_PETE.md, 2026-04-late) was fixed; the
//                  mitigation was supposed to be dropped. Setting 60
//                  matches welld's current default; if welld bumps the
//                  default we accept this override pins us to the old
//                  value (acceptable footgun, noted in JOURNAL).
const DEFAULT_AUTO_SLEEP_SECONDS = 60;
async function setAutoSleep(wellName: string, value: number | null): Promise<void> {
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  const r = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${await wellsToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ auto_sleep_seconds: value }),
  });
  if (!r.ok) {
    console.warn(
      `! setAutoSleep '${wellName}' (${value === null ? "null/pin" : value + "s"}) failed: ${r.status} ${(await r.text()).slice(0, 200)}`,
    );
  }
}
// Back-compat aliases — call sites read more cleanly.
async function disableAutoSleep(wellName: string): Promise<void> { return setAutoSleep(wellName, null); }
async function resetAutoSleepToDefault(wellName: string): Promise<void> { return setAutoSleep(wellName, DEFAULT_AUTO_SLEEP_SECONDS); }

// Take a freshly-provisioned well to a hibernate-legal disk-only steady
// state. Post-Piece-3 (2026-05-13), wells's createWell no longer does the
// warming sequence inline; cells calls /seal explicitly after provisioning
// to flip runtime.hibernate_ready and detach cidata. Without this, the
// /hibernate gate refuses the well.
//
// Sequence wells's /seal handles internally (mirrors the deleted warming):
//   1. Stop the well (graceful halt)
//   2. Restart without cidata (disk-only mount)
//   3. Wait for SSH-ready
//   4. Flip runtime.hibernate_ready = true
//
// Returns ~6-8s typical (per pre-Pi3 warming cost). Throws if welld's
// /seal endpoint isn't available — that means the wells side is older
// than the cells side and someone needs to bounce welld.
async function sealWell(wellName: string): Promise<void> {
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  const r = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}/seal`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await wellsToken()}` },
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 400);
    throw new Error(`seal '${wellName}' failed: ${r.status} ${body}`);
  }
}

// Birth guarantees a hibernate-ready cell (hibernation model, invariant 4 —
// docs/proposals/hibernation-model.html). bakePoolMember seals every egg, but
// an egg can rot in the pool between bake and claim: a welld transition storm
// cleared hibernate_ready on egg-0f7d66 while it waited. So re-verify at claim.
// If welld reports the well hibernate-ready, done. Otherwise — or if welld is
// too old to report the field at all — seal now. sealWell throws on failure;
// the caller sweeps the egg and fails the birth rather than registering a cell
// the hibernation system can never manage.
// Read welld's hibernate_ready bit for a well. Returns undefined if welld
// is unreachable or too old to expose the field; callers pair with
// needsSeal() to map undefined → "seal anyway, strictly safe direction."
async function readHibernateReady(wellName: string): Promise<boolean | undefined> {
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  try {
    const r = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}`, {
      headers: { Authorization: `Bearer ${await wellsToken()}` },
    });
    if (r.ok) return (await r.json() as { hibernate_ready?: boolean }).hibernate_ready;
  } catch { /* unreachable welld → undefined → caller decides */ }
  return undefined;
}

async function ensureHibernateReady(wellName: string): Promise<void> {
  const ready = await readHibernateReady(wellName);
  if (!needsSeal(ready)) return;         // already sealed — nothing to do
  await sealWell(wellName);              // false (pool rot) or undefined (old welld)
}

// Register the `site` systemd service on a cell via welld's services API.
// Triggers /root/site/server.ts (bun web server) to start at boot. Mirrors
// scripts/register-site-service.sh in TS so the v1 fast-path doesn't shell
// out. Wells's services API hardcodes User=ubuntu (W.28) and ubuntu has
// NOPASSWD sudo per the wells base; sudoing to root makes the service run
// with full filesystem access. HOME=/root so server.ts sees its DNA.
async function registerSiteService(wellName: string, cellName: string): Promise<void> {
  const inner =
    `cd /root/site && . /etc/profile.d/cells-env.sh; ` +
    `export HOME=/root PATH="/root/.bun/bin:$PATH"; ` +
    `export CELL_NAME='${cellName}'; export PORT=8080; ` +
    `exec bun run server.ts`;
  // Escape single quotes for the outer `sudo bash -c '...'` wrap.
  const quotedInner = `'${inner.replace(/'/g, `'\\''`)}'`;
  const script = `sudo bash -c ${quotedInner}`;
  const payload = { cmd: "bash", args: ["-lc", script], workdir: "/root" };

  const token = await wellsToken();
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";

  // DELETE first — wells's PUT no-ops on an existing service, leaving stale
  // config in place. DELETE is idempotent (404 → fine).
  await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}/services/site`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});

  const r = await fetch(
    `${base}/v1/wells/${encodeURIComponent(wellName)}/services/site`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!r.ok) {
    throw new Error(
      `register site service for '${wellName}' failed: ${r.status} ${(await r.text()).slice(0, 300)}`,
    );
  }
}

// v1 egg pool helpers. The v1 pool is uniform — every egg is the same
// V1_POOL_VARIANT_SIGNATURE is now canonical in ./lib/pool — imported above.

// Generate a fresh egg well-name. Distinct from cell-names (cell-<hex>) so
// `cells list` doesn't pretend pool wells are user-facing cells.
function generatePoolWellName(): string {
  return `egg-${randomBytes(4).toString("hex").slice(0, 6)}`;
}

// Bake one v1 egg: fork cell-base, set auth=public, hibernate. Inserts an
// entry into pool.json with state=open on success. Returns the well-name
// or throws. Caller is responsible for the egg-lock dance (use
// withPoolLock around the bake invocation when refilling).
// Read all LLM provider keys from ~/.cells/secrets.json so every egg/root
// has every supported model available out of the box. Pi-ai natively reads
// these env vars for direct-API providers; CELLS_PROXY_SECRET is used by
// the codex-proxy extension for subscription-routed providers (codex,
// anthropic). Missing keys are silently skipped — model fallback handles it.
async function collectCellLlmEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const keys = [
    "CELLS_PROXY_SECRET",   // the cell's bearer for everything on the subs proxy:
                            // anthropic-on-Max (pi + claude-code, via ANTHROPIC_OAUTH_TOKEN)
                            // and openai-codex/gpt-5.5 (via proxy.cells.md/codex)
    // ANTHROPIC_API_KEY deliberately NOT baked: no harness uses a direct paid
    // Anthropic key anymore (pi + claude-code both ride the Max sub via the
    // proxy). Leaving it out keeps the paid credential off every pool egg for
    // its whole lifetime; stripAnthropicKeyFromWell is the belt-and-suspenders
    // sweep for any older egg that still carries it.
    "OPENAI_API_KEY",       // openai/* non-codex (direct)
    "GEMINI_API_KEY",       // google/gemini-* (direct)
    "EXA_API_KEY",          // web_search tool
  ];
  for (const k of keys) {
    const v = await readSecret(k);
    if (v) env[k] = v;
  }
  return env;
}

// "Running" pool target — how many open pool members are kept
// running-resident (RAM/CPU/process all live) instead of hibernated.
// With V1's pure-running pool we kept this at POOL_TARGET_DEPTH so every
// egg stayed up; the trade was zero wake latency at the cost of ~1GB RAM
// + 4 vCPU per egg.
//
// Measured 2026-05-15 on the v1 substrate (welld 1.0.0, admission control
// live, sealed+hibernated eggs): /hibernate completes in 0.60s, /wake
// returns SSH-ready in 0.55s. The old "wake takes ~2-3s" comment that
// motivated a running buffer was wildly conservative — half-second wake
// is invisible against a multi-second birth ritual. The "kills lume /
// clips every sibling VM" hazard cited for the running-only pool is also
// gone: it described pre-Pi3 hibernate, before /seal made the state legal
// and wells's boot-admission gate (WELL_MAX_CONCURRENT_BOOTS) paced wakes.
//
// So V1 now ships pure-hibernated: target = 0. Every pool egg is
// hibernated; claim falls through to a tier-2 egg, the birth flow /wake's
// it (~0.5s), mother runs the ritual on the already-SSH-ready VM. The
// running bake path and hibernated→running promote in refillPoolToDepth
// Pass 1 are kept dormant (target 0 makes both no-ops) so V2's variant
// pool can re-enable running eggs for latency-sensitive variants without
// re-introducing the code.
//
// Schema note: pool.json still carries `tier: 2 | 4`. tier 4 = running,
// tier 2 = hibernated. Power state is derived from tier; the numeric
// field is frozen.
//
// V1_RUNNING_POOL_TARGET is now canonical in ./lib/pool — imported above.

// Count running members currently in the pool. Used to decide whether
// the next bake should produce a running egg or a hibernated one, and
// whether to promote a hibernated→running egg on refill.
async function countRunningPoolMembers(): Promise<number> {
  const file = await loadPool();
  return file.members.filter(
    (e) =>
      e.state === "open" &&
      e.variant_signature === V1_POOL_VARIANT_SIGNATURE &&
      (e as any).tier === 4,
  ).length;
}

// Count hibernated members in the pool. Used for promote balancing.
async function countHibernatedPoolMembers(): Promise<number> {
  const file = await loadPool();
  return file.members.filter(
    (e) =>
      e.state === "open" &&
      e.variant_signature === V1_POOL_VARIANT_SIGNATURE &&
      (e as any).tier === 2,
  ).length;
}

// Provision a fresh ubuntu-base well into a fully-formed cell, in-place
// via SSH. Used by bakePoolMember (per-egg path) and reusable for any "turn
// this raw well into a cell" need. Replaces the old cell-base layered
// image — see docs/proposals/image-ownership.html for the rationale.
//
// As of wells-stable-2026-05-12h, ubuntu-base ships with:
//   - bun pre-installed at /usr/local/bin/bun
//   - cell user + /cell home + cell sudoers (vestigial, unused since the
//     root migration — agent runs as root, HOME=/root, DNA at /root)
//   - ubuntu user with NOPASSWD sudo (host-bridge sshes as ubuntu, sudoes
//     to root)
//   - /home/well/.ssh wells-managed key
// So cells-side provisioning is purely cells-shaped layers.
//
// Steps:
//   1. Push dna/cells/base → /root (DNA)
//   2. Write per-cell tmux config template
//   3. bun install /root deps (--ignore-scripts so postinstall doesn't run
//      before pi is installed and patchable)
//   4. npm install pi-coding-agent globally + pre-load pi-web-access ext
//   5. sudo apply-pi-patches.sh (anthropic baseUrl, codex, adaptive)
//   6. /etc/profile.d/cells-env.sh
//   7. chmod +x /root/bin/cells
//   8. sync filesystem
async function provisionCellInWell(wellName: string): Promise<void> {
  // 1. DNA push (ubuntu-base already has /root — the cell user it ships
  //    is left unused; the agent now runs as root, so /root is chowned
  //    root:root in step 8 below for ownership consistency).
  await pushLocalDirToWell(wellName, DNA_DIR, "/root");
  // 3. tmux conf template
  const tmuxConf = await readFile(join(REPO_ROOT, "scripts/cell-tmux.conf"), "utf-8");
  const writeTmux = await wellExecCapture(
    wellName,
    `sudo tee /root/.tmux.conf >/dev/null <<'__TMUX_EOF__'\n${tmuxConf}\n__TMUX_EOF__`,
  );
  if (!writeTmux.ok) {
    throw new Error(`write tmux conf failed: ${writeTmux.stderr.slice(0, 200)}`);
  }
  // 4. bun install /root deps. --ignore-scripts so the postinstall hook
  //    (apply-pi-patches.sh, which writes into /usr/lib/node_modules) doesn't
  //    fire before patches are applied in step 6. Bun is pre-installed in
  //    ubuntu-base since wells-stable-2026-05-12f (at /usr/local/bin/bun
  //    on the system PATH for every user).
  const bunInstall = await wellExecCapture(
    wellName,
    `set -euo pipefail
sudo bash -lc 'cd /root && bun install --frozen-lockfile --ignore-scripts'
echo "bun: $(bun --version 2>&1 | head -1 || echo MISSING)"`,
  );
  if (!bunInstall.ok) {
    throw new Error(`bun install failed: ${(bunInstall.stderr + bunInstall.stdout).slice(-600)}`);
  }
  // 5. Install pi globally (root-owned at /usr/lib/node_modules), then
  //    pre-load the default pi extension so birth's step 3e is a no-op.
  //    All as root — the agent runs as root so its npm globals also live
  //    root-owned, which means pi/claude/codex auto-updaters can write
  //    /usr/lib/node_modules cleanly later.
  const piInstall = await wellExecCapture(
    wellName,
    `set -euo pipefail
sudo npm install -g @mariozechner/pi-coding-agent
sudo bash -lc 'export HOME=/root; cd /root && pi install -l npm:pi-web-access'
echo "pi: $(sudo bash -lc 'export HOME=/root; pi --version' 2>&1 | head -1 || echo MISSING)"`,
  );
  if (!piInstall.ok) {
    throw new Error(`pi install failed: ${(piInstall.stderr + piInstall.stdout).slice(-600)}`);
  }
  // 5b. codex harness bake — install the `codex` CLI so every generic egg
  //     ships the codex harness alongside pi. (claude-code's `claude` CLI
  //     ships in the wells base image; codex does not, so cells bakes it.)
  //     Pinned: codex's `exec --json` event format moves fast — pin to the
  //     version the harness was built + verified against.
  const codexInstall = await wellExecCapture(
    wellName,
    `set -euo pipefail
sudo npm install -g @openai/codex@0.130.0
echo "codex: $(sudo bash -lc 'export HOME=/root; codex --version' 2>&1 | head -1 || echo MISSING)"`,
  );
  if (!codexInstall.ok) {
    throw new Error(`codex install failed: ${(codexInstall.stderr + codexInstall.stdout).slice(-600)}`);
  }
  // 5c. hermes harness bake — install Nous Research's hermes-agent so every
  //     generic egg ships the hermes harness alongside pi/claude/codex.
  //     hermes isn't in the wells base image; cells bakes it with Nous's own
  //     installer (uv-based). --skip-setup skips the interactive wizard,
  //     --skip-browser skips the Playwright/Chromium download. Pinned to a
  //     release tag — hermes's TUI-gateway JSON-RPC protocol moves fast, so
  //     pin to the version the harness was built + verified against.
  const hermesInstall = await wellExecCapture(
    wellName,
    `set -euo pipefail
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/v2026.5.16/scripts/install.sh | sudo bash -s -- --skip-setup --skip-browser --branch v2026.5.16
echo "hermes: $(sudo bash -lc 'export HOME=/root; hermes --version' 2>&1 | head -1 || echo MISSING)"`,
  );
  if (!hermesInstall.ok) {
    throw new Error(`hermes install failed: ${(hermesInstall.stderr + hermesInstall.stdout).slice(-600)}`);
  }
  // 6. Apply pi patches with sudo (writes into /usr/lib/node_modules).
  const patch = await wellExecCapture(wellName, `sudo bash /root/scripts/apply-pi-patches.sh`);
  if (!patch.ok) {
    throw new Error(`apply-pi-patches failed: ${(patch.stderr + patch.stdout).slice(-600)}`);
  }
  // 7. /etc/profile.d shim
  await bakeWriteProfileD(wellName);
  // 8. chmod /root/bin/cells
  const chmod = await wellExecCapture(wellName, `sudo chmod +x /root/bin/cells`);
  if (!chmod.ok) {
    throw new Error(`chmod /root/bin/cells failed: ${chmod.stderr.slice(0, 200)}`);
  }
  // 8b. Normalize ownership. /root is root:root by default, but the DNA
  //     tar push preserves the host Mac's uid/gid (e.g. 501:staff) on
  //     archive entries, and bun/pi/codex installs land mixed too. The
  //     agent runs as root and can read anything regardless, but a
  //     chown -R keeps `ls` honest. Cheap.
  const chownAll = await wellExecCapture(wellName, `sudo chown -R root:root /root`);
  if (!chownAll.ok) {
    throw new Error(`chown -R root:root /root failed: ${chownAll.stderr.slice(0, 200)}`);
  }
  // 8c. Stamp the runtime-DNA rev this overlay landed at (cli/lib/dna-rev.ts).
  //     pushLocalDirToWell above just copied DNA_DIR; the rev fingerprints
  //     the same tree, so this records exactly what's on disk. The doctor
  //     compares it against the repo's current rev; reconcile culls stale
  //     open eggs; the steward refreshes stale running cells. Best-effort:
  //     a `cells doctor`/steward degrades to "unknown" on a missing stamp,
  //     so don't let an echo failure tank a bake against Pete's 100% bar.
  const dnaStamp = await wellExecCapture(
    wellName,
    `echo ${dnaRev(DNA_DIR)} | sudo tee /root/.dna-rev > /dev/null`,
  );
  if (!dnaStamp.ok) {
    console.warn(`  ! dna-rev stamp didn't land (best-effort): ${dnaStamp.stderr.slice(0, 160)}`);
  }
  // 9. sync — empirically needed so hibernate's stop+save doesn't lose
  // /root content / sudoers / pi-patched node_modules (ext4 commit=30
  // can lag behind the disk-detach).
  const sync = await wellExecCapture(wellName, `sudo sync && sudo sync`);
  if (!sync.ok) {
    throw new Error(`sync failed: ${sync.stderr.slice(0, 200)}`);
  }
}

async function bakePoolMember(): Promise<string> {
  const baseEnv = await collectCellLlmEnv();
  if (!baseEnv.CELLS_PROXY_SECRET) throw new Error("CELLS_PROXY_SECRET missing from ~/.cells/secrets.json");

  // Generic egg — no baked identity. The cell's name is imprinted at
  // birth (ritual step 1); register-site-service.sh passes CELL_NAME to
  // the site service explicitly. Nothing downstream needs a baked one.
  const wellName = generatePoolWellName();
  const env = { ...baseEnv };

  // Decide tier BEFORE create. tier 4 = running-resident (first
  // V1_RUNNING_POOL_TARGET members); tier 2 = hibernated (the rest).
  // Hibernated wells need hibernate_ready: true at create so wells's
  // hibernate gate doesn't refuse later (Piece 3).
  const runningCount = await countRunningPoolMembers();
  const tier: 2 | 4 = runningCount < V1_RUNNING_POOL_TARGET ? 4 : 2;

  try {
    // From ubuntu-base (the wells-team-owned substrate) — NOT cell-base.
    // The cells-shaped layers (pi, DNA at /root, cells-env.sh, pi binary +
    // patches) get applied via provisionCellInWell over SSH right after
    // firstboot. ubuntu user (NOPASSWD sudo) + /home/well/.ssh come
    // pre-baked from ubuntu-base (wells-stable-2026-05-12h); the agent
    // sudoes from ubuntu to root.
    // Post-Piece-3 (2026-05-13): we no longer pass hibernate_ready at
    // create time (Pi3 deleted that path). Instead, sealWell() is called
    // after provisionCellInWell to flip the well to a hibernate-legal
    // disk-only state. ~6-8s cost is paid by /seal instead of /v1/wells.
    //
    // Per-step catches just rewrap the underlying error with a "<step>
    // failed for <well>" prefix so captureBakeFailure can infer the stage.
    // They do NOT destroy the well — the top-level catch below does that
    // AFTER forensics capture, which matters for stages like seal where
    // the failed-state disk.img + qemu PIDs are the diagnostic.
    try {
      await directWellCreate(wellName, { fromImage: "ubuntu-base", env });
    } catch (e) {
      throw new Error(
        `bakePoolMember well create failed for '${wellName}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    await setWellAuthPublic(wellName);
    // Pin auto-sleep off for the duration of the bake — welld's watchdog
    // can otherwise race the bake-time hibernate decision (auto-hibernating
    // mid-provision is a known failure shape).  We restore the welld default
    // (auto_sleep_seconds=60) AFTER validation, so the egg lands in the pool
    // with normal idle-hibernation behavior — if anything wakes it later,
    // it auto-hibernates on idle instead of pinning warm forever.
    await disableAutoSleep(wellName);

    // Wait for well-firstboot (identity injection: hostname, machine-id,
    // ssh host keys, /etc/environment, authorized_keys). Without this,
    // hibernating mid-firstboot leaves wake-resumed wells in a broken
    // state and adds ~30s to the first birth.
    try {
      await waitForCloudInit(wellName);
    } catch (e) {
      throw new Error(
        `bakePoolMember waitForCloudInit failed for '${wellName}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Per-egg provisioning: lift ubuntu-base → fully-formed cell.
    try {
      await provisionCellInWell(wellName);
    } catch (e) {
      throw new Error(
        `bakePoolMember provisioning failed for '${wellName}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Seal the well: halt, restart without cidata, flip hibernate_ready.
    // Required post-Piece-3 (2026-05-13) — wells's createWell no longer
    // does this inline. Without /seal, the /hibernate gate refuses every
    // freshly-baked well. The disk-only steady state captured here is the
    // POST-provision state, so wake-from-hibernate restores the
    // provisioned cell — strictly cleaner than pre-Pi3 (where warming
    // ran inside create, before provisioning had a chance to land).
    try {
      await sealWell(wellName);
    } catch (e) {
      throw new Error(
        `bakePoolMember seal failed for '${wellName}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // (Bridge readiness was previously asserted here against an in-cell
    // well-site.service. With the host-bridge architecture, pi is spawned
    // on-demand via SSH at talk time — there's no in-cell bridge to wait
    // for. waitForCloudInit above is sufficient: it confirms firstboot
    // identity injection + SSH readiness, which is everything host-bridge
    // needs to connect.)

    // Tier decision happened pre-create above. Now act on it: Tier 2 →
    // hibernate the now-sealed well; Tier 4 → leave running with pi
    // configured (sealed but live; sleep can still seal-and-hibernate it
    // later if the user cells sleep's it).
    if (tier === 2) {
      const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
      const hibRes = await fetch(
        `${base}/v1/wells/${encodeURIComponent(wellName)}/hibernate`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${await wellsToken()}` },
        },
      );
      if (!hibRes.ok) {
        throw new Error(
          `bakePoolMember hibernate failed for '${wellName}': ${hibRes.status} ${(await hibRes.text()).slice(0, 300)}`,
        );
      }
    }
    // Tier 4: leave the well running with pi pre-configured.

    // Wake-validate round-trip: /hibernate returning 200 only proves the
    // snapshot was written. It does NOT prove the snapshot wakes back up
    // into a routable, SSH-able VM. An egg that fails to wake is poison in
    // the pool — claim picks it blind, birth fails with a stale-IP "no route
    // to host", and the user thinks the pool's broken even though four good
    // eggs sit behind it. So the egg has to actually round-trip before we
    // mark it "open".
    //
    // Tier 2: /wake → IP → SSH `true` → /hibernate (back to steady state).
    // Tier 4: SSH `true` (well never left running; nothing to re-hibernate).
    try {
      await validateBakedEgg(wellName, tier);
    } catch (e) {
      throw new Error(
        `bakePoolMember validation failed for '${wellName}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Lift the bake-time pin.  Bake + validate done; the egg can now
    // follow normal welld idle-hibernation behavior.  Without this the
    // egg sits in the pool with auto_sleep_seconds=null forever and any
    // wake (e.g. a future variant-pool promote, traffic, manual /wake)
    // strands it warm — burning host RAM for an unclaimed pool member.
    await resetAutoSleepToDefault(wellName);

    await withPoolLock(async () => {
      const file = await loadPool();
      file.members.push({
        id: wellName.slice("egg-".length),
        well_name: wellName,
        variant_signature: V1_POOL_VARIANT_SIGNATURE,
        state: "open",
        tier,
        // Runtime-DNA rev baked into this egg — the SAME value stamped onto
        // /root/.dna-rev in provisionCellInWell (dnaRev is memoized per dir,
        // so this is one walk). Lets the doctor judge pool staleness from
        // pool.json with ZERO wakes, and the reconcile stale-rev cull retire
        // eggs that fell behind without ever waking a hibernated egg.
        dna_rev: dnaRev(DNA_DIR),
        born_at: new Date().toISOString(),
        claimed_at: null,
        claimed_by: null,
        max_age_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      } as any);
      await savePool(file);
    });

    return wellName;
  } catch (e) {
    // Unified failure path: capture forensics BEFORE destroy so the failed
    // state (disk.img file handles, lingering qemu PIDs, welld view of the
    // well) is still inspectable. captureBakeFailure infers the failed stage
    // from the error message and grabs stage-appropriate diagnostics — see
    // its body for the seal-specific lsof + Virtualization-PID capture asked
    // for by wells 2026-05-23.
    const err = e instanceof Error ? e : new Error(String(e));
    await captureBakeFailure(wellName, tier, err);
    if (process.env.CELLS_BAKE_KEEP_FAILURES === "1") {
      console.warn(`! CELLS_BAKE_KEEP_FAILURES=1 — leaving '${wellName}' alive for inspection`);
    } else {
      await directWellDestroy(wellName).catch(() => {});
    }
    throw err;
  }
}

// ─── Specials: mother + pulse ──────────────────────────────────────────────
//
// mother and pulse are *named* cells with bespoke DNA in dna/specials/<name>/.
// They live in deterministic wells (`cells-mother`, `cells-pulse`) outside
// the pool flow, and are pinned (auto_sleep_seconds=null) so they never
// hibernate. Birth is hand-driven via `cells birth-special <name>` rather
// than the generic pool consume path.

type SpecialSpec = {
  name: string; // the cell name — "mother"/"pulse", or "<project>-mother"
  wellName: string;
  harness: "pi" | "claude-code";
  // Which dna/specials/<dnaName>/ template to bake from. A project mother
  // (<project>-mother) shares the global mother's DNA — there are no per-project
  // birth-DNA forks (project specifics ride in the blob, not the genome).
  dnaName: "mother" | "pulse";
  // Project tag for a project mother; absent for the global mother/pulse.
  project?: string;
  // NOTE: model/provider/thinking are deliberately NOT here. Runtime model
  // config lives in dna/specials/<dnaName>/.pi/settings.json — single source of
  // truth. The registry's modelChain is *derived* from that file at bake
  // time (see cmdBirthSpecial). Putting them here too caused real drift:
  // the registry showed claude-opus-4-7 while mother actually ran on codex.
};

const SPECIALS: Record<"mother" | "pulse", SpecialSpec> = {
  mother: {
    name: "mother",
    wellName: "cells-mother",
    harness: "pi",
    dnaName: "mother",
  },
  pulse: {
    name: "pulse",
    wellName: "cells-pulse",
    harness: "claude-code",
    dnaName: "pulse",
  },
};

// Resolve a `birth-special` argument to its spec: a known global special, or a
// project mother/pulse (`<project>-mother` / `<project>-pulse`) synthesized from
// the shared template (own well `cells-<project>-<role>`, the role's harness +
// DNA, tagged project). (projectOfMother / projectOfPulse and friends are the
// shared naming primitives in lib/cell-name.ts.)
function resolveSpecialSpec(arg: string): SpecialSpec | null {
  if (arg === "mother" || arg === "pulse") return SPECIALS[arg];
  // Both the cell name (arg, a worker subdomain label) and the well name
  // (cells-<arg>) must be valid DNS labels ≤63 chars. The `cells birth <project>
  // <role>` dispatch path guards the project, but the direct `birth-special
  // <project>-<role>` form lands here unguarded — without this a bad name
  // (uppercase, space, too long) would half-create a malformed well before
  // failing late and messily.
  const motherProject = projectOfMother(arg);
  if (motherProject) {
    if (!isValidCellName(arg) || !isValidCellName(`cells-${arg}`)) return null;
    return {
      name: arg,
      wellName: `cells-${arg}`,
      harness: SPECIALS.mother.harness,
      dnaName: "mother",
      project: motherProject,
    };
  }
  const pulseProject = projectOfPulse(arg);
  if (pulseProject) {
    if (!isValidCellName(arg) || !isValidCellName(`cells-${arg}`)) return null;
    return {
      name: arg,
      wellName: `cells-${arg}`,
      harness: SPECIALS.pulse.harness,
      dnaName: "pulse",
      project: pulseProject,
    };
  }
  return null;
}

// Which mother orchestrates births for a project: the project's own mother if
// it's registered + alive, else the global mother. (In Stage 2 the birth ritual
// itself is the shared MOTHER_ROOT skill on Pete's one Max session — see the
// birth-ritual lock — so this resolves ownership/attribution, not a separate
// execution path.)
async function motherFor(project: string | undefined): Promise<string> {
  if (project) {
    const pm = projectMotherName(project);
    const cell = await findCell(pm);
    if (cell && cell.special && cell.status !== "warming") return pm;
  }
  return "mother";
}

// Read the model chain straight out of the special's DNA settings.json.
// This is the *single source of truth* for what a special is configured to
// run on.
//
// Two shapes possible — `harnessChain` wins if present (mother uses it for
// her dual-harness setup), else fall back to the flat `modelChain` field
// pi reads at runtime.
//
//   harnessChain: [{harness, model: "<provider>/<model>", thinking}, ...]
//     → registry chain entries: "<harness>:<provider>/<model>:<thinking>"
//   modelChain:    ["<provider>/<model>:<thinking>", ...]   (no harness prefix)
//     → registry chain entries: unchanged
//
// The registry chain encodes harness selection for `cmdBirth` (which harness
// runs the ritual) and for `cells list` (display). Pi's runtime only ever
// reads `modelChain`, never the registry — so its fallback chain stays
// pi-only even when harnessChain[0] is claude-code.
async function readSpecialModelChain(dnaName: "mother" | "pulse"): Promise<string[]> {
  const path = join(SPECIALS_DIR, dnaName, ".pi", "settings.json");
  const settings = JSON.parse(await readFile(path, "utf-8"));
  if (Array.isArray(settings.harnessChain) && settings.harnessChain.length > 0) {
    return settings.harnessChain.map((e: { harness: string; model: string; thinking?: string }) =>
      `${e.harness}:${e.model}:${e.thinking ?? "high"}`,
    );
  }
  if (Array.isArray(settings.modelChain) && settings.modelChain.length > 0) {
    return settings.modelChain;
  }
  const provider = settings.defaultProvider;
  const model = settings.defaultModel;
  const thinking = settings.defaultThinkingLevel ?? "high";
  if (!provider || !model) {
    throw new Error(
      `${name}'s settings.json has no modelChain and no defaultProvider/defaultModel — ` +
      `can't derive registry modelChain. fix ${path}.`,
    );
  }
  return [`${provider}/${model}:${thinking}`];
}

// Read mother's registry chain entries — used by cmdBirth to pick which
// harness runs the ritual (and to fall over to the next on pre-flight
// failure). Falls back to the legacy single-harness "pi" if mother isn't
// in the registry yet, or her entry has no chain.
async function readMotherHarnessChain(): Promise<string[]> {
  try {
    const reg = await loadRegistry();
    const mother = reg.cells.find((c: any) => c.name === "mother");
    if (mother && Array.isArray(mother.modelChain) && mother.modelChain.length > 0) {
      return mother.modelChain;
    }
  } catch { /* fall through */ }
  // Legacy: no registry entry → assume pi-only, single attempt.
  return ["pi:openai-codex/gpt-5.5:high"];
}

// Parse a registry chain entry. Two formats:
//   "<harness>:<provider>/<model>:<thinking>"   (dual-harness specials)
//   "<provider>/<model>:<thinking>"             (everything else)
// Detection: a harness prefix's colon comes BEFORE the first slash; old
// format's only colons come after the slash (thinking-level separator).
function parseChainEntry(entry: string): {
  harness: string | null;
  providerModel: string;  // "<provider>/<model>:<thinking>" — what fits everywhere else today
  display: string;        // "<model>:<thinking>" — for cells list
} {
  const firstColon = entry.indexOf(":");
  const firstSlash = entry.indexOf("/");
  let harness: string | null = null;
  let rest = entry;
  if (firstColon >= 0 && firstSlash >= 0 && firstColon < firstSlash) {
    harness = entry.slice(0, firstColon);
    rest = entry.slice(firstColon + 1);
  }
  const slash = rest.indexOf("/");
  const display = slash >= 0 ? rest.slice(slash + 1) : rest;
  return { harness, providerModel: rest, display };
}

// Files in dna/cells/base/ that the base provision lays down at /root and
// that the specials need to overlay/replace. We wipe these before pushing
// the specials DNA so leftover base identity doesn't poison the cell.
const SPECIAL_OVERLAY_WIPE = [
  "IDENTITY.md", "SOUL.md", "AGENTS.md", "CELLS.md", "CONTACTS.md",
  "HEARTBEAT.md", "MEMORY.md", "TOOLS.md", "CLAUDE.md",
  ".pi/settings.json", ".pi/extensions", ".pi/skills", ".pi/prompts",
];

async function cmdBirthSpecial(rawArgs: string[]): Promise<void> {
  const args = rawArgs.filter(a => !a.startsWith("--"));
  const flags = new Set(rawArgs.filter(a => a.startsWith("--")));
  const arg = args[0];
  const spec = arg ? resolveSpecialSpec(arg) : null;
  if (!spec) {
    console.error("usage: cells birth-special <mother|pulse|<project>-mother|<project>-pulse> [--rebuild]");
    process.exit(2);
  }
  const rebuild = flags.has("--rebuild");

  // --harness override: a PROJECT mother may be born on the claude-code harness
  // instead of the default pi, so her own agentic loop reasons on Opus (set the
  // depth with `cells model <project>-mother anthropic/opus:medium`). The global
  // mother and every pulse keep their fixed harness — their model lane is settled
  // and overriding it has no use case. Applied here, before pre-register (1b) and
  // the bake both read spec.harness.
  const harnessFlag = [...flags].find((f) => f.startsWith("--harness="));
  if (harnessFlag) {
    const want = harnessFlag.slice("--harness=".length).trim();
    if (want !== "pi" && want !== "claude-code") {
      console.error(`bad --harness '${want}' — choose pi or claude-code`);
      process.exit(2);
    }
    if (spec.dnaName !== "mother" || !spec.project) {
      console.error(
        `--harness is only settable on a project mother (<project>-mother). ` +
        `${spec.name}'s harness is fixed by design.`,
      );
      process.exit(2);
    }
    spec.harness = want;
    console.log(`  harness override: ${spec.name} → ${want}`);
  }

  // A project pulse is an always-on pinned cell (~1.9GB RAM, never hibernates).
  // The universal pulse already schedules every project for free, so a project
  // pulse is opt-in + steady-state costly — gate it behind an explicit confirm.
  // --yes/-y skips; --rebuild (re-bake of an existing one) skips. Gating here,
  // the single choke point for special births, covers BOTH `cells birth
  // <project> pulse` and the lower-level `cells birth-special <project>-pulse`.
  // Check stdin too (ask() reads it): a closed stdin would return "" → cancel,
  // so a non-interactive caller must pass --yes rather than be silently dropped.
  if (spec.dnaName === "pulse" && spec.project && !rebuild && !flags.has("--yes") && !flags.has("-y")) {
    const msg = `'${spec.name}' is an always-on pinned cell (~1.9GB RAM, never hibernates).\nThe universal pulse already schedules ${spec.project}'s cells for free — a project pulse only adds isolation / its own cadence.`;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(`${msg}\nRe-run with --yes to confirm: cells birth ${spec.project} pulse --yes`);
      process.exit(1);
    }
    console.log(msg);
    const ans = (await ask(`\nbirth ${spec.name}? [y/N] `)).toLowerCase();
    if (ans !== "y" && ans !== "yes") {
      console.log("birth cancelled.");
      process.exit(0);
    }
  }

  console.log(`birth-special ${spec.name} → ${spec.wellName}`);

  // 1. Idempotency: refuse if registry already lists this cell as a real
  //    (alive) special unless --rebuild. A leaked "warming" entry from a
  //    crashed prior birth-special is non-authoritative — treat it like
  //    absent (the cull/pre-register below replaces it).
  const existing = findCellIn((await loadRegistry()).cells, spec.name);
  if (existing && existing.status !== "warming" && !rebuild) {
    console.error(`${spec.name} already registered (born ${existing.created_at}). pass --rebuild to rebake.`);
    process.exit(1);
  }

  // 1b. Pre-register "warming" BEFORE the slow birth (and before the --rebuild
  //     well destroy below). A claude-code special (pulse, a project mother)
  //     starts its always-on loop — startPulseLoop fires pulse.service, which
  //     makes proxy Anthropic calls — before we'd otherwise register it at the
  //     end. The Max-policy gate 403s a cell it can't find, so the loop's first
  //     ticks would fail. Registration is the gate's allowlist (name + harness);
  //     promoted to "alive" once the bake proves out. The DNA settings.json is
  //     the single source of truth for the model chain (read once, reused at
  //     promote). Doing this upsert (warming replaces any old alive entry)
  //     BEFORE the destroy means a registry-lock failure here leaves the old
  //     special + its well fully intact — nothing half-torn-down.
  const specialChain = await readSpecialModelChain(spec.dnaName);
  try {
    await mutateRegistry((cells) =>
      upsertBirthingCell(cullStaleWarming(cells, Date.now()), {
        name: spec.name,
        created_at: new Date().toISOString(),
        harness: spec.harness,
        modelChain: specialChain,
        special: true,
        pinned: true,
        ...(spec.project ? { project: spec.project } : {}),
      }),
    );
  } catch (e) {
    console.error(`birth-special failed: could not pre-register ${spec.name} (${e instanceof Error ? e.message : String(e)})`);
    process.exit(1);
  }

  // 1c. NOW destroy any existing well — the registry already points at the
  //     warming rebake, so even if this or the bake fails the old well is simply
  //     gone (rollbackSpecial below clears the warming entry). We destroy on a
  //     leaked *warming* leftover too (a hard-crashed prior birth-special can
  //     strand both a warming entry AND its well), so bakeSpecial's create never
  //     hits a name conflict. directWellDestroy is a safe no-op if absent.
  if (existing) {
    console.log(`${rebuild ? "rebuild" : "cleanup"}: destroying any existing ${spec.wellName}…`);
    await directWellDestroy(spec.wellName).catch(() => {});
  }
  // Any throw during the long bake rolls the warming entry back so a failed
  // birth-special doesn't strand a non-authoritative entry (the cull would
  // also reap it after STALE_WARMING_MS, but rolling back is immediate).
  const rollbackSpecial = async () => {
    try { await mutateRegistry((cells) => removeCell(cells, spec.name)); } catch { /* best-effort */ }
  };
  try {
    await bakeSpecial(spec, specialChain);
  } catch (e) {
    await rollbackSpecial();
    throw e;
  }
}

// The long, fallible body of birth-special: create the well, provision, seal,
// pin, install the cell-specific kicker, then promote the pre-registered
// "warming" entry to "alive". Factored out so cmdBirthSpecial can wrap it in a
// single rollback-on-throw guard (the warming entry is registered before this
// runs). Every step is idempotent, so --rebuild needs no special-casing here.
async function bakeSpecial(spec: SpecialSpec, specialChain: string[]): Promise<void> {
  // 2. Auth env for in-well pi (CELLS_PROXY_SECRET, etc.) — same shape as pool eggs.
  const baseEnv = await collectCellLlmEnv();
  if (!baseEnv.CELLS_PROXY_SECRET) {
    throw new Error("CELLS_PROXY_SECRET missing from ~/.cells/secrets.json");
  }
  const env = { ...baseEnv, CELL_NAME: spec.name };

  // 3. Create the well (named, not egg-<hex>). A create failure can
  //    leave a partial bundle dir in welld's state dir — best-effort
  //    destroy so we don't leak it (same abort shape as steps 4/5).
  console.log(`  creating well ${spec.wellName}…`);
  try {
    await directWellCreate(spec.wellName, { fromImage: "ubuntu-base", env });
  } catch (e) {
    await directWellDestroy(spec.wellName).catch(() => {});
    throw new Error(`well create failed for ${spec.wellName}: ${e instanceof Error ? e.message : String(e)}`);
  }
  await setWellAuthPublic(spec.wellName);
  await disableAutoSleep(spec.wellName);

  // 4. Wait for firstboot identity injection.
  try {
    await waitForCloudInit(spec.wellName);
  } catch (e) {
    await directWellDestroy(spec.wellName);
    throw new Error(`waitForCloudInit failed for ${spec.wellName}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 5. Base provisioning (pi, codex, /root runtime, profile.d shim). This
  //    drops the generic cell-base agent files at /root — which we then
  //    overlay with the special's bespoke DNA below.
  try {
    await provisionCellInWell(spec.wellName);
  } catch (e) {
    await directWellDestroy(spec.wellName);
    throw new Error(`provision failed for ${spec.wellName}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 6. Overlay specials DNA. Wipe the base identity files first so leftover
  //    base extensions / settings don't poison the special. A project mother
  //    bakes from the shared mother template (spec.dnaName), not a per-project
  //    genome — __NAME__ substitution below personalizes it to <project>-mother.
  console.log(`  overlaying dna/specials/${spec.dnaName}/ onto /root…`);
  const wipeCmd = SPECIAL_OVERLAY_WIPE.map(p => `sudo rm -rf /root/${p}`).join(" && ");
  const wipe = await wellExecCapture(spec.wellName, wipeCmd);
  if (!wipe.ok) {
    throw new Error(`overlay wipe failed: ${wipe.stderr.slice(0, 300)}`);
  }
  // Specials DNA contains symlinks (mother/docs → ../../../docs,
  // mother/scripts → ../../../scripts) so deref at archive time with -h.
  // Also pass --overwrite so files overlay base DNA cleanly.
  const overlaySrc = join(SPECIALS_DIR, spec.dnaName);
  // A project mother bakes from the SHARED mother DNA, whose state/memory holds
  // the GLOBAL mother's LIVE accumulators (a per-mother roster + a large
  // append-only birth-activity log) and her infra/host notes (the proxy wiring,
  // pi internals, substrate references — which drift and would mislead a fresh
  // mother if frozen). None of those are seed — exclude them from a project
  // mother's bake. The committed behavioral priors (feedback_* + MEMORY.md) ride
  // along regardless, so she's born knowing births go through the cells CLI.
  const overlayExcludes =
    spec.dnaName === "mother" && spec.project
      ? ["--exclude=./state/memory/project_cells_activity.md",
         "--exclude=./state/memory/project_cells_roster.md",
         "--exclude=./state/memory/project_mother_proxy.md",
         "--exclude=./state/memory/reference_pi_internals.md",
         "--exclude=./state/memory/reference_sprite_hibernation.md"]
      : [];
  const overlayTar = Bun.spawn(["tar", "czhf", "-", ...overlayExcludes, "-C", overlaySrc, "."], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const overlayExtract = Bun.spawn(
    ["well", "exec", "-s", spec.wellName, "--", "bash", "-c",
      "sudo bash -c 'cd /root && tar xzf - --overwrite'"],
    { stdin: overlayTar.stdout, stdout: "pipe", stderr: "pipe" },
  );
  const overlayCode = await overlayExtract.exited;
  if (overlayCode !== 0) {
    const err = await new Response(overlayExtract.stderr).text();
    throw new Error(`overlay push failed: ${err.slice(0, 400)}`);
  }
  const chown = await wellExecCapture(spec.wellName, "sudo chown -R root:root /root");
  if (!chown.ok) {
    throw new Error(`chown after overlay failed: ${chown.stderr.slice(0, 300)}`);
  }

  // 6b. Write /root/.pi/status.json with the chosen harness. The cell
  //     supervisor (dna/cells/base/site/server.ts) reads this on boot to
  //     pick which harness to spawn for the always-on session — without
  //     it the supervisor falls back to "pi". bake-egg.sh writes this for
  //     pool births; specials skip that path so we write it here.
  const statusJson = JSON.stringify({ harness: spec.harness, channels: [] });
  const statusWrite = await wellExecCapture(
    spec.wellName,
    `sudo mkdir -p /root/.pi && echo '${statusJson}' | sudo tee /root/.pi/status.json > /dev/null`,
  );
  if (!statusWrite.ok) {
    throw new Error(`status.json write failed: ${statusWrite.stderr.slice(0, 200)}`);
  }
  console.log(`  wrote /root/.pi/status.json (harness=${spec.harness})`);

  // 6c. Register the `site` systemd unit + deploy the per-cell Cloudflare
  //     Worker. The pool/mother-driven birth ritual does these as part of
  //     post-birth-async work (see dna/specials/mother/.claude/skills/birth/);
  //     specials skip that ritual, so we run them here, synchronously,
  //     because a later step (startPulseLoop, after promote) starts
  //     pulse.service — which immediately injects /pulse messages into the
  //     cell's main session via <name>.cells.md. Without the worker the inject
  //     404s; without the site service localhost:8080 (the supervisor) isn't
  //     up. Pulse needs both running before startPulseLoop fires.
  //
  //     Every special gets this — it was pulse-only until 2026-06-10, on
  //     the theory that mother's hand-setup would persist. It didn't: her
  //     2026-05-22 re-birth landed on a fresh well, welld's service
  //     definition still pointed at the old one, and she ran 18 days with
  //     no supervisor — talk replies silently dropped (the June 9/10
  //     incident). Service materialization is PUT-time-only, so re-birth
  //     MUST re-register. Both scripts are idempotent.
  {
    // Pass welld auth/URL into the child scripts — they default to
    // hosted-sprites and look up WELL_TOKEN in secrets.json which the
    // local-welld path doesn't populate (token lives at ~/.wells/token).
    const scriptEnv = { ...process.env, ...wellsEnv() };

    console.log(`  registering site service in ${spec.wellName}…`);
    const siteReg = Bun.spawn(
      ["bash", join(REPO_ROOT, "scripts/register-site-service.sh"), spec.name, spec.wellName],
      { stdio: ["ignore", "inherit", "inherit"], env: scriptEnv },
    );
    if ((await siteReg.exited) !== 0) {
      throw new Error(`register-site-service.sh failed for ${spec.wellName}`);
    }
    console.log(`  ✓ site service registered (well-site.service)`);

    // Public well URL — supervisor dials out, but the worker uses the
    // url for the bridge connect-back. Idempotent if already public.
    await setWellAuthPublic(spec.wellName);

    console.log(`  deploying Cloudflare Worker pulse.cells.md…`);
    const workerDeploy = Bun.spawn(
      ["bash", join(REPO_ROOT, "scripts/deploy-cell-worker.sh"), spec.name, spec.wellName],
      { stdio: ["ignore", "inherit", "inherit"], env: scriptEnv },
    );
    if ((await workerDeploy.exited) !== 0) {
      throw new Error(`deploy-cell-worker.sh failed for ${spec.name}`);
    }
    console.log(`  ✓ worker deployed`);
  }

  // 7. Cell-specific kicker (keyed on the DNA template, so a <project>-mother
  //    gets mother's kicker too).
  if (spec.dnaName === "pulse") {
    await installPulseLoop(spec.wellName);
  }
  if (spec.dnaName === "mother") {
    // Strip in-well-incompatible extensions:
    //  - well-tools shells out to the Mac's `well` CLI; doesn't exist in-well.
    //    Its tools (well_exec, report_outcome) are re-registered by mother-tools
    //    against the bridge, so the ritual works unchanged.
    //  - mother-status reads ~/.cells/cells.json directly; in-well that file
    //    doesn't exist (the registry comes via /bridge/registry/read instead).
    // Pi auto-loads everything under .pi/extensions/, so removing them from
    // settings.json isn't enough — delete the dirs too. Also pre-create
    // /root/.pi/settings.json.lock dir owned by root (pi needs to mkdir
    // siblings of settings.json; ubuntu user can't write to /root).
    const stripScript = `set -euo pipefail
cd /root
sudo rm -rf .pi/extensions/well-tools .pi/extensions/mother-status
jq '.extensions |= map(select(. != ".pi/extensions/well-tools/index.ts" and . != ".pi/extensions/mother-status/index.ts"))' \
  .pi/settings.json > /tmp/s.json && sudo mv /tmp/s.json .pi/settings.json
sudo chown -R root:root /root/.pi
echo "extensions after strip:"
jq -r '.extensions[]' .pi/settings.json
echo "on disk:"
ls .pi/extensions/`;
    const strip = await wellExecCapture(spec.wellName, stripScript);
    if (!strip.ok) {
      throw new Error(`mother settings.json strip failed: ${strip.stderr.slice(0, 300)}`);
    }
    console.log(`  stripped well-tools + mother-status (settings + on-disk)`);
  }

  // 7b. Substitute __NAME__ placeholders + tmux color chip. The pool
  //     ritual does this in steps 1-2; specials skip the ritual so we
  //     run an equivalent here. Without this, codex-proxy + similar
  //     extensions read `__NAME__` from package.json and the proxy logs
  //     calls as "unknown" or "__NAME__" instead of the cell name.
  // Capture stderr separately so a failed/missing cell-color.sh doesn't
  // leak its "bash: ... No such file" message into the color tokens (it did:
  // a missing script baked `fg=/root/scripts/cell-color.sh:,bg=bash:` into
  // .tmux.conf and broke status-style rendering on shell open).
  const cellColor = await wellExecCapture(spec.wellName,
    `bash /root/scripts/cell-color.sh ${spec.name} 2>/dev/null`).catch(() => null);
  const tokens = (cellColor?.stdout ?? "").trim().split(/\s+/);
  const isHexColor = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);
  const bg = isHexColor(tokens[0] ?? "") ? tokens[0] : "#888888";
  const fg = isHexColor(tokens[1] ?? "") ? tokens[1] : "#ffffff";
  const subScript = `set -euo pipefail
cd /root
for f in AGENTS.md CLAUDE.md SOUL.md IDENTITY.md CELLS.md CONTACTS.md HEARTBEAT.md package.json .tmux.conf .claude/settings.json; do
  [ -f "$f" ] && sudo sed -i "s/__NAME__/${spec.name}/g" "$f" || true
done
[ -f .tmux.conf ] && sudo sed -i "s|__CELL_BG__|${bg}|g; s|__CELL_FG__|${fg}|g" .tmux.conf || true
# A claude-code special boots straight from .claude/settings.json. The pool path
# (bake-egg.sh) fills the model/effort placeholders there, but specials skip that
# path — so a literal __MODEL__/__THINKING__ would leave an unrunnable config and
# wedge the supervisor. Substitute opus/high here (cells model adjusts post-birth);
# a no-op when the DNA already ships a concrete file (e.g. pulse).
[ -f .claude/settings.json ] && sudo sed -i "s/__MODEL__/opus/g; s/__THINKING__/high/g" .claude/settings.json || true
echo "name-subst: $(grep -lc __NAME__ AGENTS.md CLAUDE.md SOUL.md package.json .tmux.conf .claude/settings.json 2>/dev/null | wc -l) files still with __NAME__ (want 0)"`;
  const sub = await wellExecCapture(spec.wellName, subScript);
  if (!sub.ok) {
    throw new Error(`name substitution failed: ${sub.stderr.slice(0, 300)}`);
  }
  console.log(`  substituted __NAME__ → ${spec.name} + tmux color (${bg}/${fg})`);

  // A claude-code special's first supervisor spawn reads .claude/settings.json
  // directly — verify it's valid JSON with a concrete model before we promote.
  // This is exactly the failure that would silently drop a claude-code mother's
  // birth-reliability below Pete's bar, so fail the bake loudly instead.
  if (spec.harness === "claude-code") {
    const check = await wellExecCapture(
      spec.wellName,
      `jq -e '((.model // "") | test("__|^$") | not) and ((.effortLevel // "") | test("__|^$") | not)' /root/.claude/settings.json >/dev/null && echo ok`,
    );
    if (!check.ok || check.stdout.trim() !== "ok") {
      throw new Error(
        `claude-code special ${spec.name} has an unrunnable /root/.claude/settings.json ` +
        `(model/effortLevel unset or still a placeholder): ${(check.stderr || check.stdout).slice(0, 200)}`,
      );
    }
    console.log(`  verified .claude/settings.json is runnable (claude-code)`);
  }

  // A claude-code MOTHER needs a captured main session, the same as a normal
  // claude-code pool cell gets from bake-egg.sh: site/server.ts resumes
  // /root/.cell/claude-main-session so conversation survives a well-site restart
  // and agent-comms forks (`cells talk <mother>`) carry context. The special
  // bake skips bake-egg.sh, so capture it here — warm up `claude --print` once
  // and cache the session id. BEST-EFFORT: a transient miss must NOT fail the
  // birth (that would trade continuity for reliability — the wrong way against
  // a 100% bar), so we warn and move on; she falls back to a fresh first turn,
  // exactly as today. The cell is already registered "warming" (claude-code), so
  // the proxy Max-policy gate admits this warm-up. (Pulse is intentionally NOT
  // captured — its always-on loop drives its own session; leaving its bake
  // unchanged avoids a behavior change on a path that already works.)
  if (spec.dnaName === "mother" && spec.harness === "claude-code") {
    const capture = await wellExecCapture(
      spec.wellName,
      `set -uo pipefail
sudo mkdir -p /root/.cell
MAIN_ID=$(timeout 150 sudo bash -lc 'export HOME=/root IS_SANDBOX=1; cd /root && claude --print ping --output-format stream-json --verbose --permission-mode bypassPermissions 2>/dev/null' < /dev/null | jq -rs 'map(select(.type=="system" and .subtype=="init")) | .[0].session_id // ""')
if [ -n "$MAIN_ID" ]; then
  echo "$MAIN_ID" | sudo tee /root/.cell/claude-main-session > /dev/null
  echo "MAIN_OK $MAIN_ID"
else
  echo "MAIN_EMPTY"
fi`,
    );
    if (capture.ok && capture.stdout.includes("MAIN_OK")) {
      const id = capture.stdout.match(/MAIN_OK (\S+)/)?.[1] ?? "";
      console.log(`  captured claude main session: ${id}`);
    } else {
      console.warn(
        `  ! claude-main-session capture didn't land (best-effort) — ${spec.name} will start a fresh session on first talk; ` +
        `re-run \`cells birth-special ${spec.name} --rebuild\` later if continuity matters. ` +
        `detail: ${(capture.stderr || capture.stdout).slice(0, 160)}`,
      );
    }
    // register-site-service (6c) already started well-site, which read its
    // harness config + main-session id at boot — BEFORE the __MODEL__/__THINKING__
    // substitution and the capture just above. site/server.ts caches the resume
    // id at module load, so the live supervisor is still running on placeholder
    // model + no --resume. Restart it now so it re-reads the finalized
    // .claude/settings.json and resumes the captured session. REQUIRED (not
    // best-effort like the capture): a mother left on a placeholder model is a
    // non-functional birth, so fail loudly rather than promote a broken cell.
    const restart = await wellExecCapture(spec.wellName, "sudo systemctl restart well-site");
    if (!restart.ok) {
      throw new Error(
        `well-site restart after claude-code config prep failed for ${spec.name} — ` +
        `the supervisor would keep running on placeholder config: ${(restart.stderr || restart.stdout).slice(0, 200)}`,
      );
    }
    console.log(`  restarted well-site (picks up final claude model + main session)`);
  }

  // 7c. Seal — make the well hibernate-capable (hibernation model,
  //     invariant 4). Specials are pinned and won't hibernate in practice,
  //     but capability is not policy: a sealed special survives a future
  //     `cells unpin` instead of failing welld's hibernate gate. The pool
  //     bake flow seals; the special bake flow never did.
  await ensureHibernateReady(spec.wellName);

  // 8. Pin always-on. (provisionCellInWell already called disableAutoSleep
  //    via the bake flow; this is the same operation — kept explicit so the
  //    pin step reads where you'd expect it.)
  await setAutoSleep(spec.wellName, null);

  // 9. Promote the pre-registered "warming" entry to "alive" (authoritative).
  //    specialChain came from the DNA settings.json — the single source of
  //    truth for what the special runs on (recording a parallel hardcoded
  //    value here once drifted and bit us). Re-read fresh under the lock and
  //    re-insert if the warming entry somehow vanished (a concurrent kill),
  //    so a proven special always lands registered + alive.
  await mutateRegistry((cells) => {
    let next = promoteCell(cells, spec.name, {
      modelChain: specialChain,
      harness: spec.harness,
      special: true,
      pinned: true,
      ...(spec.project ? { project: spec.project } : {}),
    });
    if (!findCellIn(next, spec.name)) {
      next = [...next, {
        name: spec.name,
        created_at: new Date().toISOString(),
        status: "alive" as const,
        harness: spec.harness,
        modelChain: specialChain,
        special: true,
        pinned: true,
        ...(spec.project ? { project: spec.project } : {}),
      }];
    }
    return next;
  });

  // 9b. Project-pulse birth handoff — take this project's cells over from the
  //     global pulse before this pulse starts ticking (no double-fire window).
  //     The global pulse (no project) skips this. Runs after promote so the
  //     registry already shows this pulse alive (the proxy now routes the
  //     project's heartbeats here too).
  if (spec.dnaName === "pulse" && spec.project) {
    await handoffProjectCellsOnBirth(spec.project, spec.wellName);
  }
  // 9c. Start the always-on loop now that the cell is alive + (for a project
  //     pulse) its handoff is done. installPulseLoop only enabled the service.
  if (spec.dnaName === "pulse") {
    await startPulseLoop(spec.wellName);
  }

  console.log(`✓ ${spec.name} born in ${spec.wellName}, pinned (auto_sleep_seconds=null).`);
  console.log(`  next: cells talk ${spec.name}`);
}

// Push the systemd unit + wrapper shipped in dna/specials/pulse/systemd/
// into the pulse well and enable the always-on loop. The wrapper paces
// tick cadence (default 5min) by injecting "/pulse" into the cell's own
// main session via the agent-comms fork rail. Idempotent — safe to
// re-run on --rebuild.
async function installPulseLoop(wellName: string): Promise<void> {
  console.log(`  installing systemd pulse.service + cron substrate in ${wellName}…`);
  const unitsDir = join(SPECIALS_DIR, "pulse", "systemd");
  const service = await readFile(join(unitsDir, "pulse.service"), "utf-8");
  const wrapper = await readFile(join(unitsDir, "pulse-wrapper"), "utf-8");

  // Pulse cell needs three system surfaces in place before the loop comes up:
  //
  //   1. /etc/systemd/system/pulse.service + /usr/local/bin/pulse-wrapper
  //      — the always-on tick loop that injects "run one pulse tick" into
  //        the cell's main claude session every 5 min.
  //
  //   2. cron daemon enabled — pulse no longer fires wakes itself; it
  //      translates each cell's prose schedule into crontab lines and
  //      lets Linux cron run them. Ubuntu ships the cron package, but
  //      we make sure it's enabled and running.
  //
  //   3. /etc/cron.d/pulse-schedules header — pulse-core writes per-cell
  //      blocks (# BEGIN pulse:<cell> … # END pulse:<cell>) into this
  //      file. Seed it with the header so the first save lands cleanly,
  //      and so an empty pulse cell is observably wired up.
  //
  //   4. Timezone set to America/Denver — cron evaluates crontab lines
  //      against system local time. Pete is in Mountain time, and most
  //      cells write schedules in local prose ("4am local"). DST is
  //      handled natively by the tz database; no manual switch needed.
  //
  // Everything runs as root via sudo — the wrapper, the cron daemon,
  // and the cron lines all share the same identity the cell supervisor
  // and claude session run under. Runtime dirs default to /root/.cells/
  // via pulse-core's resolvePaths (homedir).
  const script = `set -euo pipefail
sudo mkdir -p /root/.cells/logs /root/.cells/pulse-inbox /root/.cells/state
# Pin pulse cell to Pete's local timezone so cron evaluates schedules in
# the same frame the cells declare them in. Idempotent.
sudo timedatectl set-timezone America/Denver 2>/dev/null || true
sudo tee /etc/systemd/system/pulse.service >/dev/null <<'__SERVICE_EOF__'
${service}__SERVICE_EOF__
sudo tee /usr/local/bin/pulse-wrapper >/dev/null <<'__WRAPPER_EOF__'
${wrapper}__WRAPPER_EOF__
sudo chmod 0644 /etc/systemd/system/pulse.service
sudo chmod 0755 /usr/local/bin/pulse-wrapper
# Seed the crontab file pulse-core will manage. Idempotent — only writes
# the header if no file exists; preserves any blocks from a prior install.
if [ ! -f /etc/cron.d/pulse-schedules ]; then
  sudo tee /etc/cron.d/pulse-schedules >/dev/null <<'__CRON_EOF__'
# pulse-schedules — managed by pulse-core. Hand-edits will be overwritten.
SHELL=/bin/bash
PATH=/root/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin
__CRON_EOF__
  sudo chmod 0644 /etc/cron.d/pulse-schedules
fi
# Make sure the cron daemon is on. Ubuntu ships it; on some minimal
# images it isn't enabled by default. The Debian package is "cron";
# leave a graceful fallback for distros that use "cronie". restart
# (not just enable --now) so a TZ change above is picked up by a
# cron that was already running.
if systemctl list-unit-files | grep -q '^cron\\.service'; then
  sudo systemctl enable cron
  sudo systemctl restart cron
elif systemctl list-unit-files | grep -q '^crond\\.service'; then
  sudo systemctl enable crond
  sudo systemctl restart crond
else
  sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends cron
  sudo systemctl enable --now cron
fi
sudo systemctl daemon-reload
# Neither enable NOR start here. Both happen in startPulseLoop(), after promote
# (and, for a project pulse, after its birth handoff). Leaving the service
# DISABLED through bake is load-bearing: step 7c's seal makes the well
# hibernate-capable and can reboot it — if pulse.service were enabled
# (WantedBy=multi-user.target) that reboot would auto-start it BEFORE the
# handoff, and a project pulse could tick before its cells are off the global
# pulse. Disabled-until-startPulseLoop closes that window for real.
sudo systemctl status --no-pager cron 2>/dev/null | head -4 || sudo systemctl status --no-pager crond | head -4 || true`;

  const r = await wellExecCapture(wellName, script);
  if (!r.ok) {
    throw new Error(`installPulseLoop failed: ${(r.stderr + r.stdout).slice(-400)}`);
  }
  console.log(`  ✓ pulse.service installed (cron armed) — enable+start deferred to post-promote`);
}

// Enable + start the always-on pulse loop. Split out from installPulseLoop so a
// project pulse stays DISABLED (won't auto-start on the seal reboot) and only
// begins ticking — and writing cron blocks — after its birth handoff has moved
// its cells off the global pulse. `enable --now` here both enables (survive
// reboot) and starts. Idempotent (enable/start on a running service is a
// no-op), so --rebuild is safe.
async function startPulseLoop(wellName: string): Promise<void> {
  const r = await wellExecCapture(
    wellName,
    `sudo systemctl enable --now pulse.service && sudo systemctl status --no-pager pulse.service | head -6 || true`,
  );
  if (!r.ok) {
    throw new Error(`startPulseLoop failed: ${(r.stderr + r.stdout).slice(-300)}`);
  }
  console.log(`  ✓ pulse.service enabled + started (always-on, 5min tick)`);
}

// Ensure a (supposedly running) well actually has a DHCP-assigned IP.
// If welld reports status=running but ip=null (most often a side-effect
// of a flush-all that wiped legit leases), force a /stop + /start so the
// VM re-DHCPs on its next boot. Polls for the IP afterwards for up to 30s.
// V1.5/V1.6: ensure a well is running + SSH-ready before talk.
// Different from ensureWellHasIp (which only checks IP, used at birth):
// this is talk-side, so we treat an idle-hibernated/stopped well as
// expected and transparently wake it. /wake first (preserves saved RAM
// state for Tier 2 hibernated members), /start as fallback (Tier 4 stopped).
async function ensureWellRunningForTalk(wellName: string): Promise<void> {
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  const token = await wellsToken();
  const info = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.json()).catch(() => null);
  if (info?.status === "running" && info?.ip && await tcpProbe(info.ip, 22)) {
    return; // already serving
  }
  // Same path as `cells wake` (cmdWake): `well start -s <wellName>`. The
  // well CLI handles BOTH hibernated wells (resume from saved RAM) and
  // cold-stopped wells (cold boot), and blocks until SSH-accept is ready.
  // Previously this function rolled its own /wake + 3s sleep + /start
  // fallback + 1s SSH polling, which added ~6s of overhead vs the explicit
  // wake-then-talk path. Using `well start` collapses talk-auto-wake from
  // ~8.2s → ~2.2s (matches explicit two-step).
  try {
    await $`well start -s ${wellName}`.quiet();
  } catch (e) {
    throw new Error(
      `ensureWellRunningForTalk: 'well start -s ${wellName}' failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // Defensive verify: confirm SSH-accept on the well's IP. `well start`
  // should have already gated on this, but a short tight-poll catches the
  // edge case where it returned slightly early.
  const deadline = Date.now() + 5_000;
  let last: any = null;
  while (Date.now() < deadline) {
    const i = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).catch(() => null);
    last = i;
    if (i?.status === "running" && i?.ip && await tcpProbe(i.ip, 22)) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(
    `ensureWellRunningForTalk: '${wellName}' not SSH-ready 5s post-start (last: status=${last?.status} ip=${last?.ip})`,
  );
}

async function tcpProbe(host: string, port: number): Promise<boolean> {
  try {
    const sock = await Bun.connect({
      hostname: host,
      port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    sock.end();
    return true;
  } catch {
    return false;
  }
}

async function ensureWellHasIp(wellName: string): Promise<void> {
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  const token = await wellsToken();
  const info = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.json()).catch(() => null);
  if (info?.ip) return; // already good
  // Cycle the VM to refresh DHCP.
  await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  const sr = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!sr.ok) {
    throw new Error(`ensureWellHasIp: /start '${wellName}' failed: ${sr.status} ${(await sr.text()).slice(0, 200)}`);
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const i2 = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).catch(() => null);
    if (i2?.ip) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`ensureWellHasIp: '${wellName}' never got an IP within 30s after restart`);
}

// Strip the real ANTHROPIC_API_KEY out of a well's /etc/environment.
// The generic egg bakes every provider key in (it's harness-agnostic —
// see collectCellLlmEnv), but claude-code and codex cells reach their LLM
// only through proxy.cells.md and never touch the paid Anthropic key.
// Left baked in, it's a latent secret on a coding-agent VM with no
// legitimate use for it — readable by every process, not just login
// shells (the env shim's `unset` only covers login shells). Run at birth
// for every harness: pi + anthropic now rides the Max sub via the proxy
// too (same as claude-code), so no cell has a use for the paid key.
async function stripAnthropicKeyFromWell(wellName: string): Promise<void> {
  const r = await wellExecCapture(
    wellName,
    `sudo sed -i '/^ANTHROPIC_API_KEY=/d' /etc/environment && ` +
      `! grep -q '^ANTHROPIC_API_KEY=' /etc/environment && echo STRIPPED`,
  );
  if (!r.ok || !r.stdout.includes("STRIPPED")) {
    throw new Error(
      `strip ANTHROPIC_API_KEY from '${wellName}' failed: ${(r.stderr + r.stdout).slice(-200)}`,
    );
  }
}

// Claim one open generic egg from the pool. Atomically flips it to
// "claimed" in pool.json and returns its well-name, tier, and id (the egg
// hex suffix, which becomes the cell's `hatched_from`). Returns null if the
// pool is empty — the caller errors out, since birth is pool-only.
async function claimGenericEgg(
  cellName: string,
): Promise<{ wellName: string; tier: 2 | 4; id: string } | null> {
  let chosen: { wellName: string; tier: 2 | 4; id: string } | null = null;
  await withPoolLock(async () => {
    const file = await loadPool();
    // Prefer running members first — they're instant-consume. Fall
    // back to a hibernated egg only when no running egg is available.
    const egg =
      file.members.find(
        (e) =>
          e.state === "open" &&
          e.variant_signature === V1_POOL_VARIANT_SIGNATURE &&
          (e as any).tier === 4,
      ) ??
      file.members.find(
        (e) => e.state === "open" && e.variant_signature === V1_POOL_VARIANT_SIGNATURE,
      );
    if (!egg) return;
    egg.state = "claimed";
    egg.claimed_at = new Date().toISOString();
    egg.claimed_by = cellName;
    chosen = {
      wellName: egg.well_name,
      tier: ((egg as any).tier ?? 2) as 2 | 4,
      id: egg.well_name.slice("egg-".length),
    };
    await savePool(file);
  });
  return chosen;
}

// Resume an egg to running state. The right endpoint depends on prior state:
//   - Tier 4, currently running: no-op (already up)
//   - Tier 4, currently stopped (welld restart killed it): /start
//   - Tier 2, hibernated: /wake (restores RAM from disk in ~2-3s)
async function wakePoolMember(wellName: string, tier: 2 | 4 = 2): Promise<void> {
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  if (tier === 4) {
    const info = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}`, {
      headers: { Authorization: `Bearer ${await wellsToken()}` },
    }).then(r => r.json()).catch(() => null);
    if (info?.status === "running") return; // already up, no-op
    // welld bounce stopped the VM — use /start (not /wake, which is for hibernated).
    const sr = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await wellsToken()}` },
    });
    if (!sr.ok) {
      throw new Error(`start '${wellName}' failed: ${sr.status} ${(await sr.text()).slice(0, 300)}`);
    }
    return;
  }
  const r = await fetch(
    `${base}/v1/wells/${encodeURIComponent(wellName)}/wake`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${await wellsToken()}` },
    },
  );
  if (!r.ok) {
    throw new Error(
      `wake '${wellName}' failed: ${r.status} ${(await r.text()).slice(0, 300)}`,
    );
  }
}

// Poll SSH until the well answers a noop, up to timeoutMs. Defence-in-depth
// behind wells's wake post-condition (welld 42b225d, 2026-05-23): welld's
// /wake now blocks up to 10s waiting for TCP port 22 to SYN-ACK before
// returning. So in the happy path our first SSH attempt succeeds immediately
// (~1s round-trip, zero overhead). This loop only does real work if (a)
// wells's wake-probe regresses, or (b) we hit the narrow gap between TCP
// being reachable (their check) and SSH key-exchange being ready (our
// check) — sub-second in practice.
//
// Timeout was 15s pre-welld-42b225d when this layer was load-bearing;
// dropped to 5s since the upstream wake post-condition makes a 10s+ wait
// here genuinely pathological (likely the well is broken, not waking).
// Poll interval is short (500ms) so a guest that's ready in 1s costs ~1
// SSH round-trip, not a wasted wait. Returns silently on first success;
// throws with the last error if the deadline lapses.
async function waitForSshReady(wellName: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no attempt yet";
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    const r = await wellExecCapture(wellName, "true", { user: "root" });
    if (r.ok) return;
    lastErr = (r.stderr + r.stdout).slice(0, 200).trim();
    // Short sleep between attempts. 500ms is a good middle ground: fast
    // enough that a ready-in-1s guest costs only 1-2 round trips, slow
    // enough not to hammer welld/SSH if the guest is genuinely down.
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(
    `ssh never ready for '${wellName}' within ${timeoutMs}ms (${attempts} attempts); last: ${lastErr}`,
  );
}

// Wake-validate a just-baked egg. Goal: prove the freshly-cooked state can
// actually be resumed, BEFORE we mark it "open" and let claim hand it out.
// Mirrors what birth does on claim (wake + ensure IP + SSH-touch) so a pass
// here is a strong guarantee the next real birth will succeed.
//
// Steady state on success:
//   Tier 2: hibernated (we wake, probe, then re-hibernate).
//   Tier 4: running (no state change — we only probe SSH).
// Throws on any failure with a message naming the failed step.
async function validateBakedEgg(wellName: string, tier: 2 | 4): Promise<void> {
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";

  if (tier === 2) {
    // Wake the just-hibernated egg. wakePoolMember POSTs /wake and waits
    // for welld to acknowledge — but doesn't itself wait for the VM to be
    // network-reachable; that's ensureWellHasIp's job below.
    await wakePoolMember(wellName, 2);
  }

  // welld must hand us an IP. ensureWellHasIp will cycle (stop/start) if
  // the well doesn't already have one — same recovery path birth uses.
  await ensureWellHasIp(wellName);

  // The real proof: SSH a noop. Use the polling probe so a guest that's
  // still finishing its network init in the ~1-5s after VZ restore
  // doesn't get incorrectly marked as broken. Only a genuinely wedged
  // wake (qemu crash, hibernate.bin rot, vmnet anomaly) blows past 15s.
  await waitForSshReady(wellName);

  if (tier === 2) {
    // Re-hibernate so the pool member ends up in its expected steady
    // state — same disk-only snapshot we just validated, ready for the
    // next /wake. /hibernate failure here is a real failure of the
    // validation: we know the wake worked, but we can no longer trust
    // the re-snapshot's wake-ability.
    const rh = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}/hibernate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await wellsToken()}` },
    });
    if (!rh.ok) {
      throw new Error(
        `post-validate re-hibernate failed: ${rh.status} ${(await rh.text()).slice(0, 200)}`,
      );
    }
  }
}

// Infer which bakePoolMember stage threw from the rewrapped error message.
// Every per-step catch in bakePoolMember tags its rethrow with a recognizable
// "<step> failed" phrase; this just maps phrase → short stage tag so the JSON
// log groups cleanly.
function inferBakeFailureStage(msg: string): string {
  if (/well create failed/i.test(msg)) return "create";
  if (/waitForCloudInit failed/i.test(msg)) return "firstboot";
  if (/provisioning failed/i.test(msg)) return "provision";
  if (/seal failed/i.test(msg)) return "seal";
  if (/hibernate failed/i.test(msg)) return "hibernate";
  if (/validation failed/i.test(msg)) return "validate";
  return "unknown";
}

// Forensic dump for a bake that failed at any stage. Lands under
// ~/.cells/logs/bake-failures/<well>-<ts>.json so we can pattern-match across
// many bakes without standing up a daemon (per the "agent-first, not static
// services" rule — pattern-watching belongs in pulse or its own agent loop,
// not in the bake hot path). Best-effort: never throws — the caller is
// already in a failure branch and needs to clean up.
//
// MUST run BEFORE directWellDestroy: stage-specific diagnostics like the seal
// stage's lsof on disk.img + live com.apple.Virtualization PIDs only have
// signal while the failed-state files and processes still exist.
async function captureBakeFailure(
  wellName: string,
  tier: 2 | 4,
  err: Error,
): Promise<void> {
  try {
    const dir = join(homedir(), ".cells", "logs", "bake-failures");
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString();
    const stage = inferBakeFailureStage(err.message);
    const out: Record<string, unknown> = {
      well_name: wellName,
      tier,
      ts,
      stage,
      error: err.message,
      stack: err.stack,
    };

    // welld's snapshot at failure time — status, IP, age, uuid. Lets us
    // see whether welld thinks the well is up/down/wedged.
    try {
      const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
      const r = await fetch(`${base}/v1/wells/${encodeURIComponent(wellName)}`, {
        headers: { Authorization: `Bearer ${await wellsToken()}` },
      });
      out.welld_http_status = r.status;
      out.welld_info = await r.json().catch(() => null);
    } catch (e) {
      out.welld_info_err = String(e);
    }

    // Stage-specific diagnostics. Today: just seal. Wells 2026-05-23 asked
    // for `lsof -nP <disk.img>` + any live com.apple.Virtualization PIDs at
    // the moment of "disk still held within 60000ms" to distinguish a halt-
    // before-VZ-released-handle race from a post-welld-bounce orphan VZ XPC.
    if (stage === "seal") {
      const diskImg = `/Users/pete/.lume/${wellName}/disk.img`;
      try {
        const lsof = Bun.spawn(["lsof", "-nP", diskImg], { stdout: "pipe", stderr: "pipe" });
        const o = await new Response(lsof.stdout).text();
        const e2 = await new Response(lsof.stderr).text();
        await lsof.exited;
        out.lsof_disk_img = o.trim() || e2.trim() || "(no output — file may not exist)";
      } catch (e) {
        out.lsof_err = String(e);
      }
      try {
        const pg = Bun.spawn(["pgrep", "-fl", "com.apple.Virtualization"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        out.virtualization_procs = (await new Response(pg.stdout).text()).trim();
        await pg.exited;
      } catch (e) {
        out.virtualization_procs_err = String(e);
      }
    }

    const safeStamp = ts.replace(/[:.]/g, "-");
    const path = join(dir, `${wellName}-${safeStamp}.json`);
    await writeFile(path, JSON.stringify(out, null, 2) + "\n");
    console.warn(`! bake-failure log: ${path} (stage=${stage})`);
  } catch {
    // Best-effort. Failing to write a log shouldn't escalate.
  }
}

// Mark a consumed pool member as "live" (now a cell). Bookkeeping for the pool
// file — the egg's well is now serving as a cell's backing well.
async function markPoolMemberLive(wellName: string): Promise<void> {
  await withPoolLock(async () => {
    const file = await loadPool();
    const egg = file.members.find((e) => e.well_name === wellName);
    if (!egg) return;
    egg.state = "live";
    await savePool(file);
  });
}

// V1_POOL_TARGET_DEPTH and countOpenPoolMembers() are now canonical in
// ./lib/pool — imported above.

// Promote a hibernated egg to running. Faster than baking a fresh
// running egg from scratch: just /wake the well and update its tier
// marker. The well was created with hibernate_ready: true, but keeping it
// running (never re-hibernating) is fine — that flag is only consulted by
// wells when /hibernate is called. Returns true if an egg was promoted.
async function promoteOneHibernatedToRunning(): Promise<boolean> {
  type Target = { wellName: string; cellName: string };
  let target: Target | null = null;
  await withPoolLock(async () => {
    const file = await loadPool();
    const hibernated = file.members.find(
      (e) =>
        e.state === "open" &&
        e.variant_signature === V1_POOL_VARIANT_SIGNATURE &&
        (e as any).tier === 2,
    );
    if (!hibernated) return;
    target = {
      wellName: hibernated.well_name,
      cellName: (hibernated as any).cell_name ?? "cell-" + hibernated.well_name.slice("egg-".length),
    };
  });
  const t = target as Target | null;
  if (!t) return false;

  // Wake the hibernated egg. /wake restores RAM from disk (~2-3s). After
  // this the well is in `running` state and we leave it there.
  try {
    await wakePoolMember(t.wellName, 2);
  } catch (e) {
    console.warn(
      `! promote hibernated→running failed for ${t.wellName}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }

  // Flip the tier marker. From here on, consume + dashboard treat it as running.
  await withPoolLock(async () => {
    const file = await loadPool();
    const egg = file.members.find((e) => e.well_name === t.wellName);
    if (egg) {
      (egg as any).tier = 4;
      await savePool(file);
    }
  });
  return true;
}

// Is the DNA that auto-heal might push committed (clean)? Gates the
// AUTOMATIC DNA-rev actions — the reconcile stale-rev cull and the steward's
// auto-refresh — so an in-progress edit can't shift the rev and stampede the
// pool/fleet to chase uncommitted code. Visibility is never gated (the doctor
// shows drift regardless); only the destroy/refresh side effects wait for a
// clean tree. Conservative on any git error: returns false (pause auto-heal)
// rather than risk acting on an unknown state.
//
// Covers BOTH dna/cells/base AND dna/specials: a special's refresh overlays
// dna/specials/<name> on top of base, so uncommitted special runtime files
// would be pushed by an auto-refresh of a stale special (mother/pulse). The
// rev itself is base-only, but the clean GATE must cover everything a refresh
// would write. (Slightly conservative for the pool cull — a dirty special
// tree pauses generic-egg culling too — but pausing on any uncommitted DNA is
// the safe direction.) Memoized — the tree doesn't change mid-run.
let _dnaTreeCleanCache: boolean | null = null;
function dnaTreeClean(): boolean {
  if (_dnaTreeCleanCache !== null) return _dnaTreeCleanCache;
  try {
    const out = execSync("git status --porcelain -- dna/cells/base dna/specials", {
      cwd: REPO_ROOT,
    }).toString().trim();
    _dnaTreeCleanCache = out.length === 0;
  } catch {
    _dnaTreeCleanCache = false;
  }
  return _dnaTreeCleanCache;
}

// ─── reconcilePool ────────────────────────────────────────────────────
// Diffs pool.json against welld's actual state. Evicts members welld
// no longer knows about (W.68 class: pool says open, welld has no bundle)
// and tier-4 running members welld reports stopped (bobby class: welld
// bounce stopped the running well, no hibernate.bin to /wake from). Then
// culls open members above target depth (the pool's only shrink path —
// refill never removes), and background-triggers refill after eviction.
//
// Why this exists: today's bobby stall was state drift — wells bounced
// to pick up the splites→wells rename, all tier-4 pool VMs went to
// `stopped`, but cells's pool.json still said open/tier-4. claimV1PoolMember
// picked the stale entry and downstream timing collapsed. Reconcile is the
// answer: pool.json reflects welld's truth, not last-known-good.
//
// Safe to call frequently. Cheap when pool is healthy (1 HTTP call). Skips
// eviction when welld is unreachable or /healthz reports degraded — we
// don't want to nuke the pool during a substrate flap.

type ReconcileReport = {
  checked_at: string;
  pool_size_before: number;
  welld_known: number;
  evicted: { id: string; well_name: string; reason: string }[];
  culled: { id: string; well_name: string }[];
  stale_culled: { id: string; well_name: string; rev: string }[];
  resealed: { id: string; well_name: string }[];
  unrecoverable: { id: string; well_name: string; reason: string }[];
  pool_size_after: number;
  refill_triggered: boolean;
  errors: string[];
};

async function reconcilePool(
  opts: { silent?: boolean; skipRefill?: boolean } = {},
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    checked_at: new Date().toISOString(),
    pool_size_before: 0,
    welld_known: 0,
    evicted: [],
    culled: [],
    stale_culled: [],
    resealed: [],
    unrecoverable: [],
    pool_size_after: 0,
    refill_triggered: false,
    errors: [],
  };

  const before = await loadPool();
  report.pool_size_before = before.members.length;
  if (before.members.length === 0) {
    report.pool_size_after = 0;
    return report;
  }

  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";

  // /healthz: back-off signal. No auth required.
  let healthz: any = null;
  try {
    const h = await fetch(`${base}/healthz`);
    if (h.ok) healthz = await h.json();
  } catch (e: any) {
    report.errors.push(`healthz unreachable: ${e?.message ?? e}`);
  }
  if (!healthz) {
    report.pool_size_after = report.pool_size_before;
    return report; // welld down — no-op, not a drift signal
  }
  if (healthz.degraded === true) {
    report.errors.push("welld degraded; reconcile skipped");
    report.pool_size_after = report.pool_size_before;
    return report;
  }

  // GET /v1/wells: the authoritative welld view.
  let welldRows: { name: string; status: string }[] = [];
  try {
    const token = await wellsToken();
    const r = await fetch(`${base}/v1/wells`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      report.errors.push(`/v1/wells → ${r.status}`);
      report.pool_size_after = report.pool_size_before;
      return report;
    }
    const body = await r.json();
    welldRows = (Array.isArray(body?.wells) ? body.wells : [])
      .filter((w: any) => typeof w?.name === "string")
      .map((w: any) => ({ name: String(w.name), status: String(w.status ?? "") }));
  } catch (e: any) {
    report.errors.push(`/v1/wells fetch failed: ${e?.message ?? e}`);
    report.pool_size_after = report.pool_size_before;
    return report;
  }
  report.welld_known = welldRows.length;

  // Mutate pool.json under lock. Re-read inside the lock to avoid TOCTOU
  // against a concurrent bake/claim that mutated pool.json after our
  // outer load above.
  await withPoolLock(async () => {
    const file = await loadPool();
    const plan = planReconcileEvictions(file.members, welldRows);
    if (plan.evicted.length > 0) {
      file.members = plan.keep;
      await savePool(file);
    }
    report.evicted = plan.evicted;
    report.pool_size_after = plan.keep.length;
  });

  // Cull pass: trim open members above target depth. Refill only ever
  // *adds* (top up to target), so without a shrink path the pool can only
  // grow — a stale count or a double-refill lets it run away (it reached
  // 42 once against a target of 5). Oldest open eggs go first: age is the
  // best staleness proxy. Never touches claimed/live members — those are
  // cells, not spare eggs.
  let cullVictims: PoolMember[] = [];
  {
    const file = await loadPool();
    const open = file.members
      .filter((m) => m.state === "open" && m.variant_signature === V1_POOL_VARIANT_SIGNATURE)
      .sort((a, b) => Date.parse(a.born_at) - Date.parse(b.born_at)); // oldest first
    const excess = open.length - V1_POOL_TARGET_DEPTH;
    if (excess > 0) cullVictims = open.slice(0, excess);
  }
  for (const v of cullVictims) {
    // Re-check under lock — skip if it got claimed since we picked victims.
    let stillOpen = false;
    await withPoolLock(async () => {
      const m = (await loadPool()).members.find((x) => x.id === v.id);
      stillOpen = !!m && m.state === "open";
    });
    if (!stillOpen) continue;
    await directWellDestroy(v.well_name).catch(() => {});
    await withPoolLock(async () => {
      const f = await loadPool();
      f.members = f.members.filter((x) => x.id !== v.id);
      await savePool(f);
    });
    report.culled.push({ id: v.id, well_name: v.well_name });
  }
  report.pool_size_after -= report.culled.length;

  // Stale-rev cull pass: retire open eggs carrying old platform code so the
  // pool rotates toward the current runtime DNA instead of handing births a
  // stale supervisor/lib (the "pre-merge egg ships stale code" class). Gated
  // on a CLEAN working tree: an uncommitted edit to a sync file would shift
  // the computed rev and make every committed-rev egg look stale — auto-
  // evicting the whole pool to chase a dirty tree. Visibility (doctor) still
  // shows drift on a dirty tree; only the automatic destroy waits for clean.
  // Capped + floored (cli/lib/reconcile.ts) so a big rev jump rotates over a
  // few passes and never empties the pool mid-rebake. Refill (below) bakes
  // the replacements at the current rev.
  if (dnaTreeClean()) {
    const currentRev = dnaRev(DNA_DIR);
    let staleVictims: PoolMember[] = [];
    {
      const file = await loadPool();
      const open = file.members.filter(
        (m) => m.state === "open" && m.variant_signature === V1_POOL_VARIANT_SIGNATURE,
      );
      staleVictims = selectStaleRevCull(open, currentRev, { cap: 2, floor: 2 });
    }
    for (const v of staleVictims) {
      let stillOpen = false;
      await withPoolLock(async () => {
        const m = (await loadPool()).members.find((x) => x.id === v.id);
        stillOpen = !!m && m.state === "open";
      });
      if (!stillOpen) continue;
      await directWellDestroy(v.well_name).catch(() => {});
      await withPoolLock(async () => {
        const f = await loadPool();
        f.members = f.members.filter((x) => x.id !== v.id);
        await savePool(f);
      });
      report.stale_culled.push({ id: v.id, well_name: v.well_name, rev: v.dna_rev ?? "" });
    }
    report.pool_size_after -= report.stale_culled.length;
  }

  // hibernate_ready recheck: covers welld transition-storm clears that
  // leave a successfully-sealed pool member with hibernate_ready=false
  // (see the existing note at sealWell's ensureHibernateReady — we
  // observed this on egg-0f7d66 once, and again on egg-711295
  // 2026-05-24 after the wells bounce earlier that day).  When this
  // happens, claim → ensureHibernateReady would re-seal at birth time,
  // but the egg in the meantime is poison: it can't be hibernated, so
  // /hibernate-driven flows (sleep, cull, restart) fail against it.
  // Re-seal here instead, before any of those callers hit it.  Re-seal
  // throws if the well is genuinely unrecoverable; treat that as an
  // eviction.
  {
    const file = await loadPool();
    const open = file.members.filter(
      (m) => m.state === "open" && m.variant_signature === V1_POOL_VARIANT_SIGNATURE,
    );
    for (const m of open) {
      try {
        const ready = await readHibernateReady(m.well_name);
        if (!needsSeal(ready)) continue;
        await sealWell(m.well_name);
        report.resealed.push({ id: m.id, well_name: m.well_name });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await directWellDestroy(m.well_name).catch(() => {});
        await withPoolLock(async () => {
          const f = await loadPool();
          f.members = f.members.filter((x) => x.id !== m.id);
          await savePool(f);
        });
        report.unrecoverable.push({ id: m.id, well_name: m.well_name, reason });
        report.pool_size_after -= 1;
      }
    }
  }

  // Background refill — fire and forget, don't make the caller wait.
  // Trigger when ANY shrink happened (stale eviction, over-target cull,
  // unrecoverable reseal eviction) so the pool gets back to depth.
  const shrank =
    report.evicted.length > 0 ||
    report.culled.length > 0 ||
    report.stale_culled.length > 0 ||
    report.unrecoverable.length > 0;
  // Single-flight: don't stack a reconcile-triggered refill on top of one
  // already running (the steward's depth-block fires `cells pool refill`
  // separately, and a stale-rev cull here would otherwise trigger a second
  // concurrent bake loop — two refills racing welld). isRefillInFlight()
  // sees the separate `cells.ts pool refill` process; if one's up, let it
  // top the pool back up instead of starting a rival.
  if (shrank && !opts.skipRefill && !(await isRefillInFlight())) {
    report.refill_triggered = true;
    refillPoolToDepth().catch((e) => {
      if (!opts.silent) {
        console.error(`reconcile-triggered refill failed: ${e?.message ?? e}`);
      }
    });
  }

  if (
    !opts.silent &&
    (report.evicted.length > 0 ||
      report.culled.length > 0 ||
      report.stale_culled.length > 0 ||
      report.resealed.length > 0 ||
      report.unrecoverable.length > 0)
  ) {
    const parts: string[] = [];
    if (report.evicted.length > 0) parts.push(`evicted ${report.evicted.length} stale`);
    if (report.culled.length > 0) parts.push(`culled ${report.culled.length} over-target`);
    if (report.stale_culled.length > 0) parts.push(`culled ${report.stale_culled.length} stale-rev`);
    if (report.resealed.length > 0) parts.push(`resealed ${report.resealed.length}`);
    if (report.unrecoverable.length > 0) parts.push(`dropped ${report.unrecoverable.length} unrecoverable`);
    console.error(
      `pool reconcile: ${parts.join(", ")} member(s); ` +
        `pool ${report.pool_size_before} → ${report.pool_size_after}` +
        (report.refill_triggered ? " (refill triggered)" : ""),
    );
  }
  return report;
}

// Refill the v1 pool to the target depth.
// Two-pass strategy:
//   1. Promote hibernated→running until the running count is at
//      V1_RUNNING_POOL_TARGET. Promote is fast (~3s, just /wake) so the
//      running buffer replenishes quickly after a consume.
//   2. Bake new hibernated pool members serially until total pool is at
//      target. Bake is slower (~30s/egg).
// Serial bakes are required: wells's mother concurrency limit + welld
// traffic stability. Returns the number of members baked (does not count
// promotions).
// Single-flight wrapper. Fired fire-and-forget from several triggers in
// possibly-different processes; without coalescing they run concurrent bake
// loops that oversubscribe the host (the seal-contention root) and overshoot
// target. A refill that finds another already running SKIPS — the live one
// already drives the pool to target. See cli/lib/refill-lock.ts.
async function refillPoolToDepth(target: number = V1_POOL_TARGET_DEPTH): Promise<number> {
  if (!tryAcquireRefillLock()) {
    const h = refillLockHolder();
    console.error(`  (refill already in progress${h?.pid ? ` (pid ${h.pid})` : ""} — skipping)`);
    return 0;
  }
  try {
    return await refillPoolToDepthInner(target);
  } finally {
    releaseRefillLock();
  }
}

async function refillPoolToDepthInner(target: number = V1_POOL_TARGET_DEPTH): Promise<number> {
  // Pass 1: promote hibernated→running until the running count is at
  // target. Caps at the smaller of (running target, current pool size) —
  // never promotes more than exists to promote.
  while (true) {
    const running = await countRunningPoolMembers();
    if (running >= V1_RUNNING_POOL_TARGET) break;
    const hibernated = await countHibernatedPoolMembers();
    if (hibernated === 0) break;
    const ok = await promoteOneHibernatedToRunning();
    if (!ok) break;
  }

  // Pass 2: bake fresh hibernated pool members until total pool is at
  // depth target. bakePoolMember() decides the tier internally.
  let baked = 0;
  while ((await countOpenPoolMembers()) < target) {
    try {
      await bakePoolMember();
      baked++;
    } catch (e) {
      console.warn(`! v1 egg bake failed: ${e instanceof Error ? e.message : String(e)}`);
      break; // don't loop forever if welld is sick
    }
  }
  return baked;
}

// Destroy a well directly via the well CLI, bypassing the mother
// agent. Safety net for when mother dies mid-destroy or mid-birth — the
// well may be live but our mother-driven path has no way to clean it
// up. Idempotent: 'well not found' counts as success.
async function directWellDestroy(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["well", "destroy", name, "--force"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code === 0) return true;
    const err = await new Response(proc.stderr).text();
    if (/well not found|already destroyed|not found/i.test(err)) return true;
    console.warn(`! direct well destroy '${name}' failed (exit ${code}): ${err.slice(0, 200)}`);
    return false;
  } catch (e) {
    console.warn(`! direct well destroy '${name}' threw: ${e}`);
    return false;
  }
}

async function cmdDestroyOne(name: string): Promise<boolean> {
  // Teardown is pure deterministic CLI work — no mother. Birth routes
  // through mother because configuring a cell is open-ended; killing one
  // isn't. We resolve the well locally (wellNameForCell reads cells.json +
  // pool.json — the same lookup mother's old cell-destroy prompt did via
  // cell_resolve), destroy it via the well CLI, then sweep local state.
  const wellName = await wellNameForCell(name);
  const destroyOk = await directWellDestroy(wellName);

  // Local cleanup — always runs, even if the well destroy reported a
  // failure, so a half-gone cell doesn't strand registry/channel/vault
  // state. Each helper is best-effort with internal existsSync/try-catch.
  const killedCell = findCellIn((await loadRegistry()).cells, name);
  // The well is already destroyed above — a registry-lock failure here must NOT
  // abort the rest of teardown (channels/vault/worker/pool), or we'd strand a
  // phantom entry pointing at a gone well AND orphan its side state. Best-effort
  // + continue; re-running kill clears the entry (destroy is idempotent).
  await mutateRegistry((cells) => removeCell(cells, name)).catch((e) =>
    console.warn(`note: registry removal for ${name} failed (${e instanceof Error ? e.message : String(e)}); continuing teardown — re-run \`cells kill ${name}\` to clear the entry`),
  );
  await evictPulseStateForCell(name, killedCell?.project);
  // If we just killed a PROJECT pulse, fail its cells back to the global pulse:
  // they were evicted from global when this pulse was born, so they'd otherwise
  // go dark. (Best-effort; a crash that skips this path → `cells heartbeat
  // reseed <project>`.)
  if (killedCell && isPulseName(name)) {
    const deadProject = projectOfPulse(name);
    if (deadProject) await failbackProjectPulse(deadProject).catch((e) =>
      console.warn(`! failback for ${deadProject} failed (${e instanceof Error ? e.message : String(e)})`));
  }
  await archiveSlackChannelsForCell(name);
  await evictChannelBindingsForCell(name);
  await deleteCellWorker(name);
  await removeVaultEntry(name);
  // Drop the postwork status file so orphans don't accumulate across
  // kill/birth cycles for cells reusing the same name.
  await removePostwork(name);

  // If this was a hatched cell, the cell's well IS the egg's well.
  // It just got destroyed above, so the pool.json entry is now stale.
  // Remove it so `cells pool list` doesn't show a phantom "live" entry.
  if (killedCell?.hatched_from) {
    await withPoolLock(async () => {
      const f = await loadPool();
      f.members = f.members.filter((e) => e.id !== killedCell.hatched_from);
      await savePool(f);
    });
  }

  // Journal the teardown. Birth appends a `born` line via mother's
  // cell-create prompt; mirror that here so the activity log stays a
  // complete birth/death record. Best-effort — never fail a kill on this.
  if (destroyOk && killedCell) {
    try {
      const activityFile = join(MOTHER_ROOT, "state/memory/project_cells_activity.md");
      if (existsSync(activityFile)) {
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        await appendFile(activityFile, `${stamp}  destroyed   ${name}\n`);
      }
    } catch {
      /* best-effort journal */
    }
  }

  // Death-log entry for mother.cells.md fleet timeline. Same shape as
  // birth-log so the proxy can merge both chronologically. Best-effort.
  try {
    const deathDir = join(homedir(), ".cells", "death-log");
    await mkdir(deathDir, { recursive: true });
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const file = join(deathDir, `${name}-${stamp}.json`);
    await writeFile(file, JSON.stringify({
      kind: "death",
      name,
      killed_at: new Date().toISOString(),
      model: killedCell?.modelChain?.[0] ?? null,
      harness: killedCell?.harness ?? null,
      born_at: killedCell?.created_at ?? null,
      destroyOk,
    }, null, 2));
  } catch { /* best-effort timeline */ }

  return destroyOk;
}

// Remove the cell's Obsidian vault dir (created by cmdSync at birth) and
// refresh the top-level README roster so the destroyed cell stops showing
// in the index. Best-effort — vault sync isn't load-bearing.
async function removeVaultEntry(name: string): Promise<void> {
  const dir = join(VAULT_DIR, name);
  if (existsSync(dir)) {
    try {
      await rm(dir, { recursive: true, force: true });
      console.log(`✓ removed vault entry ${name}`);
    } catch (e) {
      console.warn(`! vault remove failed for ${name}: ${e}`);
    }
  }
  // Best-effort roster refresh. If the vault dir is missing entirely
  // (vault never set up), skip silently.
  if (!existsSync(VAULT_DIR)) return;
  try {
    const reg = await loadRegistry();
    const rows = await Promise.all(
      reg.cells.map(async (c) => {
        const info = await getWellInfo(c.name).catch(() => null);
        return { name: c.name, status: info?.status ?? "?", lastRunningAt: info?.last_running_at ?? null };
      }),
    );
    await writeRoster(rows);
  } catch { /* best-effort */ }
}

async function archiveSlackChannelsForCell(name: string): Promise<void> {
  if (!existsSync(CHANNELS_PATH)) return;
  let bindings: Record<string, { cell: string; kind: string }>;
  try {
    bindings = (await loadChannels()).bindings;
  } catch {
    return;
  }
  const slackIds = Object.entries(bindings)
    .filter(([, b]) => b.cell === name && b.kind === "slack")
    .map(([id]) => id);
  if (slackIds.length === 0) return;
  const token = await readSecret("SLACK_BOT_TOKEN");
  if (!token) {
    console.warn(`! SLACK_BOT_TOKEN missing — leaving ${slackIds.length} Slack channel(s) live`);
    return;
  }
  for (const channel of slackIds) {
    try {
      const r = await fetch("https://slack.com/api/conversations.archive", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      // already_archived is fine; not_in_channel means we lost membership
      // somewhere — channel is still live, log and move on.
      if (!j.ok && j.error !== "already_archived") {
        console.warn(`! archive ${channel} failed: ${j.error ?? "unknown"}`);
      } else {
        console.log(`✓ archived slack channel ${channel}`);
      }
    } catch (e) {
      console.warn(`! archive ${channel} failed: ${e}`);
    }
  }
}

async function deleteCellWorker(name: string): Promise<void> {
  // wrangler delete needs the rendered config (same template the deploy
  // script produces). Reuse the template inline since the deploy script
  // is single-purpose for "deploy."
  const template = join(REPO_ROOT, "cli/worker/cell/wrangler.toml");
  if (!existsSync(template)) return;
  try {
    const tpl = await readFile(template, "utf-8");
    // WELL_HOST doesn't matter for delete, but the placeholder must be
    // substituted or wrangler chokes on the unrendered TOML.
    const rendered = tpl.replaceAll("{{CELL}}", name).replaceAll("{{WELL_HOST}}", "ignored.wells.app");
    const renderedPath = join(REPO_ROOT, "cli/worker/cell", `.wrangler.${name}.toml`);
    await Bun.write(renderedPath, rendered);
    try {
      const proc = Bun.spawn(["bunx", "wrangler", "delete", "--config", renderedPath], {
        cwd: join(REPO_ROOT, "cli/worker/cell"),
        stdin: new TextEncoder().encode("y\n"), // confirm prompt
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        // service_not_found is fine — already gone.
        if (!/Couldn'?t find a Worker|10007|not found/i.test(err)) {
          console.warn(`! worker delete failed (exit ${code})`);
        }
      } else {
        console.log(`✓ deleted cells-front-${name}`);
      }
    } finally {
      try { await unlink(renderedPath); } catch { /* best-effort */ }
    }
  } catch (e) {
    console.warn(`! worker delete failed: ${e}`);
  }
}

// ─── pulse handoff primitives (project-pulse birth / death / retag) ────────
//
// A pulse owns a continuous schedule table (pulse-cache/<cell>.json + a cron
// block per cell). When a cell moves between pulses — a <project>-pulse is born
// (global → project), dies (project → global), or a cell is retagged — its
// schedule must move with it, exactly once. These small deterministic helpers
// are the moving parts; the ownership resolver (pulseOwner) decides where.

// ~/.cells/heartbeat-mirror/<cell>.md — the Mac-side freshest-seen HEARTBEAT.md
// for every scheduled cell, written by the proxy on each /heartbeat-changed
// (see cli/proxy.ts). It is the source of truth for re-seeding a cell's
// schedule into a different pulse: fresher than the Obsidian vault snapshot,
// and it never requires waking the cell to read its live file.
const HEARTBEAT_MIRROR_DIR = join(homedir(), ".cells", "heartbeat-mirror");

// The freshest HEARTBEAT.md the Mac has for a cell: the proxy's last-seen
// mirror, falling back to the Obsidian vault. null if neither exists (a cell
// that never posted a schedule since the mirror landed and was never
// vault-synced — handoff then leaves it on its current pulse and warns rather
// than drop the schedule into a gap).
async function readHeartbeatContent(cell: string): Promise<string | null> {
  try {
    return await readFile(join(HEARTBEAT_MIRROR_DIR, `${cell}.md`), "utf-8");
  } catch { /* fall through to vault */ }
  try {
    return await readFile(join(VAULT_DIR, cell, "HEARTBEAT.md"), "utf-8");
  } catch {
    return null;
  }
}

// Seed a cell's HEARTBEAT.md into a pulse well's inbox so that pulse rebuilds
// its schedule on the next tick. Mirrors the proxy's bridgeInboxPulse write
// (the in-well pulse-core is a dumb drainer — the Mac is the sole seeder).
// Content is base64'd so a (cell-authored) HEARTBEAT.md line that happens to
// equal a heredoc delimiter can't truncate the write and run trailing lines as
// root in the pulse well — base64 output is shell-inert.
async function seedPulseInbox(pulseWell: string, cell: string, content: string): Promise<boolean> {
  const b64 = Buffer.from(content, "utf-8").toString("base64");
  const script = `set -euo pipefail
sudo mkdir -p /root/.cells/pulse-inbox
TS=$(date +%s%N)
F=/root/.cells/pulse-inbox/${cell}-$TS.md
printf %s '${b64}' | base64 -d | sudo tee "$F" >/dev/null
echo "$F"`;
  const r = await wellExecCapture(pulseWell, script).catch(() => null);
  return !!r && r.ok;
}

// Drop a cell's schedule from a pulse well: pulse-core's `forget` removes the
// pulse-cache row AND strips its /etc/cron.d/pulse-schedules block, so cron
// stops firing at it. Deterministic, no agent/LLM/fork. Best-effort (returns
// false if the pulse is down).
async function forgetCellFromPulse(pulseWell: string, cell: string): Promise<boolean> {
  const r = await wellExecCapture(pulseWell, `node /root/bin/pulse-core.mjs forget ${cell}`).catch(() => null);
  return !!r && r.ok;
}

// Resolve a cell's owning pulse to a well name (its project's pulse if live,
// else the global pulse), via the shared partition resolver. null if that pulse
// isn't registered (nothing to do). wellNameForCell falls back to the bare name
// for an unregistered cell, so we must gate on the pulse actually existing —
// otherwise a clean kill with no pulse registered fires a doomed `well exec`
// and a false "pulse may be down" warning.
async function owningPulseWell(project: string | undefined, cells: Cell[]): Promise<string | null> {
  const ownerName = pulseOwner(project, cells, process.env.CELLS_PULSE_CELL ?? "pulse");
  if (!findCellIn(cells, ownerName)) return null;
  return await wellNameForCell(ownerName);
}

// Tell the cell's OWNING pulse to forget it on destroy — drops its schedule
// cache, prunes lastFire entries, clears orphan inbox files, and stops cron
// from firing `cells talk <dead-cell>`. `project` is the killed cell's project
// tag, captured by the caller BEFORE its registry entry is removed (we need it
// to resolve a project cell's pulse). Best-effort + loud: recovery is
//   cells exec <owning-pulse> "node /root/bin/pulse-core.mjs forget <name>"
async function evictPulseStateForCell(name: string, project?: string): Promise<void> {
  const pulseWell = await owningPulseWell(project, (await loadRegistry()).cells);
  if (!pulseWell) return; // owning pulse not in registry — nothing to evict
  if (!(await forgetCellFromPulse(pulseWell, name))) {
    console.warn(`! pulse forget ${name} failed (pulse may be down) — schedule may need manual cleanup`);
  }
}

// Project-pulse BIRTH handoff: move each of the project's cells from the global
// pulse to the freshly-born <project>-pulse, exactly once. For each cell: seed
// it into the new pulse, then forget it from global. Called AFTER promote (so
// the proxy already routes this project's heartbeats here) and BEFORE
// startPulseLoop, so the new pulse holds no cron blocks until its handoff runs.
//
// Critically, we forget from global REGARDLESS of whether the seed succeeded:
// promote already moved ownership, so a cell left on global would double-fire
// forever once it next edits HEARTBEAT.md (the proxy seeds the new pulse too).
// An unseedable cell (uncached content, or a seed error) is dropped instead —
// go-dark until its next edit (which the proxy routes here) or a manual reseed,
// never a permanent double-fire.
async function handoffProjectCellsOnBirth(project: string, newPulseWell: string): Promise<void> {
  const cells = (await loadRegistry()).cells;
  let globalWell: string | null = null;
  try { globalWell = await wellNameForCell(process.env.CELLS_PULSE_CELL ?? "pulse"); } catch { globalWell = null; }
  const targets = projectScheduledCells(project, cells);
  let moved = 0, dropped = 0;
  for (const cell of targets) {
    const content = await readHeartbeatContent(cell);
    const seeded = content != null && (await seedPulseInbox(newPulseWell, cell, content));
    if (globalWell) await forgetCellFromPulse(globalWell, cell);
    if (seeded) { moved++; continue; }
    dropped++;
    console.warn(`  ! ${cell}: ${content == null ? "no cached HEARTBEAT.md" : "seed failed"} — schedule dropped to avoid a double-fire; restore with \`cells sync ${cell} && cells heartbeat reseed ${project}\``);
  }
  console.log(`  handoff: ${moved}/${targets.length} ${project} cells → ${project}-pulse${dropped ? `, ${dropped} dropped (see warnings)` : ""}`);
}

// Project-pulse DEATH failback: a dying <project>-pulse's cells were evicted
// from the global pulse at its birth, so without action they'd go dark. Re-seed
// each project cell's HEARTBEAT.md into the global pulse so it rebuilds their
// cron blocks on its next tick. Clean-kill path; a CRASHED project pulse is
// covered by the manual `cells heartbeat reseed <project>` handle (and, later,
// a steward reconcile — see docs/BACKLOG.md).
async function failbackProjectPulse(project: string): Promise<void> {
  let globalWell: string;
  try { globalWell = await wellNameForCell(process.env.CELLS_PULSE_CELL ?? "pulse"); }
  catch { console.warn(`! global pulse not in registry — ${project} cells' schedules need a manual reseed`); return; }
  const cells = (await loadRegistry()).cells;
  const targets = projectScheduledCells(project, cells);
  if (!targets.length) return;
  let ok = 0, missing = 0;
  for (const cell of targets) {
    const content = await readHeartbeatContent(cell);
    if (content == null) { missing++; continue; }
    if (await seedPulseInbox(globalWell, cell, content)) ok++;
  }
  console.log(`  failed back ${ok}/${targets.length} ${project} cell schedules to the global pulse` +
    (missing ? ` (${missing} uncached — run \`cells sync <cell>\` then \`cells heartbeat reseed ${project}\`)` : ""));
}

async function cmdChannel(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "link":   await cmdChannelLink(rest); break;
    case "unlink": await cmdChannelUnlink(rest); break;
    case "list":   await cmdChannelList(); break;
    case "sync":   await cmdChannelSync(); break;
    default:
      console.error("usage:");
      console.error("  cells channel link <cell> <channel-id-or-address> [--kind=slack|email]");
      console.error("  cells channel unlink <cell> [<channel-id>]");
      console.error("  cells channel list");
      console.error("  cells channel sync                # re-mirror channels.json → KV");
      process.exit(sub ? 1 : 0);
  }
}

async function cmdChannelLink(args: string[]) {
  let kind: ChannelKind = "slack";
  const positional: string[] = [];
  for (const a of args) {
    if (a.startsWith("--kind=")) {
      const v = a.slice("--kind=".length);
      if (v !== "slack" && v !== "email") {
        console.error(`unsupported kind: ${v} (choose: slack | email)`);
        process.exit(1);
      }
      kind = v;
    } else if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    } else positional.push(a);
  }
  let [cell, channelId] = positional;
  if (!cell || !channelId) {
    console.error("usage: cells channel link <cell> <channel-id-or-address> [--kind=slack|email]");
    process.exit(1);
  }
  // For email, the "channel ID" is the address itself. Lowercase it so
  // the regex (and downstream KV key derivation) is consistent regardless
  // of how Pete typed it.
  if (kind === "email") channelId = channelId.toLowerCase();
  await requireCell(cell);
  if (!CHANNEL_ID_PATTERNS[kind].test(channelId)) {
    console.error(`bad channel ID for kind=${kind}: ${channelId} (expected ${CHANNEL_ID_PATTERNS[kind]})`);
    process.exit(1);
  }
  const file = await loadChannels();
  const prev = file.bindings[channelId];
  file.bindings[channelId] = {
    cell,
    kind,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  await saveChannels(file);
  await kvUpsert(kind, channelId, cell);
  await updateCellStatusChannels(cell);
  if (prev && prev.cell !== cell && prev.cell) {
    // Also refresh the previously-bound cell's status so its bar drops the
    // channel that just moved away.
    await updateCellStatusChannels(prev.cell);
  }
  if (prev && prev.cell !== cell) {
    console.log(`linked ${channelId} → ${cell} (${kind}) — was ${prev.cell}`);
  } else if (prev) {
    console.log(`already linked ${channelId} → ${cell} (${kind})`);
  } else {
    console.log(`linked ${channelId} → ${cell} (${kind})`);
  }
}

async function cmdChannelUnlink(args: string[]) {
  const [cell, channelId] = args;
  if (!cell) {
    console.error("usage: cells channel unlink <cell> [<channel-id>]");
    process.exit(1);
  }
  const file = await loadChannels();
  if (channelId) {
    const b = file.bindings[channelId];
    if (!b) {
      console.error(`no binding for ${channelId}`);
      process.exit(1);
    }
    if (b.cell !== cell) {
      console.error(`binding ${channelId} is for ${b.cell}, not ${cell}`);
      process.exit(1);
    }
    const removedKind = b.kind;
    delete file.bindings[channelId];
    await saveChannels(file);
    await kvDelete(removedKind, channelId);
    await updateCellStatusChannels(cell);
    console.log(`unlinked ${channelId} (was ${cell})`);
    return;
  }
  const removed: { id: string; kind: ChannelKind }[] = [];
  for (const [id, b] of Object.entries(file.bindings)) {
    if (b.cell === cell) {
      removed.push({ id, kind: b.kind });
      delete file.bindings[id];
    }
  }
  if (removed.length === 0) {
    console.log(`no bindings for ${cell}`);
    return;
  }
  await saveChannels(file);
  for (const r of removed) await kvDelete(r.kind, r.id);
  await updateCellStatusChannels(cell);
  console.log(`unlinked ${removed.length} channel${removed.length === 1 ? "" : "s"} from ${cell}`);
}

async function cmdChannelList() {
  const file = await loadChannels();
  const entries = Object.entries(file.bindings);
  if (entries.length === 0) {
    console.log("(no channel bindings)");
    return;
  }
  console.log(`${"channel".padEnd(14)} ${"cell".padEnd(14)} ${"kind".padEnd(8)} created`);
  console.log(`${"".padEnd(14, "-")} ${"".padEnd(14, "-")} ${"".padEnd(8, "-")} -------`);
  for (const [id, b] of entries.sort((a, b) => a[1].cell.localeCompare(b[1].cell))) {
    console.log(`${id.padEnd(14)} ${b.cell.padEnd(14)} ${b.kind.padEnd(8)} ${b.createdAt}`);
  }
}

async function cmdChannelSync() {
  const file = await loadChannels();
  const entries = Object.entries(file.bindings);
  if (entries.length === 0) {
    console.log("(no bindings to sync)");
    return;
  }
  for (const [id, b] of entries) {
    await kvUpsert(b.kind, id, b.cell);
    console.log(`synced ${id} → ${b.cell} (${b.kind})`);
  }
  console.log(`✓ synced ${entries.length} binding${entries.length === 1 ? "" : "s"} to KV`);
}

async function cmdDestroy(args: string[]) {
  // Flags: --yes/-y skip per-name confirmation. --all-but <name...> kill
  // every cell except the listed ones (and 'pete' is NOT special — list it
  // explicitly if you want to keep it).
  let yes = false;
  let allBut = false;
  const names: string[] = [];
  for (const a of args) {
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--all-but" || a === "--except") allBut = true;
    else if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    } else names.push(a);
  }

  let targets: string[];
  if (allBut) {
    const reg = await loadRegistry();
    const keep = new Set(names);
    // Specials (mother, pulse) are exempt from --all-but sweeps unless
    // explicitly named. They're the substrate the other cells run on top
    // of; nuking them by accident takes the fleet down.
    targets = reg.cells
      .filter((c) => !c.special || keep.has(c.name))
      .map((c) => c.name)
      .filter((n) => !keep.has(n));
    const skippedSpecials = reg.cells.filter((c) => c.special && !keep.has(c.name)).map((c) => c.name);
    if (skippedSpecials.length > 0) {
      console.log(`(skipping specials: ${skippedSpecials.join(", ")} — name them explicitly to include)`);
    }
    if (targets.length === 0) {
      console.log("nothing to destroy");
      return;
    }
  } else {
    if (names.length === 0) {
      console.error("usage: cells kill <name>... [--yes]  |  cells kill --all-but <name>... [--yes]");
      process.exit(1);
    }
    for (const n of names) await requireCell(n);
    targets = names;
  }

  if (!yes) {
    const list = targets.join(", ");
    const prompt = targets.length === 1
      ? `destroying '${targets[0]}' is irreversible. type the name to confirm: `
      : `destroying ${targets.length} cells (${list}) is irreversible. type 'yes' to confirm: `;
    const confirm = await ask(prompt);
    const expected = targets.length === 1 ? targets[0] : "yes";
    if (confirm !== expected) {
      console.error("confirmation did not match — aborted");
      process.exit(1);
    }
  }

  let failures = 0;
  for (const n of targets) {
    const ok = await cmdDestroyOne(n);
    if (!ok) failures++;
  }
  if (failures > 0) process.exit(1);
}

async function cmdCheckpoint(name: string) {
  await requireCell(name);
  const { outcome } = await runPiWithOutcome("cell-checkpoint", [name]);
  if (!outcome || !outcome.success) {
    console.error(`checkpoint failed: ${outcome?.message ?? "no outcome reported"}`);
    process.exit(1);
  }
  console.log(outcome.message);
}

/**
 * Multi-turn streaming conversation with a remote cell over the v2
 * bridge — opens a WebSocket directly to the cell's site server
 * (wss://<well-host>/agent), shares the same pi process and session
 * file Slack uses, renders pi's RPC events into the terminal as they
 * stream.
 *
 * Pete's CLI prompts are mirrored into the cell's bound Slack channel
 * first (as a bot_message authored as the Mac user) so Slack stays the
 * canonical scrollback. The Slack edge filters bot_message subtypes,
 * so this doesn't loop back through the routing path.
 */
type StreamOpts = {
  interactive: boolean;
  initialMessage?: string;
  // Fires the first time pi streams a visible response token to stdout.
  // Used by cmdCreateV1Fast to measure birth-to-first-token latency
  // (the V1.3 metric) and persist it per-cell for the dashboard.
  onFirstToken?: () => void;
};

async function streamCellBridge(name: string, opts: StreamOpts): Promise<void> {
  const secret = await readSecret("CELLS_PROXY_SECRET");
  if (!secret) {
    console.error("CELLS_PROXY_SECRET missing from ~/.cells/secrets.json");
    process.exit(1);
  }

  // Try the local-Mac shortcut first: dial welld directly via 127.0.0.1
  // with the cell's virtual host. Skips CF, the per-cell Worker, and the
  // cloudflared tunnel entirely. If welld isn't running or doesn't know
  // this cell, falls through to the remote (cloud) path.
  process.stdout.write(`\x1b[2m── connecting to ${name}…\x1b[0m`);
  let ws: WebSocket | null = await tryConnectLocalWelld(name, secret);
  let connectedLocally = ws !== null;
  if (ws) {
    process.stdout.write("\r\x1b[K");
    process.stdout.write(`\x1b[2m── connected via local bridge\x1b[0m\n`);
  } else {
    const host = await resolveWellHost(name, secret);
    if (!host) {
      process.stdout.write("\r\x1b[K");
      console.error(`could not resolve well host for ${name}`);
      process.exit(1);
    }
    process.stdout.write(`\r\x1b[2m── connecting to ${host}…\x1b[0m`);
    ws = await connectBridgeWS(host, secret).catch((e) => {
      process.stdout.write("\r\x1b[K");
      console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }) as WebSocket;
  }

  // Resolve the cell's bound Slack channel + the Mac user's Slack uid.
  // When both exist, the prompt has a Slack home — but where it gets
  // routed depends on whether we're connected locally:
  //
  //   - localDrivenSlack: connected locally + Slack bound. Drive pi via
  //     local WS for lowest Mac latency; mirror prompt + final reply to
  //     Slack asynchronously (no streaming Slack edits — Slack gets the
  //     final answer once).
  //
  //   - useInboxPath: connected via cloud + Slack bound. Prompts route
  //     through /inbox/append, the DO drives pi over its own WS and
  //     does the streaming Slack render. The local WS here is a viewer.
  //
  //   - direct: no Slack channel. Prompts go via the WS, no Slack mirror.
  const channel = await resolveBoundChannel(name);
  const slackUserId = channel ? await resolveSlackUserId().catch(() => null) : null;
  const slackBound = !!(channel && slackUserId);
  // Local-driven Slack path (low-latency Mac → cell, async Slack mirror)
  // wins when we have local welld; cloud /inbox/append is the fallback.
  const useLocalDrive = connectedLocally && slackBound;
  const useInboxPath = !connectedLocally && slackBound;
  // Per-turn accumulator for the local-drive Slack mirror. Captures
  // pi's text_delta stream so we can post one final Slack message on
  // agent_end. Reset at agent_start of each turn.
  let replyAccum = "";
  let inFlight = false;
  let agentEnded = false;
  let promptOpen = opts.interactive;
  let activeText = false;       // true while pi is mid-text in the current turn
  let activeThinking = false;   // true while pi is mid-thinking-block
  let activeToolId: string | null = null; // tool whose line is open and awaiting its result
  // Track tool calls by id so we can render name + args alongside the
  // result when tool_execution_end fires (the start event has args, the
  // end event has the result; we join them).
  const tools = new Map<string, { name: string; args: any }>();
  const rl = opts.interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;

  const showPrompt = () => {
    if (!rl || !promptOpen) return;
    rl.setPrompt("> ");
    rl.prompt();
  };

  const sendPrompt = async (message: string) => {
    inFlight = true;
    activeText = false;
    replyAccum = "";
    if (useLocalDrive) {
      // Low-latency local path: mirror prompt to Slack as a bot_message
      // (bot_message subtype is filtered by the Slack edge so it won't
      // re-route into the cell), then drive pi directly via local WS.
      // The agent_end handler posts the accumulated reply to Slack so
      // the channel still has a record of the turn.
      await mirrorPromptToSlack(name, message, secret).catch(() => {});
      ws.send(JSON.stringify({ type: "prompt", message, streamingBehavior: "steer" }));
    } else if (useInboxPath) {
      // Cloud-routed Slack: prompt goes through /inbox/append; the DO
      // drives pi over its own WS and does the streaming Slack render.
      // Local WS here is purely a viewer for the same event stream.
      await mirrorPromptToSlack(name, message, secret).catch(() => {});
      await fetch(`https://${name}.cells.md/inbox/append`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ event: { channel, user: slackUserId, text: message } }),
      }).catch((e) => console.error(`[mirror] inbox/append failed: ${String(e).slice(0, 200)}`));
    } else {
      ws.send(JSON.stringify({ type: "prompt", message, streamingBehavior: "steer" }));
    }
  };

  // Helper: when transitioning out of a streaming block (thinking,
  // text, or an open tool line), emit a single trailing newline so the
  // next prefix lands on its own line.
  const closeActiveBlock = () => {
    if (activeThinking || activeText || activeToolId) {
      process.stdout.write("\n");
      activeThinking = false;
      activeText = false;
      activeToolId = null;
    }
  };

  const handleEvent = (event: any) => {
    if (event.type === "message_update") {
      const ev = event.assistantMessageEvent;
      if (ev?.type === "text_delta" && typeof ev.delta === "string") {
        if (activeThinking) { process.stdout.write("\n"); activeThinking = false; }
        if (!activeText) {
          process.stdout.write(`\x1b[1m${name}>\x1b[0m `);
          // First visible response token → fire one-shot callback (birth
          // latency capture). Wrapped in try because perf logging should
          // never break the talk flow.
          if (opts.onFirstToken) {
            try { opts.onFirstToken(); } catch {}
            opts.onFirstToken = undefined;
          }
        }
        process.stdout.write(ev.delta);
        activeText = true;
        if (useLocalDrive) replyAccum += ev.delta;
      } else if (ev?.type === "thinking_start" || ev?.type === "thinking_end") {
        // v1 cells run thinking=off — but gpt-5.5 codex still passes
        // through its reasoning pipeline and emits empty thinking
        // start/end events. Suppress the [thinking…] indicator entirely;
        // it's noise when there's no visible reasoning to surface and
        // it can land mid-stream and corrupt the user's input line.
      } else if (ev?.type === "toolcall_end" && ev.toolCall) {
        // Stash the call's args by id so we can render them alongside
        // the result when tool_execution_end fires.
        tools.set(String(ev.toolCall.id ?? ""), {
          name: String(ev.toolCall.name ?? "?"),
          args: ev.toolCall.arguments,
        });
      }
    } else if (event.type === "tool_execution_start") {
      const id = String(event.toolCallId ?? "");
      const tc = tools.get(id);
      const tname = tc?.name ?? String(event.name ?? "?");
      const argSummary = tc ? cliSummarizeArgs(tname, tc.args) : "";
      closeActiveBlock();
      // Open the tool line; result will be appended in tool_execution_end.
      const head = argSummary ? `[${tname}: ${argSummary}]` : `[${tname}]`;
      process.stdout.write(`\x1b[2m${head}\x1b[0m`);
      activeToolId = id;
    } else if (event.type === "tool_execution_end") {
      const id = String(event.toolCallId ?? "");
      const result = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
      const unwrapped = cliUnwrapToolResult(result);
      const isError = !!event.isError;
      // If we never saw a start (rare), open the line now.
      if (activeToolId !== id) {
        const tc = tools.get(id);
        const tname = tc?.name ?? "?";
        const argSummary = tc ? cliSummarizeArgs(tname, tc.args) : "";
        closeActiveBlock();
        const head = argSummary ? `[${tname}: ${argSummary}]` : `[${tname}]`;
        process.stdout.write(`\x1b[2m${head}\x1b[0m`);
      }
      const tail = unwrapped
        ? (isError ? ` \x1b[31m✗ ${cliTruncate(unwrapped, 200)}\x1b[0m`
                   : ` → \x1b[2m${cliTruncate(unwrapped, 200)}\x1b[0m`)
        : (isError ? " \x1b[31m✗\x1b[0m" : " ✓");
      process.stdout.write(`${tail}\n`);
      activeToolId = null;
      tools.delete(id);
    } else if (event.type === "agent_end") {
      closeActiveBlock();
      inFlight = false;
      agentEnded = true;
      // Local-drive Slack mirror — post the accumulated reply as the cell.
      // Best-effort: failure logs but doesn't block UX, and there's no
      // streaming retry (the alarm-driven retry path lives in the DO,
      // which is bypassed here by design).
      if (useLocalDrive && replyAccum.trim()) {
        const finalText = replyAccum;
        const replyChannel = channel!;
        void fetch("https://slack.cells.md/send", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
          body: JSON.stringify({ cell: name, text: finalText, channel: replyChannel }),
        }).catch((e) => console.error(`[mirror] reply post failed: ${String(e).slice(0, 200)}`));
      }
      if (opts.interactive) showPrompt();
      else { try { ws.close(); } catch {} }
    } else if (event.type === "response" && event.success === false) {
      process.stderr.write(`\n[error] ${event.error}\n`);
      inFlight = false;
      if (opts.interactive) showPrompt();
    }
  };

  ws.addEventListener("message", (ev) => {
    const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as any);
    for (const raw of data.split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      if (!line) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      handleEvent(event);
    }
  });

  ws.addEventListener("close", () => {
    if (rl) { promptOpen = false; rl.close(); }
  });
  ws.addEventListener("error", (e) => {
    console.error(`ws error: ${String((e as any).message ?? e).slice(0, 200)}`);
  });

  // Clear the "connecting…" line.
  process.stdout.write("\r\x1b[K");

  if (opts.initialMessage) {
    await sendPrompt(opts.initialMessage);
  }

  if (rl) {
    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (trimmed === "/exit" || trimmed === "/quit") { rl.close(); return; }
      if (!trimmed) { showPrompt(); return; }
      if (inFlight) {
        console.log("(still responding — wait, or type /abort)");
        showPrompt();
        return;
      }
      if (trimmed === "/abort") {
        ws.send(JSON.stringify({ type: "abort" }));
        return;
      }
      await sendPrompt(trimmed);
    });
    rl.on("close", () => { promptOpen = false; try { ws.close(); } catch {} });
    process.stdout.write(`\x1b[2m── talking to ${name}${useInboxPath ? " (mirroring to slack)" : ""} — /exit to quit\x1b[0m\n`);
    showPrompt();
  }

  // For one-shot mode, wait for agent_end.
  if (!opts.interactive) {
    await new Promise<void>((resolve) => {
      const tick = setInterval(() => { if (agentEnded) { clearInterval(tick); resolve(); } }, 100);
    });
    try { ws.close(); } catch {}
  } else {
    // Interactive mode: keep alive until rl closes.
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
    });
  }
}

// Try the local-Mac shortcut: ws://127.0.0.1:7878/agent with the cell's
// virtual host in the Host header. Welld dispatches by Host suffix
// (<well-name>.${WELL_PUBLIC_BASE}) and reverse-proxies to the cell's
// site server on :8080 inside the well — same path Cloudflared takes
// remotely, but skipping the cloud round-trip entirely. Returns null
// (not throws) on any failure so the caller falls through to the cloud
// path without surprise.
//
// IMPORTANT: hatched cells have cell_name != well_name (egg pool wells
// keep their original `egg-<harness>-<hash>` name). Welld dispatches by
// well name, so we resolve the well-name first via wellNameForCell.
async function tryConnectLocalWelld(name: string, secret: string): Promise<WebSocket | null> {
  // First try the host-bridge daemon (cli/host-bridge.ts) on :7880. It
  // owns the SSH-to-cell + pi spawn — talks-CLI just opens a WS to it.
  // This sidesteps welld's vhost-dispatch + DHCP-lease-record drift.
  const hb = await tryConnectHostBridge(name, secret);
  if (hb) return hb;

  // Fallback: legacy welld vhost-dispatch (for cells whose well still
  // runs the in-cell well-site bridge). Kept until host-bridge handles
  // every cell.
  try {
    const probe = await fetch("http://127.0.0.1:7878/healthz", {
      signal: AbortSignal.timeout(500),
    });
    if (!probe.ok) return null;
  } catch {
    return null;
  }
  let wellName: string;
  try {
    wellName = await wellNameForCell(name);
  } catch {
    return null;
  }
  const base = await wellPublicBase();
  const virtualHost = `${wellName}.${base}`;
  try {
    const ws = new WebSocket("ws://127.0.0.1:7878/agent", {
      headers: {
        host: virtualHost,
        authorization: `Bearer ${secret}`,
      },
    } as any);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("local-welld timeout")), 4000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener("error", (e: any) => { clearTimeout(t); reject(new Error(String(e?.message ?? e).slice(0, 120))); }, { once: true });
      ws.addEventListener("close", (e: any) => { clearTimeout(t); reject(new Error(`closed ${e?.code ?? "?"}`)); }, { once: true });
    });
    return ws;
  } catch {
    return null;
  }
}

// Fire-and-forget: nudge host-bridge to spawn ssh+pi for a cell so that
// the very first `cells talk` lands on an already-warm pi (skips the
// ~ssh+handshake cost that otherwise blew V1.3's 5s first-token target).
// Called from cmdCreateV1Fast once the well is verified reachable. Safe
// Tiny Deferred — manual resolver. Used for the first-token signal that
// the animation listens on; far less ceremony than wiring an EventEmitter
// through the call chain. Resolves at most once.
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void; settled: boolean };
function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => { if (!d.settled) { d.settled = true; resolve(v); } },
    reject:  (e) => { if (!d.settled) { d.settled = true; reject(e);  } },
  };
  return d;
}

// captureGreeting — birth-time pre-send. Opens a WS to host-bridge while
// the animation is still playing, fires the seed prompt as soon as pi is
// ready, and accumulates the streamed reply. The animation watches the
// returned `firstTokenSeen` signal so it can end the moment pi starts
// responding (no dead time between animation and greeting).
//
// Returns a handle:
//   - firstTokenSeen: resolves when pi streams its first text byte
//   - release(): drain the buffered greeting to stdout AND start streaming
//     subsequent deltas live; safe to call from the animation-done path
//   - done: resolves with the full greeting text on pi's agent_end
//
// Failure modes are swallowed: if host-bridge isn't reachable or pi errors,
// the returned handle's `done` rejects, but `firstTokenSeen` never resolves
// — so the animation will naturally hit its maxDurationMs cap.
type GreetingHandle = {
  firstTokenSeen: Promise<void>;
  done: Promise<string>;
  release: () => void;
};

async function captureGreeting(
  cellName: string,
  seedText: string,
): Promise<GreetingHandle> {
  const secret = await readSecret("CELLS_PROXY_SECRET");
  if (!secret) throw new Error("CELLS_PROXY_SECRET missing from ~/.cells/secrets.json");

  // Same connect-path as streamCellBridge: local host-bridge first, cloud
  // fallback. Don't print "── connecting…" — the animation owns the screen.
  let ws: WebSocket | null = await tryConnectLocalWelld(cellName, secret);
  if (!ws) {
    const host = await resolveWellHost(cellName, secret);
    if (!host) throw new Error(`could not resolve well host for ${cellName}`);
    ws = await connectBridgeWS(host, secret);
  }

  const firstTokenDef = makeDeferred<void>();
  const doneDef = makeDeferred<string>();
  let released = false;
  let prefixWritten = false;
  let buffered = "";
  let greeting = "";

  const writePrefix = () => {
    if (!prefixWritten) {
      process.stdout.write(`\x1b[1m${cellName}>\x1b[0m `);
      prefixWritten = true;
    }
  };

  const emit = (delta: string) => {
    if (released) {
      writePrefix();
      process.stdout.write(delta);
    } else {
      buffered += delta;
    }
  };

  ws.addEventListener("message", (ev) => {
    const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as any);
    for (const raw of data.split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      if (!line) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }

      if (event.type === "message_update") {
        const m = event.assistantMessageEvent;
        if (m?.type === "text_delta" && typeof m.delta === "string") {
          greeting += m.delta;
          firstTokenDef.resolve();
          emit(m.delta);
        }
      } else if (event.type === "agent_end") {
        if (released) process.stdout.write("\n");
        try { ws!.close(); } catch {}
        doneDef.resolve(greeting);
      } else if (event.type === "response" && event.success === false) {
        try { ws!.close(); } catch {}
        doneDef.reject(new Error(`pi error: ${event.error}`));
      }
    }
  });

  ws.addEventListener("close", () => {
    if (doneDef.settled) return;
    // `agent_end` is pi's terminal event. The claude-code / codex / hermes
    // harnesses stream their reply through a translation layer that closes
    // the bridge socket on a clean finish without emitting a pi-shaped
    // `agent_end`. So a close *after* we've accumulated greeting text is a
    // normal completion, not a failure — resolve with what streamed. Only
    // an empty greeting at close time is a real failure.
    if (greeting.length > 0) {
      if (released) process.stdout.write("\n");
      doneDef.resolve(greeting);
    } else {
      doneDef.reject(new Error("ws closed before any greeting streamed"));
    }
  });
  ws.addEventListener("error", (e: any) => {
    if (!doneDef.settled) doneDef.reject(new Error(`ws error: ${String(e?.message ?? e).slice(0, 200)}`));
  });

  // Fire the seed prompt right away. Host-bridge's session queues prompts
  // sent before pi finishes its switch_session/set_model handshake — so
  // even if pi isn't ready the second we send, it'll dispatch as soon as
  // pi-ready flips. No "still responding" race.
  ws.send(JSON.stringify({ type: "prompt", message: seedText, streamingBehavior: "steer" }));

  return {
    firstTokenSeen: firstTokenDef.promise,
    done: doneDef.promise,
    release: () => {
      if (released) return;
      released = true;
      if (buffered) {
        writePrefix();
        process.stdout.write(buffered);
        buffered = "";
      }
    },
  };
}

// to invoke when the daemon isn't running — silently no-ops.
async function prewarmHostBridge(cellName: string): Promise<void> {
  try {
    const secret = await readSecret("CELLS_PROXY_SECRET");
    if (!secret) return;
    const port = Number(process.env.HOST_BRIDGE_PORT ?? 7880);
    await fetch(`http://127.0.0.1:${port}/prewarm?cell=${encodeURIComponent(cellName)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(35_000),
    });
  } catch {
    // Pure perf optimization — birth must not fail because prewarm did.
  }
}

// Dial the host-bridge daemon. Returns null if daemon not running or
// the cell isn't reachable through it.
async function tryConnectHostBridge(name: string, secret: string): Promise<WebSocket | null> {
  const port = Number(process.env.HOST_BRIDGE_PORT ?? 7880);
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(500),
    });
    if (!probe.ok) return null;
  } catch {
    return null;
  }
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent?cell=${encodeURIComponent(name)}`, {
      headers: { authorization: `Bearer ${secret}` },
    } as any);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("host-bridge timeout")), 8000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener("error", (e: any) => { clearTimeout(t); reject(new Error(String(e?.message ?? e).slice(0, 120))); }, { once: true });
      ws.addEventListener("close", (e: any) => { clearTimeout(t); reject(new Error(`closed ${e?.code ?? "?"}`)); }, { once: true });
    });
    return ws;
  } catch {
    return null;
  }
}

// Open a WebSocket to wss://<host>/agent with bearer auth, retrying
// on cold-start stalls. Each attempt waits up to 12s for `open`;
// retries back off (3s, 6s, 12s) for up to ~30s total.
async function connectBridgeWS(host: string, secret: string): Promise<WebSocket> {
  const PER_ATTEMPT_MS = 12_000;
  const BACKOFFS = [0, 3_000, 6_000, 12_000];
  let lastErr: any = null;
  for (let i = 0; i < BACKOFFS.length; i++) {
    if (BACKOFFS[i] > 0) await new Promise((r) => setTimeout(r, BACKOFFS[i]));
    const ws = new WebSocket(`wss://${host}/agent`, {
      headers: { authorization: `Bearer ${secret}` },
    } as any);
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("attempt timeout")), PER_ATTEMPT_MS);
        ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
        ws.addEventListener("error", (e: any) => { clearTimeout(t); reject(new Error(String(e?.message ?? e).slice(0, 120))); }, { once: true });
        ws.addEventListener("close", (e: any) => { clearTimeout(t); reject(new Error(`closed ${e?.code ?? "?"}`)); }, { once: true });
      });
      return ws;
    } catch (e) {
      lastErr = e;
      try { ws.close(); } catch {}
    }
  }
  throw new Error(`ws connect to ${host} failed after ${BACKOFFS.length} attempts: ${String(lastErr).slice(0, 200)}`);
}

// Look up the slack channel ID bound to this cell from the local
// channels.json registry. Used by the bridge client to route CLI
// prompts through /inbox/append (which sets pendingChannel on the DO
// and ensures pi's reply renders into the same Slack thread).
async function resolveBoundChannel(cellName: string): Promise<string | null> {
  if (!existsSync(CHANNELS_PATH)) return null;
  try {
    const file = await loadChannels();
    for (const [id, b] of Object.entries(file.bindings)) {
      if (b.cell === cellName && b.kind === "slack") return id;
    }
    return null;
  } catch {
    return null;
  }
}

// Resolve a cell's well host (e.g. "ned-bas32.wells.app") via the
// cell worker's /debug endpoint — faster than `well info` and uses
// the same bearer secret we already have.
async function resolveWellHost(name: string, secret: string): Promise<string | null> {
  // Retry with backoff — a freshly-deployed CF worker can take 5-15s to
  // become reachable via <name>.cells.md while DNS / the worker route
  // propagates. Without this retry, an auto-hatch or slow-birth that
  // drops directly into `cells talk` races the worker and 404s.
  const delays = [0, 1000, 2000, 3000, 5000]; // total ~11s
  let lastErr: unknown = null;
  for (const ms of delays) {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    try {
      const r = await fetch(`https://${name}.cells.md/debug`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      if (r.ok) {
        const j = (await r.json()) as { well?: string };
        if (j.well) return j.well;
      }
      lastErr = `${r.status} ${r.statusText}`;
    } catch (e) {
      lastErr = e;
    }
  }
  // All retries exhausted. Return null so the caller's existing error
  // path triggers — but the retries have given the worker plenty of
  // time, so this is now a real failure rather than a race.
  void lastErr;
  return null;
}

// Mirror a CLI prompt into the cell's bound Slack channel as a bot
// message with the Mac user's name as the override. The slack edge
// filters bot_message subtypes, so this doesn't loop back through
// /events into the cell. Best-effort: failures don't block the bridge
// send.
// One-line arg summary used in the CLI tool render. Mirrors the
// cell-agent.ts logic but kept local so the bridge worker doesn't get
// a dependency on this file.
function cliSummarizeArgs(toolName: string, args: any): string {
  const a = (args && typeof args === "object") ? args as Record<string, any> : {};
  const pick = (k: string) => typeof a[k] === "string" ? a[k] : "";
  switch (toolName) {
    case "write_memory": case "write_yearning": case "read_memory":
      return pick("name");
    case "write_file": case "read_file": case "edit_file":
      return pick("path") || pick("file_path");
    case "bash": case "shell":
      return pick("command");
    case "web_search": case "code_search":
      return pick("query");
    case "fetch_content": case "get_search_content":
      return pick("url") || pick("query");
    default: {
      const firstStr = Object.values(a).find(v => typeof v === "string");
      if (firstStr) return String(firstStr);
      const n = Object.keys(a).length;
      return n > 0 ? `{${n} arg${n === 1 ? "" : "s"}}` : "";
    }
  }
}

// Pull text out of pi's standard tool-result envelope.
function cliUnwrapToolResult(raw: string): string {
  if (!raw) return "";
  try {
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.content)) {
      const texts = obj.content
        .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text);
      if (texts.length) return texts.join("\n").trim();
    }
    if (typeof obj === "string") return obj.trim();
  } catch { /* not JSON */ }
  return raw.trim();
}

function cliTruncate(s: string, n: number): string {
  if (s.length <= n) return s.replace(/\n+/g, " ");
  return s.slice(0, n).replace(/\n+/g, " ") + "…";
}

async function mirrorPromptToSlack(cellName: string, text: string, secret: string): Promise<void> {
  const user = userInfo().username;
  const username = `${user} (cli)`;
  // Distinct gravatar so the CLI message doesn't share the cell's
  // identicon. Seeded by user, not cell, so it's stable across cells.
  const iconHash = createHash("md5").update(`cli:${user}`).digest("hex");
  const icon_url = `https://www.gravatar.com/avatar/${iconHash}?d=identicon&s=96`;
  await fetch("https://slack.cells.md/send", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ cell: cellName, text, username, icon_url }),
  });
}

async function dreamOne(name: string): Promise<boolean> {
  console.log(`→ dreaming ${name}`);
  // Run pi as root with HOME=/root so memory ext writes (/root/state/memory/)
  // succeed and dream's session lands under /root/.pi/ — same context the
  // host-bridge gives the agent for talk.
  const proc = Bun.spawn(
    [
      "well",      "exec",
      "-s",
      name,
      "--",
      "sudo", "bash", "-lc",
      'export HOME=/root; cd /root && pi -p "Run the dream tool to consolidate your memory."',
    ],
    {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await proc.exited;
  const ok = code === 0;
  console.log(ok ? `✓ ${name}` : `✗ ${name} (exit ${code})`);
  return ok;
}

const PI_PATCHES_LABEL = "com.pete.cells-pi-patches";

function piPatchesPlistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${PI_PATCHES_LABEL}.plist`);
}

function piPatchesWatchPaths(): string[] {
  // Watch each pi-ai package.json. When pi gets `bun install -g`'d, these
  // mtimes change; launchd fires the patch script.
  const roots = [
    "@mariozechner/pi-ai/package.json",
    "@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/package.json",
    "@mariozechner/pi-agent-core/node_modules/@mariozechner/pi-ai/package.json",
  ];
  return roots.map((r) => join(homedir(), ".bun/install/global/node_modules", r));
}

function buildPiPatchesPlist(): string {
  const scriptPath = join(MOTHER_ROOT, "dna/scripts/apply-pi-patches.sh");
  const logsDir = join(homedir(), ".cells", "logs");
  const path = `${homedir()}/.bun/bin:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const watchPaths = piPatchesWatchPaths()
    .map((p) => `    <string>${p}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PI_PATCHES_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${scriptPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${path}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>WatchPaths</key>
  <array>
${watchPaths}
  </array>
  <key>StandardOutPath</key>
  <string>${logsDir}/pi-patches.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/pi-patches.err</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

async function cmdSchedulePiPatches() {
  const logsDir = join(homedir(), ".cells", "logs");
  await mkdir(logsDir, { recursive: true });
  await mkdir(dirname(piPatchesPlistPath()), { recursive: true });
  await writeFile(piPatchesPlistPath(), buildPiPatchesPlist());
  console.log(`✓ wrote plist: ${piPatchesPlistPath()}`);

  const uid = process.getuid?.() ?? 501;

  await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${PI_PATCHES_LABEL}`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).exited;

  const proc = Bun.spawn(["launchctl", "bootstrap", `gui/${uid}`, piPatchesPlistPath()], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("✗ launchctl bootstrap failed");
    process.exit(1);
  }

  console.log(`✓ scheduled: pi-ai patches re-apply on global pi-ai updates`);
  console.log(`  logs: ${logsDir}/pi-patches.log (stdout), pi-patches.err (stderr)`);
  console.log(`  unschedule with: cells unschedule-pi-patches`);
}

async function cmdUnschedulePiPatches() {
  const uid = process.getuid?.() ?? 501;
  await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${PI_PATCHES_LABEL}`], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  if (existsSync(piPatchesPlistPath())) {
    await unlink(piPatchesPlistPath());
    console.log(`✓ removed ${piPatchesPlistPath()}`);
  } else {
    console.log("(no plist found)");
  }
  console.log("✓ unscheduled");
}

const HOST_BRIDGE_LABEL = "com.pete.cells-host-bridge";

function hostBridgePlistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${HOST_BRIDGE_LABEL}.plist`);
}

function buildHostBridgePlist(): string {
  const bunBin = process.execPath;
  const script = join(REPO_ROOT, "cli/host-bridge.ts");
  const logsDir = join(homedir(), ".cells", "logs");
  const path = `${homedir()}/.bun/bin:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${HOST_BRIDGE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunBin}</string>
    <string>run</string>
    <string>${script}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${path}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logsDir}/host-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/host-bridge.err</string>
</dict>
</plist>
`;
}

async function cmdScheduleHostBridge() {
  const logsDir = join(homedir(), ".cells", "logs");
  await mkdir(logsDir, { recursive: true });
  await mkdir(dirname(hostBridgePlistPath()), { recursive: true });
  await writeFile(hostBridgePlistPath(), buildHostBridgePlist());
  console.log(`✓ wrote plist: ${hostBridgePlistPath()}`);
  const uid = process.getuid?.() ?? 501;
  await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${HOST_BRIDGE_LABEL}`], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  }).exited;
  const proc = Bun.spawn(["launchctl", "bootstrap", `gui/${uid}`, hostBridgePlistPath()], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("✗ launchctl bootstrap failed");
    process.exit(1);
  }
  console.log(`✓ scheduled: host-bridge daemon (RunAtLoad + KeepAlive)`);
  console.log(`  logs: ${logsDir}/host-bridge.log (stdout), host-bridge.err (stderr)`);
  console.log(`  port: 127.0.0.1:7880`);
  console.log(`  unschedule with: cells unschedule-host-bridge`);
}

async function cmdUnscheduleHostBridge() {
  const uid = process.getuid?.() ?? 501;
  await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${HOST_BRIDGE_LABEL}`], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  }).exited;
  if (existsSync(hostBridgePlistPath())) {
    await unlink(hostBridgePlistPath());
    console.log(`✓ removed ${hostBridgePlistPath()}`);
  } else {
    console.log("(no plist found)");
  }
  console.log("✓ unscheduled");
}

// ───── pool refill — on-birth, no scheduled loop ─────
//
// The pool refills itself: every successful `cells birth` claims one egg
// and fires a background refillPoolToDepth() that bakes the pool back to
// V1_POOL_TARGET_DEPTH. One birth, one egg.
//
// There is deliberately NO scheduled refiller. The old launchd loop
// (`cells schedule-pool-refill`, every 10 min) raced the on-birth refill
// — both read a stale count and each baked a full batch — and with no
// cull the pool only grew. It ran away to 42 against a target of 5.
// `cmdSchedulePoolRefill` now refuses; `cmdUnschedulePoolRefill` stays so
// an existing install can still be torn down.

const POOL_REFILL_LABEL = "com.pete.cells-pool-refill";

function eggRefillPlistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${POOL_REFILL_LABEL}.plist`);
}

async function cmdSchedulePoolRefill() {
  console.error(
    "refused: there is no scheduled pool refiller by design.\n" +
      "  Refill is on-birth — each `cells birth` tops the pool back up by one.\n" +
      "  A periodic refiller raced the on-birth refill and ran the pool away\n" +
      "  to 42 (target 5). If a stale plist is still installed, remove it with\n" +
      "  `cells unschedule-pool-refill`.",
  );
  process.exit(1);
}

async function cmdUnschedulePoolRefill() {
  const uid = process.getuid?.() ?? 501;
  await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${POOL_REFILL_LABEL}`], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  if (existsSync(eggRefillPlistPath())) {
    await unlink(eggRefillPlistPath());
    console.log(`✓ removed ${eggRefillPlistPath()}`);
  } else {
    console.log("(no plist found)");
  }
  console.log("✓ unscheduled");
}

// `cells schedule-pool-reconcile` installs a launchd plist that runs
// `cells pool reconcile` every 5 minutes. Eager defense against state
// drift (welld bounces, manual lume hand-stops, etc) — works even when
// no one is running cells commands. Cheap when pool is healthy.

const POOL_RECONCILE_LABEL = "com.pete.cells-pool-reconcile";

function poolReconcilePlistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${POOL_RECONCILE_LABEL}.plist`);
}

function buildPoolReconcilePlist(): string {
  const bunBin = `${homedir()}/.bun/bin/bun`;
  const cellsCli = join(REPO_ROOT, "cli", "cells.ts");
  const logsDir = join(homedir(), ".cells", "logs");
  const path = `${homedir()}/.bun/bin:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${POOL_RECONCILE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunBin}</string>
    <string>${cellsCli}</string>
    <string>pool</string>
    <string>reconcile</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${path}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>${logsDir}/pool-reconcile.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/pool-reconcile.err</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

async function cmdSchedulePoolReconcile() {
  const logsDir = join(homedir(), ".cells", "logs");
  await mkdir(logsDir, { recursive: true });
  await mkdir(dirname(poolReconcilePlistPath()), { recursive: true });
  await writeFile(poolReconcilePlistPath(), buildPoolReconcilePlist());
  console.log(`✓ wrote plist: ${poolReconcilePlistPath()}`);

  const uid = process.getuid?.() ?? 501;
  await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${POOL_RECONCILE_LABEL}`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  const proc = Bun.spawn(["launchctl", "bootstrap", `gui/${uid}`, poolReconcilePlistPath()], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("✗ launchctl bootstrap failed");
    process.exit(1);
  }
  console.log(`✓ scheduled: pool reconcile every 5 minutes`);
  console.log(`  logs: ${logsDir}/pool-reconcile.log (stdout), pool-reconcile.err (stderr)`);
  console.log(`  unschedule with: cells unschedule-pool-reconcile`);
}

async function cmdUnschedulePoolReconcile() {
  const uid = process.getuid?.() ?? 501;
  await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${POOL_RECONCILE_LABEL}`], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  if (existsSync(poolReconcilePlistPath())) {
    await unlink(poolReconcilePlistPath());
    console.log(`✓ removed ${poolReconcilePlistPath()}`);
  } else {
    console.log("(no plist found)");
  }
  console.log("✓ unscheduled");
}

/**
 * refresh-extensions — push the latest copy of one DNA extension onto an
 * existing cell, and ensure it's listed in the cell's .pi/settings.json.
 *
 * Used to retrofit cells born before an extension shipped (e.g. heartbeat-watch).
 * Surgical: doesn't touch the agent's pi session, doesn't talk(), doesn't
 * disturb other extensions. Next time pi reloads on the cell (or on next
 * agent start), the new extension is picked up.
 *
 * Idempotent. Safe to run on a cell that already has the extension — files
 * get overwritten with current content; settings.json entry is added only
 * if missing.
 */
async function refreshExtensionOnCell(cellName: string, extName: string): Promise<boolean> {
  const localExtDir = join(DNA_DIR, ".pi", "extensions", extName);
  if (!existsSync(localExtDir)) {
    console.error(`✗ ${cellName}: dna extension ${extName} missing at ${localExtDir}`);
    return false;
  }

  // Push the extension dir via tar pipe.
  const remoteExtDir = `/root/.pi/extensions/${extName}`;
  const tar = Bun.spawn(["tar", "czf", "-", "-C", join(DNA_DIR, ".pi", "extensions"), extName], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // /root is root:root post-bake; well user has NOPASSWD sudo per the
  // wells base, so a plain sudo lifts to root and tar lands root-owned —
  // matching the rest of /root.
  const remoteCmd = `sudo bash -c 'mkdir -p /root/.pi/extensions && rm -rf ${remoteExtDir} && cd /root/.pi/extensions && tar xzf -'`;
  const recv = Bun.spawn(["well", "exec", "-s", cellName, "--", "bash", "-c", remoteCmd], {
    stdin: tar.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await recv.exited;
  if (code !== 0) {
    const err = await new Response(recv.stderr).text();
    console.error(`✗ ${cellName}: push failed — ${err.trim() || `exit ${code}`}`);
    return false;
  }

  // Idempotent settings.json update — read JSON, add the extension entry if
  // missing, write back. No `jq` dep on the well (busybox base).
  const entry = `.pi/extensions/${extName}/index.ts`;
  const updateScript = `
set -e
cd /root
node -e '
  const fs = require("fs");
  const p = ".pi/settings.json";
  const s = JSON.parse(fs.readFileSync(p, "utf-8"));
  s.extensions = s.extensions || [];
  if (!s.extensions.includes("${entry}")) {
    s.extensions.push("${entry}");
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\\n");
    console.log("added");
  } else {
    console.log("already-present");
  }
'
`.trim();
  const settings = await wellExecCapture(cellName, updateScript, { user: "root" });
  if (!settings.ok) {
    console.error(`✗ ${cellName}: settings.json update failed — ${settings.stderr.trim()}`);
    return false;
  }
  const status = settings.stdout.trim();
  console.log(`✓ ${cellName}: ${extName} pushed (${status})`);
  return true;
}

/**
 * Inverse of refreshExtensionOnCell: drop the extension entry from
 * settings.json and rm the dir on the cell. Idempotent.
 */
async function removeExtensionOnCell(cellName: string, extName: string): Promise<boolean> {
  const entry = `.pi/extensions/${extName}/index.ts`;
  const script = `
set -e
cd /root
node -e '
  const fs = require("fs");
  const p = ".pi/settings.json";
  const s = JSON.parse(fs.readFileSync(p, "utf-8"));
  s.extensions = (s.extensions || []).filter(x => x !== "${entry}");
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\\n");
'
rm -rf /root/.pi/extensions/${extName}
echo removed
`.trim();
  const r = await wellExecCapture(cellName, script, { user: "root" });
  if (!r.ok) {
    console.error(`✗ ${cellName}: remove failed — ${r.stderr.trim()}`);
    return false;
  }
  console.log(`✓ ${cellName}: ${extName} removed`);
  return true;
}

/**
 * Restart pi on a cell so newly-pushed extensions actually load.
 *
 * v2: pi runs as a child of the site server (dna/cells/base/site/server.ts).
 * Killing pi is enough — the site server's `pi.exited` handler respawns
 * it after PI_RESPAWN_DELAY_MS (1s) and pi re-reads extensions on boot.
 * No need to restart the well service itself.
 */
async function restartPiOnCell(cellName: string): Promise<boolean> {
  const script = `
pkill -f "pi --mode rpc" 2>/dev/null || true
sleep 2
pgrep -f "pi --mode rpc" >/dev/null && echo restarted || { echo "✗ pi not running after kill — site service may be down"; exit 1; }
`.trim();
  const r = await wellExecCapture(cellName, script);
  if (!r.ok) {
    console.error(`✗ ${cellName}: restart failed — ${r.stderr.trim() || r.stdout.trim()}`);
    return false;
  }
  console.log(`✓ ${cellName}: pi restarted (extensions reloaded)`);
  return true;
}

// ───── cells refresh — update LIVING cells from current DNA ─────
//
// Until 2026-06-11 DNA improvements only reached newborns; live cells ran
// birth-era code forever (bob's stale supervisor, advisor-pete's missing
// lib module — three incidents in one week). Refresh pushes the platform-
// owned surface (site/server.ts, lib/, bin/, scripts/, plus extensions/
// skills/prompts the cell already carries) and never touches cell-owned
// identity/state. Classification rules + tests: cli/lib/refresh.ts.
//
// Safety: replaced files are backed up on the well, well-site restarts,
// and a failed health check rolls the backup straight back. /root/.dna-
// version records what landed.

import { buildPlan, overlay } from "./lib/refresh";

function listDnaFilesRec(dir: string, root: string, out: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) listDnaFilesRec(abs, root, out);
    else if (entry.isFile()) out.set(relative(root, abs), abs);
  }
}

function listDnaFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (existsSync(root)) listDnaFilesRec(root, root, out);
  return out;
}

async function refreshOneCell(
  cellName: string,
  opts: { dryRun: boolean; verify: boolean },
): Promise<{ ok: boolean; detail: string }> {
  const reg = await loadRegistry();
  const cell = reg.cells.find((c) => c.name === cellName);
  if (!cell) return { ok: false, detail: "not in registry" };
  const wellName = await wellNameForCell(cellName);

  // Source = base DNA floored, special dir overlaid (same order birth uses).
  const specialDir = cell.special ? join(SPECIALS_DIR, cellName) : null;
  const sources = overlay(listDnaFiles(DNA_DIR), specialDir ? listDnaFiles(specialDir) : null);

  await ensureWellRunningForTalk(wellName);

  // Discover which if-present units the cell carries — its enabled set is
  // config, not ours to change. One round-trip.
  const discover = await wellExecCapture(
    wellName,
    `for root in .pi/extensions .pi/skills .claude/skills; do
       for d in /root/$root/*/; do [ -d "$d" ] && echo "$root/$(basename "$d")"; done
     done
     [ -d /root/.pi/prompts ] && echo .pi/prompts
     true`,
  );
  if (!discover.ok) return { ok: false, detail: `unit discovery failed: ${discover.stderr.slice(0, 120)}` };
  const presentUnits = new Set(
    discover.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.includes("*")),
  );

  const plan = buildPlan(sources, presentUnits);
  if (plan.push.size === 0) return { ok: false, detail: "empty plan (no DNA sources?)" };
  if (opts.dryRun) {
    return {
      ok: true,
      detail: `dry-run: ${plan.push.size} files would land; units skipped (not on cell): ${plan.skippedUnits.join(", ") || "none"}`,
    };
  }

  // Stage the plan on the Mac mirroring /root-relative layout, then one
  // tar pipe to the well.
  const stage = await mkdtemp(join(tmpdir(), "cells-refresh-"));
  try {
    for (const [rel, abs] of plan.push) {
      const dst = join(stage, rel);
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(abs, dst);
      // tar preserves mode from the staged copy; copyFile preserves it
      // from the repo working tree, where exec bits are already right.
    }
    let sha = "unknown";
    try {
      sha = execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT }).toString().trim();
      if (execSync("git status --porcelain", { cwd: REPO_ROOT }).toString().trim()) sha += "+dirty";
    } catch { /* not fatal — version stamp is best-effort */ }

    // Runtime-DNA rev of what this refresh pushes (cli/lib/dna-rev.ts). Both
    // version stamps are written ONLY on the healthy branch below — a refresh
    // that health-checks red and rolls back must NOT leave the cell claiming
    // the new rev (else the steward would think it's current while running
    // the OLD code). Base-rev: refresh of a special still overlays the
    // special dir, but the rev tracks the universal platform surface.
    const rev = dnaRev(DNA_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    // After the supervisor answers /health, also wait until the cell's harness
    // binary resolves in a job-like login shell before declaring the refresh
    // done. /health=ok only proves the HTTP listener is up; a `cells run` job
    // fired the instant refresh returns ✓ can still hit "pi: command not found"
    // (exit 127) if the harness PATH isn't settled yet — the race that bit
    // homezero's birth-orchestrate and threatens the DNA-rev steward's
    // refresh-then-(future-)work. Empty bin (unknown harness) → skip the probe.
    const harnessBin = HARNESS_JOB_BIN[cell.harness ?? "pi"] ?? "";
    const harnessGate = harnessBin
      ? `    hok=0
    for j in $(seq 1 20); do
      if HOME=/root bash -lc "command -v ${harnessBin} >/dev/null 2>&1"; then hok=1; break; fi
      sleep 1
    done
    [ "$hok" = "1" ] && echo REFRESH_HEALTHY || echo REFRESH_HEALTHY_HARNESS_SLOW`
      : `    echo REFRESH_HEALTHY`;
    const remote = `set -e
sudo bash -c '
  set -e
  mkdir -p /root/.refresh-stage /root/.refresh-backup-${ts}
  cd /root/.refresh-stage && tar xzf -
  cd /root/.refresh-stage
  find . -type f | while read -r f; do
    rel="\${f#./}"
    if [ -f "/root/$rel" ]; then
      mkdir -p "/root/.refresh-backup-${ts}/$(dirname "$rel")"
      cp -a "/root/$rel" "/root/.refresh-backup-${ts}/$rel"
    fi
    mkdir -p "/root/$(dirname "$rel")"
    cp -a "$f" "/root/$rel"
  done
  sync
  # keep the 3 newest backups, prune the rest
  ls -dt /root/.refresh-backup-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
  systemctl restart well-site
  ok=0
  for i in $(seq 1 12); do
    sleep 2
    [ "$(curl -s -m 2 http://localhost:8080/health)" = "ok" ] && ok=1 && break
  done
  if [ "$ok" = "1" ]; then
    # Stamp the rev ONLY now that the new code is live and healthy — never
    # before the rollback decision (the stale-rev-after-rollback trap).
    echo "${sha} ${ts}" > /root/.dna-version
    echo "${rev}" > /root/.dna-rev
    sync
    rm -rf /root/.refresh-stage
${harnessGate}
  else
    cd /root/.refresh-backup-${ts} && find . -type f | while read -r f; do cp -a "$f" "/root/\${f#./}"; done
    sync; systemctl restart well-site
    echo REFRESH_ROLLED_BACK
  fi
'`;

    const tar = Bun.spawn(["tar", "czf", "-", "-C", stage, "."], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const recv = Bun.spawn(["well", "exec", "-s", wellName, "--", "bash", "-c", remote], {
      stdin: tar.stdout,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(recv.stdout).text();
    const code = await recv.exited;
    if (code !== 0) {
      const err = await new Response(recv.stderr).text();
      return { ok: false, detail: `push failed: ${(err || out).trim().slice(-180) || `exit ${code}`}` };
    }
    if (out.includes("REFRESH_ROLLED_BACK")) {
      return { ok: false, detail: `health check failed after restart — rolled back to pre-refresh state` };
    }
    if (!out.includes("REFRESH_HEALTHY")) {
      return { ok: false, detail: `unexpected install output: ${out.trim().slice(-180)}` };
    }
    // Supervisor healthy + new code live, but the harness didn't resolve on the
    // job PATH within the wait. The refresh itself succeeded (don't fail it);
    // warn so a refresh-then-run caller knows an immediate job could still 127.
    const readyNote = out.includes("REFRESH_HEALTHY_HARNESS_SLOW")
      ? ` ⚠ ${harnessBin || "harness"} not job-ready within 20s — a job fired immediately may fail (127)`
      : "";

    if (opts.verify) {
      const talk = await runTalkOnCell(cellName, "reply with just the word ok", { timeoutS: 120, useMain: false });
      if (!talk.ok) return { ok: false, detail: `refreshed (${plan.push.size} files, ${sha}) but talk verify failed: ${talk.error.slice(0, 120)}` };
      return { ok: true, detail: `${plan.push.size} files @ ${sha}, talk verified${readyNote}` };
    }
    return { ok: true, detail: `${plan.push.size} files @ ${sha}${readyNote}` };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

async function cmdRefresh(args: string[]) {
  let dryRun = false;
  let verify = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--verify") verify = true;
    else if (a === "--all") positional.push("--all");
    else positional.push(a);
  }
  const target = positional[0];
  if (!target) {
    console.error("usage: cells refresh <name|--all> [--dry-run] [--verify]");
    console.error("  pushes current DNA infrastructure to a LIVE cell (never identity/state)");
    console.error("  --all      every running cell (hibernated cells are skipped, not woken)");
    console.error("  --dry-run  show the plan without touching the cell");
    console.error("  --verify   talk round-trip after the restart");
    process.exit(1);
  }

  const reg = await loadRegistry();
  let names: string[];
  if (target === "--all") {
    // --all refreshes running cells only — a fleet refresh shouldn't wake
    // the world. Name a cell explicitly to wake-and-refresh it.
    const token = await wellsToken().catch(() => "");
    const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
    const data: any = await fetch(`${base}/dashboard/data`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const running = new Set((data?.wells ?? []).filter((w: any) => w.status === "running").map((w: any) => w.name));
    names = [];
    for (const c of reg.cells) {
      const wn = await wellNameForCell(c.name);
      if (running.has(wn)) names.push(c.name);
      else console.log(`  ${c.name.padEnd(18)} skipped (hibernated — name it explicitly to wake-and-refresh)`);
    }
  } else {
    await requireCell(target);
    names = [target];
  }

  let fails = 0;
  for (const name of names) {
    const r = await refreshOneCell(name, { dryRun, verify });
    console.log(`  ${name.padEnd(18)} ${r.ok ? "✓" : "✗"} ${r.detail}`);
    if (!r.ok) fails++;
  }
  if (fails > 0) process.exit(1);
}

async function cmdRefreshExtensions(args: string[]) {
  // Flags: --restart (kick pi after pushing so the extension loads),
  //        --remove (inverse: drop the extension instead of pushing).
  let restart = false;
  let remove = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === "--restart") restart = true;
    else if (a === "--remove") remove = true;
    else positional.push(a);
  }
  if (remove && restart) {
    // Allowed: remove + restart-after-remove makes sense.
  }

  let target = positional[0];
  let extNames = positional.slice(1);
  if (!target) {
    console.error("usage: cells refresh-extensions <name|--all> [extension...] [--restart] [--remove]");
    console.error("       --restart  kick pi on the cell so the new extension loads");
    console.error("       --remove   inverse: rm the extension and drop from settings.json");
    console.error("       default extension when none given: heartbeat-watch");
    process.exit(1);
  }
  if (extNames.length === 0) extNames = ["heartbeat-watch"];

  const reg = await loadRegistry();
  const targets = target === "--all" ? reg.cells.map((c) => c.name) : [target];
  if (target !== "--all") await requireCell(target);

  let okCount = 0;
  let failCount = 0;
  for (const cell of targets) {
    for (const ext of extNames) {
      const verb = remove ? "rm" : "←";
      console.log(`→ ${cell} ${verb} ${ext}`);
      const ok = remove ? await removeExtensionOnCell(cell, ext) : await refreshExtensionOnCell(cell, ext);
      ok ? okCount++ : failCount++;
    }
    if (restart && (okCount > 0 || remove)) {
      const ok = await restartPiOnCell(cell);
      ok ? okCount++ : failCount++;
    }
  }
  console.log(`\n${okCount} ok, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

/**
 * heartbeat — read-only inspection of pulse's state from Pete's terminal.
 *
 *   cells heartbeat              print state/heartbeats.md (the digest)
 *   cells heartbeat <cell>       print just one cell's schedule rows
 *   cells heartbeat --tail       stream cron-fires.log from the pulse cell
 *
 * --tail used to read pulse.json's log[] but pulse no longer fires wakes
 * itself — Linux cron does, and every crontab line tees to
 * /root/.cells/logs/cron-fires.log on the pulse cell. So --tail now shells
 * into the pulse cell and tails that file.
 */
async function cmdHeartbeat(args: string[]) {
  const heartbeatsMd = join(PULSE_ROOT, "state", "heartbeats.md");

  // `cells heartbeat reseed <project>` — re-push every project cell's schedule
  // into its current owning pulse (the project's pulse if alive, else global).
  // The recovery handle for a CRASHED project pulse (clean kills fail back
  // automatically): once the pulse is back — or to hand its cells to global
  // after a crash — this rebuilds their cron blocks from the Mac's last-seen
  // HEARTBEAT.md mirror, no cell wake required.
  if (args[0] === "reseed") {
    const project = args[1];
    if (!project) {
      console.error("usage: cells heartbeat reseed <project>");
      return;
    }
    const cells = (await loadRegistry()).cells;
    const ownerWell = await owningPulseWell(project, cells);
    if (!ownerWell) {
      console.error(`(no owning pulse in registry for project '${project}')`);
      return;
    }
    const targets = projectScheduledCells(project, cells);
    if (!targets.length) {
      console.log(`(no scheduled cells tagged project '${project}')`);
      return;
    }
    const ownerName = pulseOwner(project, cells, process.env.CELLS_PULSE_CELL ?? "pulse");
    let ok = 0, missing = 0;
    for (const cell of targets) {
      const content = await readHeartbeatContent(cell);
      if (content == null) { missing++; console.warn(`  ! ${cell}: no cached HEARTBEAT.md (run \`cells sync ${cell}\`)`); continue; }
      if (await seedPulseInbox(ownerWell, cell, content)) ok++;
    }
    console.log(`reseeded ${ok}/${targets.length} ${project} cell schedules into ${ownerName}${missing ? ` (${missing} uncached)` : ""}`);
    return;
  }

  if (args[0] === "--tail") {
    // Tail every registered pulse, not just the global one — once a project
    // runs its own <project>-pulse, its fires live in that well's log. Each is
    // labelled so a project pulse's activity isn't invisible.
    const globalName = process.env.CELLS_PULSE_CELL ?? "pulse";
    const cells = (await loadRegistry()).cells;
    const pulses = cells
      .filter((c) => c.special && c.status !== "warming" && (c.name === globalName || isPulseName(c.name)))
      .map((c) => c.name);
    if (!pulses.length) {
      console.error(`(no pulse cell in registry — name="${globalName}". Try \`cells birth-special pulse\`.)`);
      return;
    }
    for (const name of pulses) {
      if (pulses.length > 1) console.log(`\n── ${name} ──`);
      const r = await wellExecCapture(
        await wellNameForCell(name),
        "tail -n 100 /root/.cells/logs/cron-fires.log 2>/dev/null || echo '(no fires logged yet)'",
      ).catch(() => null);
      if (r) { process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); }
      else console.warn(`(couldn't reach ${name})`);
    }
    return;
  }

  if (!existsSync(heartbeatsMd)) {
    console.error("(no digest yet — has pulse run? try `cells birth-special pulse`)");
    return;
  }

  const md = await readFile(heartbeatsMd, "utf-8");
  if (args[0]) {
    // Filter to rows mentioning the named cell. Header survives.
    const lines = md.split("\n");
    const filtered: string[] = [];
    let inTable = false;
    for (const line of lines) {
      if (line.startsWith("| cell |") || line.startsWith("|---|")) {
        filtered.push(line);
        inTable = true;
        continue;
      }
      if (!inTable) {
        filtered.push(line);
        continue;
      }
      if (line.startsWith("|") && line.includes(`| ${args[0]} |`)) {
        filtered.push(line);
        continue;
      }
      if (!line.startsWith("|")) {
        filtered.push(line);
        inTable = false;
      }
    }
    console.log(filtered.join("\n"));
    return;
  }

  console.log(md);
}

async function dreamMother(): Promise<boolean> {
  console.log(`→ dreaming mother`);
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "Run the dream tool to consolidate your memory.",
      "--dangerously-skip-permissions",
    ],
    {
      cwd: MOTHER_ROOT,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await proc.exited;
  const ok = code === 0;
  console.log(ok ? `✓ mother` : `✗ mother (exit ${code})`);
  return ok;
}

async function cmdSee(name: string) {
  const url = `https://${name}.cells.md`;
  console.log(`opening ${url}`);
  Bun.spawn(["open", url], { stdout: "inherit", stderr: "inherit" });
}

async function cmdDream(arg: string) {
  if (!arg) {
    console.error("usage: cells dream <name|mother|--all>");
    process.exit(1);
  }
  if (arg === "--all") {
    const reg = await loadRegistry();
    let okCount = 0;
    let failCount = 0;
    for (const cell of reg.cells) {
      const ok = await dreamOne(cell.name);
      ok ? okCount++ : failCount++;
    }
    const ok = await dreamMother();
    ok ? okCount++ : failCount++;
    console.log(`\n${okCount} ok, ${failCount} failed`);
    if (failCount > 0) process.exit(1);
    return;
  }
  if (arg === "mother" || arg === "self") {
    const ok = await dreamMother();
    if (!ok) process.exit(1);
    return;
  }
  await requireCell(arg);
  const ok = await dreamOne(arg);
  if (!ok) process.exit(1);
}

// ───── sync (Obsidian vault) ─────

const VAULT_DIR = join(homedir(), "Obsidian", "cells");

async function wellsToken(): Promise<string> {
  // Cells run on welld locally; the bearer token welld writes at first start
  // is the source of truth. WELL_TOKEN env override is honored mainly for
  // host-side scripts that already had it injected (e.g. mother's wellsEnv).
  if (process.env.WELL_TOKEN) return process.env.WELL_TOKEN;
  const tokenPath = join(homedir(), ".wells", "token");
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, "utf-8").trim();
  }
  console.error("welld token not found at ~/.wells/token — start welld first");
  process.exit(1);
}

async function api(path: string): Promise<any> {
  const token = await wellsToken();
  const base = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`api ${path} → ${r.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type WellInfo = {
  status: string;
  url: string | null;
  created_at: string;
  last_running_at: string | null;
  egress: string;
};

async function getWellInfo(nameOrCell: string): Promise<WellInfo> {
  // Accept either a well name or a cell name. For hatched cells, the
  // well name is the egg's permanent name (cell name ≠ well name);
  // resolve here so the API call hits the right well. Well-only
  // callers pass a name not in the cell registry — wellNameForCell
  // returns the input unchanged in that case.
  const name = await wellNameForCell(nameOrCell);
  return getWellInfoByWellName(name);
}

async function getWellInfoByWellName(name: string): Promise<WellInfo> {
  const [well, policy] = await Promise.all([
    api(`/v1/wells/${encodeURIComponent(name)}`),
    api(`/v1/wells/${encodeURIComponent(name)}/policy/network`).catch(() => null),
  ]);
  const egress = policy?.rules
    ? policy.rules.map((r: any) => `${r.action} ${r.domain}`).join(", ")
    : "(unknown)";
  return {
    status: well.status ?? "?",
    url: well.url ?? null,
    created_at: well.created_at,
    last_running_at: well.last_running_at ?? null,
    egress,
  };
}

function fmtAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

type ExtensionMeta = {
  description: string;
  tools: Array<{ name: string; description: string }>;
  hooks: string[];
};

function parseExtensionTs(source: string): ExtensionMeta {
  // 1. Leading /** ... */ block becomes the extension's description.
  // Preserve paragraph breaks (blank lines stay blank), strip leading "* ".
  let description = "";
  const m = source.match(/^\/\*\*([\s\S]*?)\*\//);
  if (m) {
    description = m[1]
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, ""))
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
  }

  // 2. Each pi.registerTool({...}) call: extract name + description from a window.
  const tools: Array<{ name: string; description: string }> = [];
  const startRe = /pi\.registerTool\s*\(\s*\{/g;
  let startMatch: RegExpExecArray | null;
  while ((startMatch = startRe.exec(source)) !== null) {
    const window = source.slice(startMatch.index, startMatch.index + 4000);
    const nameM = window.match(/name:\s*"([^"]+)"/);
    if (!nameM) continue;
    const descM = window.match(/description:\s*\n?\s*"((?:[^"\\]|\\.)*)"/);
    tools.push({
      name: nameM[1],
      description: descM
        ? descM[1].replace(/\\"/g, '"').replace(/\s+/g, " ").trim()
        : "",
    });
  }

  // 3. Lifecycle hooks: pi.on("event_name", ...).
  const hooks: string[] = [];
  const hookRe = /pi\.on\s*\(\s*["']([^"']+)["']/g;
  let hookMatch: RegExpExecArray | null;
  while ((hookMatch = hookRe.exec(source)) !== null) {
    if (!hooks.includes(hookMatch[1])) hooks.push(hookMatch[1]);
  }

  return { description, tools, hooks };
}

function renderExtensionMd(extName: string, meta: ExtensionMeta): string {
  const lines = [`# ${extName}`, ""];
  if (meta.description) lines.push(meta.description, "");
  if (meta.tools.length > 0) {
    lines.push("## Tools", "");
    for (const t of meta.tools) {
      lines.push(t.description ? `- **${t.name}** — ${t.description}` : `- **${t.name}**`);
    }
    lines.push("");
  }
  if (meta.hooks.length > 0) {
    lines.push("## Hooks", "");
    for (const h of meta.hooks) lines.push(`- \`${h}\``);
    lines.push("");
  }
  if (meta.tools.length === 0 && meta.hooks.length === 0) {
    lines.push("_No tools or hooks registered (or parser missed them)._");
  }
  return lines.join("\n");
}

async function wellExecCapture(
  name: string,
  script: string,
  opts?: { user?: "root" | "well" },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  // Wells's wells (2026-05-09 base) exhibit intermittent SSH resets:
  // `kex_exchange_identification: read: Connection reset by peer` on
  // an otherwise-fine well, no auto-sleep, no OOM. Wells team is
  // investigating. Retry once with a brief backoff on that specific
  // signature so a single flaky connection doesn't fail the whole bake.
  //
  // user: when omitted, no `--user` is passed and `well exec`'s own default
  // applies — as of the 2026-05-22 wells change (6488eaf) that's `--user
  // root` with HOME=/root, so a bare call already lands in the cell's
  // context. Pass user="root" to additionally wrap in an explicit
  // `sudo … HOME=/root`: redundant belt over the wells default, kept so a
  // call site's correctness doesn't hinge on the substrate version. Either
  // way tools that key off HOME (codex via CODEX_HOME, claude via .claude)
  // find their /root config. The "well" literal just means "pass no
  // --user"; it no longer implies the command runs as the well user.
  const KEX_RESET = /kex_exchange_identification|Connection reset by peer/i;
  const user = opts?.user ?? "well";
  const args =
    user === "root"
      ? ["well", "exec", "-s", name, "--", "sudo", "bash", "-lc", `export HOME=/root; ${script}`]
      : ["well", "exec", "-s", name, "--", "bash", "-lc", script];
  for (let attempt = 0; attempt < 2; attempt++) {
    const proc = Bun.spawn(args, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code === 0) return { ok: true, stdout, stderr };
    if (attempt === 0 && KEX_RESET.test(stderr)) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    return { ok: false, stdout, stderr };
  }
  return { ok: false, stdout: "", stderr: "wellExecCapture: unreachable" };
}

// Like wellExecCapture, but feeds `input` to the remote command's stdin. The
// default `well exec` path is plain `ssh` (no PTY) with stdin inherited, so
// whatever we hand Bun's stdin flows: cells.ts → well → ssh → the remote
// `bash -lc`. This is how `cells secret set` ships a value WITHOUT it ever
// appearing in argv (ps/history/exec logs) — the script reads it with `cat`.
async function wellExecStdin(
  name: string,
  script: string,
  input: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const KEX_RESET = /kex_exchange_identification|Connection reset by peer/i;
  const args = ["well", "exec", "-s", name, "--", "bash", "-lc", script];
  for (let attempt = 0; attempt < 2; attempt++) {
    const proc = Bun.spawn(args, {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code === 0) return { ok: true, stdout, stderr };
    if (attempt === 0 && KEX_RESET.test(stderr)) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    return { ok: false, stdout, stderr };
  }
  return { ok: false, stdout: "", stderr: "wellExecStdin: unreachable" };
}

async function pullMarkdown(nameOrCell: string, vaultPath: string): Promise<{ persona: string | null }> {
  // Accept cell name OR well name; resolve internally so hatched cells
  // (cell name ≠ well name) well_exec hits the right target.
  const name = await wellNameForCell(nameOrCell);
  await mkdir(vaultPath, { recursive: true });
  // Pull the agent's anatomy files at the root (AGENTS.md is the entrypoint;
  // SOUL/IDENTITY/TOOLS/CELLS/CONTACTS/MEMORY/HEARTBEAT are the sharded
  // OpenClaw-style files that compose into systemPrompt or live as pure
  // observability), plus state/ and the .pi/ markdown trees, plus
  // .pi/settings.json so Pete can browse harness config directly in
  // Obsidian. tar emits two streams (md + json) joined by a single find.
  const findScript = `cd /root && { find AGENTS.md CLAUDE.md SOUL.md IDENTITY.md TOOLS.md CELLS.md CONTACTS.md MEMORY.md HEARTBEAT.md state/memory state/wiki .pi/skills .pi/prompts \\( -name '*.md' -o -name 'SKILL.md' \\) -type f 2>/dev/null; [ -f .pi/settings.json ] && echo .pi/settings.json; } | tar czf - -T -`;
  // Post-extract we collapse state/memory -> memory and state/wiki -> wiki so
  // the vault stays flat. Pete reads it in Obsidian; one fewer level to click.
  const send = Bun.spawn(["well", "exec", "-s", name, "--", "bash", "-lc", findScript], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const recv = Bun.spawn(["tar", "xzf", "-", "-C", vaultPath], {
    stdin: send.stdout,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [sendCode, recvCode] = await Promise.all([send.exited, recv.exited]);
  if (sendCode !== 0) {
    const err = await new Response(send.stderr).text();
    throw new Error(`well exec for ${name} failed: ${err.trim() || `exit ${sendCode}`}`);
  }
  if (recvCode !== 0) {
    const err = await new Response(recv.stderr).text();
    // Empty archive is benign — tar emits a warning but exits non-zero.
    if (!/empty archive/i.test(err)) throw new Error(`tar extract failed: ${err.trim()}`);
  }
  // Vault mirrors the cell's filesystem: anatomy .md files at root,
  // .pi/skills/ and .pi/prompts/ under .pi/, state/memory/ and state/wiki/
  // under state/. No reshaping. The only synthetic artifact is the
  // dashboard AGENTS.md that renderAgents writes over the top.
  return await restructureVault(vaultPath);
}

/**
 * After pullMarkdown drops files into vaultPath under their on-cell paths
 * (`AGENTS.md`, `SOUL.md`, `.pi/skills/...`, `state/memory/...`, etc.),
 * restructure to vault shape:
 *   - `SOUL.md` → captured as persona (the use-max systemPrompt source) and
 *     left in place for browsing.
 *   - `AGENTS.md` (the cell's thin entrypoint) → removed; renderAgents
 *     writes a richer dashboard AGENTS.md in its place.
 *   - `.pi/` → renamed to `pi/` so Obsidian's file explorer surfaces it
 *     (Obsidian hides dotfile directories by default).
 *   - Everything else → left exactly where it was pulled. The vault
 *     mirrors the cell's directory layout: .md anatomy files at root,
 *     pi/skills/, pi/prompts/, state/memory/, state/wiki/ all preserved.
 */
async function restructureVault(vaultPath: string): Promise<{ persona: string | null }> {
  let persona: string | null = null;
  const soulSrc = join(vaultPath, "SOUL.md");
  if (existsSync(soulSrc)) {
    persona = await readFile(soulSrc, "utf-8");
  }

  // The cell's AGENTS.md is the thin cross-harness entrypoint, not the
  // persona. renderAgents writes a richer vault dashboard over the top,
  // so drop the pulled one to avoid leaving stale content behind during
  // a partial run.
  const agentsSrc = join(vaultPath, "AGENTS.md");
  if (existsSync(agentsSrc)) await rm(agentsSrc);

  // Rename .pi → pi so Obsidian shows the dir. The cell uses .pi (harness
  // convention); the vault drops the dot purely for visibility.
  const pulledPi = join(vaultPath, ".pi");
  const vaultPi = join(vaultPath, "pi");
  if (existsSync(pulledPi)) {
    if (existsSync(vaultPi)) await rm(vaultPi, { recursive: true, force: true });
    const { rename } = await import("node:fs/promises");
    await rename(pulledPi, vaultPi);
  }

  return { persona };
}

async function pullExtensionDocs(nameOrCell: string, vaultPath: string): Promise<Array<{ name: string; meta: ExtensionMeta }>> {
  // Accept cell name OR well name; resolve internally for hatched cells.
  const name = await wellNameForCell(nameOrCell);
  // List extensions, then cat each index.ts.
  const list = await wellExecCapture(name, "ls -1 /root/.pi/extensions/ 2>/dev/null");
  if (!list.ok) return [];
  const exts = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  // Mirror the cell layout: synthesized doc lands as .pi/extensions/<name>.md
  // (sibling to where each extension's <name>/index.ts would be on the cell).
  const extDir = join(vaultPath, "pi", "extensions");
  await mkdir(extDir, { recursive: true });
  const results: Array<{ name: string; meta: ExtensionMeta }> = [];
  for (const ext of exts) {
    const cat = await wellExecCapture(name, `cat /root/.pi/extensions/${ext}/index.ts 2>/dev/null`);
    if (!cat.ok || !cat.stdout) continue;
    const meta = parseExtensionTs(cat.stdout);
    await writeFile(join(extDir, `${ext}.md`), renderExtensionMd(ext, meta));
    results.push({ name: ext, meta });
  }
  return results;
}

async function readLocalExtensionDocs(extensionsDir: string, vaultExtDir: string): Promise<Array<{ name: string; meta: ExtensionMeta }>> {
  if (!existsSync(extensionsDir)) return [];
  // Include both directories and symlinks-to-directories. Easiest: just look
  // for entries that have an index.ts at <name>/index.ts.
  const entries = await readdir(extensionsDir);
  await mkdir(vaultExtDir, { recursive: true });
  const results: Array<{ name: string; meta: ExtensionMeta }> = [];
  for (const name of entries) {
    const indexPath = join(extensionsDir, name, "index.ts");
    if (!existsSync(indexPath)) continue;
    const source = await readFile(indexPath, "utf-8");
    const meta = parseExtensionTs(source);
    await writeFile(join(vaultExtDir, `${name}.md`), renderExtensionMd(name, meta));
    results.push({ name, meta });
  }
  return results;
}

function splitFrontmatter(md: string): { fm: string; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { fm: "", body: md };
  return { fm: m[1], body: m[2].replace(/^\n+/, "") };
}

function firstBodyLine(content: string, max = 120): string {
  const { body } = splitFrontmatter(content);
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) continue; // skip headings
    if (t.startsWith("```")) continue;
    let s = t.replace(/^[*_-]\s*/, "").replace(/[*_]/g, "");
    if (s.length > max) s = s.slice(0, max - 1) + "…";
    return s;
  }
  return "";
}

function firstHeading(content: string): string {
  const { body } = splitFrontmatter(content);
  for (const line of body.split("\n")) {
    if (line.startsWith("#")) return line.replace(/^#+\s*/, "").trim();
  }
  return "";
}

type MemoryContext = {
  topicals: Array<{ filename: string; title: string; preview: string }>;
  yearnings: Array<{ filename: string; title: string; body: string }>;
  activityTail: string[];
  lastDream: string | null;
};

async function gatherMemoryContext(memDir: string): Promise<MemoryContext> {
  const ctx: MemoryContext = { topicals: [], yearnings: [], activityTail: [], lastDream: null };
  if (!existsSync(memDir)) return ctx;

  const entries = await readdir(memDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name === "MEMORY.md") continue;
    const content = await readFile(join(memDir, e.name), "utf-8");
    ctx.topicals.push({
      filename: e.name,
      title: firstHeading(content) || e.name.replace(/\.md$/, ""),
      preview: firstBodyLine(content),
    });
  }
  ctx.topicals.sort((a, b) => a.filename.localeCompare(b.filename));

  const yDir = join(memDir, "yearnings");
  if (existsSync(yDir)) {
    const ys = await readdir(yDir);
    for (const f of ys) {
      if (!f.endsWith(".md")) continue;
      const content = await readFile(join(yDir, f), "utf-8");
      const { body } = splitFrontmatter(content);
      ctx.yearnings.push({
        filename: f,
        title: firstHeading(content) || f.replace(/\.md$/, ""),
        body: body.replace(/^#+.*$/m, "").trim(),
      });
    }
    ctx.yearnings.sort((a, b) => a.filename.localeCompare(b.filename));
  }

  const activityFile = join(memDir, "project_cells_activity.md");
  if (existsSync(activityFile)) {
    const lines = (await readFile(activityFile, "utf-8")).split("\n").filter(Boolean);
    ctx.activityTail = lines.slice(-10);
  }

  const dreamMarker = join(memDir, ".last-dream");
  if (existsSync(dreamMarker)) {
    const s = await stat(dreamMarker);
    ctx.lastDream = fmtAge(s.mtime.toISOString());
  }

  return ctx;
}

function renderAgents(
  name: string,
  info: WellInfo | null,
  persona: string | null,
  exts: Array<{ name: string; meta: ExtensionMeta }>,
  skills: string[],
  mem: MemoryContext,
): string {
  // Frontmatter — preserve persona's frontmatter, augment with live state.
  let personaFm = "";
  let personaBody = "";
  if (persona) {
    const split = splitFrontmatter(persona);
    personaFm = split.fm;
    personaBody = split.body;
  }

  const fmLines: string[] = [];
  if (personaFm) fmLines.push(personaFm);
  if (info) {
    fmLines.push(`status: ${info.status}`);
    if (info.url) fmLines.push(`url: ${info.url}`);
    fmLines.push(`last_seen: ${fmtAge(info.last_running_at)}`);
    fmLines.push(`egress: ${info.egress}`);
  } else {
    fmLines.push(`status: local (mother, runs on Mac)`);
  }

  const out: string[] = [];
  out.push("---", fmLines.join("\n"), "---", "");

  // Status header line — always at top, just below frontmatter, before the persona body.
  if (info) {
    const parts = [`\`status:\` ${info.status}`, `\`last seen:\` ${fmtAge(info.last_running_at)}`];
    if (info.url) parts.push(`\`url:\` [${info.url}](${info.url})`);
    parts.push(`\`egress:\` ${info.egress}`);
    out.push(parts.join(" · "), "");
  } else {
    out.push("`local mother` · runs on Pete's Mac", "");
  }

  // Persona body verbatim (it leads with its own H1).
  if (personaBody) {
    out.push(personaBody.trimEnd(), "");
  } else {
    out.push(`# ${name}`, "", "_(no persona file found)_", "");
  }

  // Extensions.
  if (exts.length > 0) {
    out.push("## Extensions", "");
    for (const e of exts) {
      // First paragraph of the JSDoc, with a leading "<name> — " stripped if
      // present (the convention is for the JSDoc to lead with the ext name,
      // which would duplicate the link text).
      let summary = (e.meta.description.split(/\n\s*\n/)[0] ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const prefix = new RegExp(`^${e.name}\\s*[—-]\\s*`, "i");
      summary = summary.replace(prefix, "");
      summary = summary.slice(0, 160);
      const tail = summary ? ` — ${summary}` : "";
      out.push(`- [${e.name}](pi/extensions/${e.name}.md)${tail}`);
    }
    out.push("");
  }

  // Skills.
  if (skills.length > 0) {
    out.push("## Skills", "");
    for (const s of skills) out.push(`- [${s}](pi/skills/${s}/SKILL.md)`);
    out.push("");
  }

  // Memory snapshot.
  out.push("## Memory", "");
  const topicalCount = `${mem.topicals.length} topical file${mem.topicals.length === 1 ? "" : "s"}`;
  const yearningCount = `${mem.yearnings.length} yearning${mem.yearnings.length === 1 ? "" : "s"}`;
  out.push(`${topicalCount} · ${yearningCount}${mem.lastDream ? ` · last dream ${mem.lastDream}` : ""}`);
  out.push("→ [MEMORY.md](state/memory/MEMORY.md)", "");

  if (mem.topicals.length > 0) {
    for (const t of mem.topicals) {
      const tail = t.preview ? ` — ${t.preview}` : "";
      out.push(`- [${t.title}](state/memory/${t.filename})${tail}`);
    }
    out.push("");
  }

  if (mem.yearnings.length > 0) {
    out.push("### Open yearnings", "");
    for (const y of mem.yearnings) {
      // Trim body to first paragraph; full body lives in the yearning file.
      const firstPara = (y.body.split(/\n\s*\n/)[0] ?? "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      out.push(`- **${y.title}** — [${y.filename}](state/memory/yearnings/${y.filename})`);
      if (firstPara) out.push(`  ${firstPara}`);
    }
    out.push("");
  }

  if (mem.activityTail.length > 0) {
    out.push("### Recent activity", "");
    out.push("```", ...mem.activityTail, "```", "");
  }

  return out.join("\n");
}

async function copyMarkdownTree(srcDir: string, dstDir: string): Promise<void> {
  // Follows symlinks, copies only *.md files, recreates dir structure.
  if (!existsSync(srcDir)) return;
  await mkdir(dstDir, { recursive: true });
  const entries = await readdir(srcDir);
  for (const name of entries) {
    const srcPath = join(srcDir, name);
    const dstPath = join(dstDir, name);
    let isDir: boolean;
    try {
      isDir = statSync(srcPath).isDirectory(); // follows symlinks
    } catch {
      continue;
    }
    if (isDir) {
      await copyMarkdownTree(srcPath, dstPath);
    } else if (name.toLowerCase().endsWith(".md")) {
      await cp(srcPath, dstPath);
    }
  }
}

async function listSkills(skillsDir: string): Promise<string[]> {
  if (!existsSync(skillsDir)) return [];
  // Include symlinks-to-skill-dirs too. Test for SKILL.md presence.
  const entries = await readdir(skillsDir);
  return entries.filter((name) => existsSync(join(skillsDir, name, "SKILL.md")));
}

// Sharded anatomy files at the agent root. SOUL is the persona body; the
// rest are observability files browsable next to it. CELLS.md is cell-only;
// mother doesn't have one. Kept in declaration order for the use-max composer.
const ANATOMY_FILES = [
  "SOUL.md",
  "CELLS.md",
  "IDENTITY.md",
  "TOOLS.md",
  "CONTACTS.md",
  "MEMORY.md",
  "HEARTBEAT.md",
];

async function setupMotherVault(): Promise<void> {
  const vault = join(VAULT_DIR, "mother");
  await mkdir(vault, { recursive: true });

  // Vault mirrors mother's filesystem layout. Wipe everything that gets
  // regenerated so renames + removals land cleanly.
  for (const f of ["README.md", "AGENTS.md", "persona.md", ...ANATOMY_FILES]) {
    if (existsSync(join(vault, f))) await rm(join(vault, f));
  }
  // Wipe both old layouts: ".pi" (post-mirror, pre-no-dot) and "pi" (current),
  // plus the older hoisted dirs (extensions/, skills/, prompts/, memory/, wiki/).
  for (const d of [".pi", "pi", "state", "extensions", "skills", "prompts", "memory", "wiki"]) {
    if (existsSync(join(vault, d))) await rm(join(vault, d), { recursive: true, force: true });
  }

  // state/memory — symlink to keep mother's vault always-current. existsSync
  // follows symlinks, so a stale link reports false; use unlink + swallow ENOENT.
  await mkdir(join(vault, "state"), { recursive: true });
  const memLink = join(vault, "state", "memory");
  try { await unlink(memLink); } catch { /* not present */ }
  await symlink(join(MOTHER_ROOT, "state", "memory"), memLink);

  // .pi/skills and .pi/prompts — markdown trees, mirror mother's layout.
  const skillsSrc = join(MOTHER_ROOT, ".pi", "skills");
  await copyMarkdownTree(skillsSrc, join(vault, "pi", "skills"));

  const promptsSrc = join(MOTHER_ROOT, ".pi", "prompts");
  if (existsSync(promptsSrc)) {
    await copyMarkdownTree(promptsSrc, join(vault, "pi", "prompts"));
  }

  // Synthesized extension docs land under .pi/extensions/<name>.md as
  // siblings to where each extension's <name>/ directory would be.
  const exts = await readLocalExtensionDocs(
    join(MOTHER_ROOT, ".pi", "extensions"),
    join(vault, "pi", "extensions"),
  );

  // .pi/settings.json — copied verbatim so Pete can browse harness config
  // (extensions list, default model, enabled models) in Obsidian.
  const settingsSrc = join(MOTHER_ROOT, ".pi", "settings.json");
  if (existsSync(settingsSrc)) {
    await cp(settingsSrc, join(vault, "pi", "settings.json"));
  }

  // Copy anatomy files verbatim. Skip ones that don't exist on mother.
  for (const f of ANATOMY_FILES) {
    const src = join(MOTHER_ROOT, f);
    if (existsSync(src)) await cp(src, join(vault, f));
  }

  // Persona body for the synthesized AGENTS.md dashboard.
  const soulPath = join(MOTHER_ROOT, "SOUL.md");
  const persona = existsSync(soulPath) ? await readFile(soulPath, "utf-8") : null;

  const skills = await listSkills(join(vault, "pi", "skills"));
  const mem = await gatherMemoryContext(join(MOTHER_ROOT, "state", "memory"));
  const md = renderAgents("mother", null, persona, exts, skills, mem);
  await writeFile(join(vault, "AGENTS.md"), md);
}

async function setupPulseVault(): Promise<void> {
  const vault = join(VAULT_DIR, "pulse");
  await mkdir(vault, { recursive: true });

  // Wipe regenerated surfaces; preserve nothing — pulse is fully reproducible
  // from dna/specials/pulse/ + ~/.cells/pulse.json.
  for (const f of ["README.md", "AGENTS.md", "persona.md", ...ANATOMY_FILES]) {
    if (existsSync(join(vault, f))) await rm(join(vault, f));
  }
  for (const d of [".pi", "pi", "state", "bin"]) {
    if (existsSync(join(vault, d))) await rm(join(vault, d), { recursive: true, force: true });
  }

  // Anatomy files verbatim.
  for (const f of ANATOMY_FILES) {
    const src = join(PULSE_ROOT, f);
    if (existsSync(src)) await cp(src, join(vault, f));
  }

  // .pi/prompts and .pi/extensions docs — same shape as mother.
  const promptsSrc = join(PULSE_ROOT, ".pi", "prompts");
  if (existsSync(promptsSrc)) {
    await copyMarkdownTree(promptsSrc, join(vault, "pi", "prompts"));
  }
  const exts = await readLocalExtensionDocs(
    join(PULSE_ROOT, ".pi", "extensions"),
    join(vault, "pi", "extensions"),
  );
  const settingsSrc = join(PULSE_ROOT, ".pi", "settings.json");
  if (existsSync(settingsSrc)) {
    await cp(settingsSrc, join(vault, "pi", "settings.json"));
  }

  // state/ — pulse's vault-readable surface (heartbeats.md). Symlink
  // so changes show up live in Obsidian without re-running sync.
  const stateLink = join(vault, "state");
  try { await unlink(stateLink); } catch { /* not present */ }
  if (existsSync(join(PULSE_ROOT, "state"))) {
    await symlink(join(PULSE_ROOT, "state"), stateLink);
  }

  // Synthesized AGENTS.md dashboard. Pulse has no memory subsystem and no
  // skills directory — pass empty contexts.
  const soulPath = join(PULSE_ROOT, "SOUL.md");
  const persona = existsSync(soulPath) ? await readFile(soulPath, "utf-8") : null;
  const emptyMem: MemoryContext = { topicals: [], yearnings: [], activityTail: [], lastDream: null };
  const md = renderAgents("pulse", null, persona, exts, [], emptyMem);
  await writeFile(join(vault, "AGENTS.md"), md);
}

async function syncOneCell(name: string): Promise<{ name: string; status: string; lastRunningAt: string | null } | null> {
  const vault = join(VAULT_DIR, name);
  await mkdir(vault, { recursive: true });

  // Wipe everything that gets regenerated. Anatomy files at root come back
  // via pullMarkdown; .pi/ and state/ trees are repopulated wholesale.
  // Old hoisted layout (skills/, prompts/, memory/, yearnings/, extensions/)
  // is wiped too in case the vault was synced under the previous shape.
  for (const f of ["README.md", "AGENTS.md", "persona.md", ...ANATOMY_FILES]) {
    if (existsSync(join(vault, f))) await rm(join(vault, f));
  }
  // Wipe both old layouts: ".pi" (post-mirror, pre-no-dot) and "pi" (current),
  // plus the older hoisted dirs.
  for (const d of [".pi", "pi", "state", "extensions", "skills", "prompts", "memory", "yearnings", "wiki"]) {
    if (existsSync(join(vault, d))) await rm(join(vault, d), { recursive: true, force: true });
  }

  const { persona } = await pullMarkdown(name, vault);
  const exts = await pullExtensionDocs(name, vault);
  const info = await getWellInfo(name).catch((e) => {
    console.error(`  warn: api failed for ${name}: ${(e as Error).message}`);
    return null;
  });
  const skills = await listSkills(join(vault, "pi", "skills"));
  const mem = await gatherMemoryContext(join(vault, "state", "memory"));
  const md = renderAgents(name, info, persona, exts, skills, mem);
  await writeFile(join(vault, "AGENTS.md"), md);
  return info ? { name, status: info.status, lastRunningAt: info.last_running_at } : { name, status: "?", lastRunningAt: null };
}

async function writeRoster(rows: Array<{ name: string; status: string; lastRunningAt: string | null }>): Promise<void> {
  const lines = ["# Cells", "", "| name | status | last seen | dashboard |", "|---|---|---|---|"];
  lines.push(`| mother | local | — | [→](mother/) |`);
  lines.push(`| pulse  | local | — | [→](pulse/) |`);
  for (const r of rows) {
    lines.push(`| ${r.name} | ${r.status} | ${fmtAge(r.lastRunningAt)} | [→](${r.name}/) |`);
  }
  await writeFile(join(VAULT_DIR, "README.md"), lines.join("\n") + "\n");
}

async function cmdSync(name?: string) {
  await mkdir(VAULT_DIR, { recursive: true });

  if (name === "mother") {
    console.log("→ mother");
    await setupMotherVault();
    console.log("✓ mother");
    return;
  }

  if (name === "pulse") {
    console.log("→ pulse");
    await setupPulseVault();
    console.log("✓ pulse");
    return;
  }

  if (name) {
    await requireCell(name);
    console.log(`→ ${name}`);
    const row = await syncOneCell(name);
    console.log(`✓ ${name}`);
    // Refresh roster too (so it stays in sync).
    const reg = await loadRegistry();
    const rows: typeof row[] = [];
    for (const c of reg.cells) {
      if (c.name === name) rows.push(row);
      else {
        // Cheap: just probe live status without re-pulling files.
        const info = await getWellInfo(c.name).catch(() => null);
        rows.push({ name: c.name, status: info?.status ?? "?", lastRunningAt: info?.last_running_at ?? null });
      }
    }
    await setupMotherVault();
    await writeRoster(rows.filter((r): r is NonNullable<typeof r> => r !== null));
    return;
  }

  // No name — sync everything.
  console.log("→ mother");
  await setupMotherVault();
  console.log("✓ mother");

  console.log("→ pulse");
  await setupPulseVault();
  console.log("✓ pulse");

  const reg = await loadRegistry();
  const rows = await Promise.all(
    reg.cells.map(async (c) => {
      console.log(`→ ${c.name}`);
      try {
        const r = await syncOneCell(c.name);
        console.log(`✓ ${c.name}`);
        return r;
      } catch (e) {
        console.error(`✗ ${c.name}: ${(e as Error).message}`);
        return { name: c.name, status: "error", lastRunningAt: null };
      }
    }),
  );

  // Prune vault dirs for cells that no longer exist. Mother and pulse are
  // always kept; the registry tracks every other live cell. Anything else is
  // debris from a previous sync of a now-destroyed cell.
  const keep = new Set<string>(["mother", "pulse", ...reg.cells.map((c) => c.name)]);
  const entries = await readdir(VAULT_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue; // .obsidian, etc.
    if (keep.has(entry.name)) continue;
    console.log(`✗ pruning dead cell: ${entry.name}`);
    await rm(join(VAULT_DIR, entry.name), { recursive: true, force: true });
  }

  await writeRoster(rows.filter((r): r is NonNullable<typeof r> => r !== null));
  console.log(`\nvault: ${VAULT_DIR}`);
}

// ───── dispatch ─────

// Resolve a cell name to the underlying Well name. For slow-birth
// cells, well name == cell name. For hatched cells, the well is
// the pool member's permanent well (Wells doesn't support rename) and the
// cell name is just our local alias. Anything that touches the
// Wells API for a cell — well_exec, well_destroy, well info,
// the worker's WELL_HOST binding — must go through this helper.
// Cell-name → well-name resolution lives in cli/lib/resolve.ts so every
// caller (cells.ts, channels.ts, anything else) uses one definition.
// Re-exported here for the existing intra-file callers.
import { wellNameForCell } from "./lib/resolve";

// ───── pool CLI ─────
//
// `cells pool create [--model=X --extensions=A,B --packages=C,D]`  — pre-warm a
//                                                            new pool member
// `cells pool list`                                          — show pool
// `cells pool cull <id>`                                     — destroy a
//                                                            pool member by id
// `cells pool refill`                                        — bake pool up to depth
// `cells pool drain`                                         — destroy all open members
// `cells pool reconcile`                                     — diff pool.json vs welld;
//                                                            evict stale entries
//
// `--thinking` and `--channels` are deliberately NOT accepted at pool-member
// bake. Pool members are stock; thinking and channels are applied at hatch
// (per cell). Trying to pass them here errors.

async function cmdPool(args: string[]) {
  const sub = args[0];
  if (sub === "list") {
    await cmdPoolList();
    return;
  }
  if (sub === "cull") {
    if (!args[1]) {
      console.error("usage: cells pool cull <id>");
      process.exit(1);
    }
    await cmdPoolCull(args[1]);
    return;
  }
  if (sub === "refill") {
    await cmdPoolRefill();
    return;
  }
  if (sub === "drain") {
    await cmdPoolDrain(args.slice(1));
    return;
  }
  if (sub === "reconcile") {
    await cmdPoolReconcile();
    return;
  }
  if (sub === "bake-v1") {
    // V1.STEP3 manual control: bake one v1 generic egg, hibernated, ready
    // for the next cmdCreateV1Fast to consume. Refill normally happens
    // async after consumption; this command is a one-shot for testing
    // and pool seeding.
    console.log("baking one v1 egg…");
    const t0 = Date.now();
    const wellName = await bakePoolMember();
    // Look up the tier we just assigned for accurate logging.
    const pool = await loadPool();
    const tier = (pool.members.find((e) => e.well_name === wellName) as any)?.tier ?? 2;
    const state = tier === 4 ? "running" : "hibernated";
    console.log(`✓ egg '${wellName}' ${state} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  }
  // Baking is an explicit verb. `bake` is the clear name; `create` is kept
  // as a back-compat alias. NOT the no-arg default — a bare `cells pool`
  // (or `cells egg`) used to fall through here and silently spin up a VM,
  // so any status-style invocation grew the pool by one. Bare now shows
  // status (docs/BACKLOG.md "cells pool / cells egg with no args …").
  if (sub === "bake" || sub === "create") {
    await cmdPoolCreate(args.slice(1));
    return;
  }
  if (sub === undefined || sub === "status") {
    await cmdPoolList();
    return;
  }
  console.error(`unknown pool subcommand: ${sub}`);
  console.error(`usage: cells pool [status|list|bake|cull|refill|drain|reconcile]`);
  console.error(`       (bare 'cells pool' shows status; 'cells pool bake' bakes one egg)`);
  process.exit(1);
}

// `cells pool create` / `cells egg` — bake one generic egg into the pool.
// The pool is uniform: every egg is identical (variant_signature
// "v1-generic"); the cell's model / extensions / channels are applied at
// birth by the ritual, not baked. bakePoolMember does the well-create +
// provision + seal + tier decision + pool.json push. Any --model /
// --extensions / --packages args are vestigial — ignored with a warning.
async function cmdPoolCreate(args: string[]) {
  if (args.length > 0) {
    console.warn(`note: 'cells pool create' args are ignored — the pool is uniform (one generic egg shape)`);
  }
  console.log(`baking a generic pool egg…`);
  const wellName = await bakePoolMember();
  console.log(`✓ egg ${wellName} registered as open`);
}

async function cmdPoolList() {
  // Lazy reconcile: cheap defense against state drift since the last
  // command. Silent on success; logs only when it actually evicted.
  await reconcilePool({ silent: false }).catch(() => { /* don't fail list on reconcile error */ });
  const file = await loadPool();
  if (file.members.length === 0) {
    console.log("(no members in pool)");
    return;
  }
  // Two axes, never conflated: `standing` is pool membership (open =
  // unclaimed, claimed/live = taken by a birth); `power` is the VM's
  // power state (running in RAM vs hibernated on disk, from tier).
  console.log("id      standing  power       variant                                                    age       claimed_by");
  console.log("------  --------  ----------  ---------------------------------------------------------  --------  -----------");
  for (const e of file.members) {
    const id = e.id.padEnd(6);
    const standing = e.state.padEnd(8);
    const power = ((e as any).tier === 4 ? "running" : "hibernated").padEnd(10);
    const sig = e.variant_signature.padEnd(57).slice(0, 57);
    const age = fmtAge(e.born_at).padEnd(8);
    const by = e.claimed_by ?? "—";
    console.log(`${id}  ${standing}  ${power}  ${sig}  ${age}  ${by}`);
  }
}

// `cells pool reconcile` — explicit drift sweep. Same logic as the
// lazy guards but verbose by default so the operator can see what got
// evicted and what didn't.
async function cmdPoolReconcile() {
  const report = await reconcilePool({ silent: true });
  console.log(`checked_at:        ${report.checked_at}`);
  console.log(`pool_size_before:  ${report.pool_size_before}`);
  console.log(`welld_known:       ${report.welld_known}`);
  console.log(`pool_size_after:   ${report.pool_size_after}`);
  console.log(`refill_triggered:  ${report.refill_triggered}`);
  if (report.evicted.length === 0) {
    console.log("evicted:           (none — pool is in sync)");
  } else {
    console.log(`evicted (${report.evicted.length}):`);
    for (const e of report.evicted) {
      console.log(`  ${e.id}  ${e.well_name}  ← ${e.reason}`);
    }
  }
  if (report.culled.length === 0) {
    console.log("culled:            (none — pool at or under target depth)");
  } else {
    console.log(`culled (${report.culled.length} over-target):`);
    for (const c of report.culled) {
      console.log(`  ${c.id}  ${c.well_name}`);
    }
  }
  // Stale-rev culls are destructive (eggs carrying old platform DNA get
  // destroyed + rebaked at current rev) — surface them, never silently.
  if (report.stale_culled.length === 0) {
    console.log("stale-rev culled:  (none — open eggs at current DNA rev)");
  } else {
    console.log(`stale-rev culled (${report.stale_culled.length} — old DNA, rebaking at current):`);
    for (const c of report.stale_culled) {
      console.log(`  ${c.id}  ${c.well_name}  ← rev ${c.rev || "?"}`);
    }
  }
  if (report.errors.length > 0) {
    console.log("errors:");
    for (const err of report.errors) console.log(`  ${err}`);
  }
}

async function cmdPoolCull(eggId: string) {
  const file = await loadPool();
  const egg = file.members.find((e) => e.id === eggId);
  if (!egg) {
    console.error(`egg '${eggId}' not found in registry`);
    console.error(`run 'cells pool list' to see available ids`);
    process.exit(1);
  }

  // Cull is direct-well-destroy — no mother in the loop. Eggs have no
  // CF worker, no Slack channel, no vault dir, no pulse state — there's
  // nothing for mother to orchestrate. directWellDestroy is idempotent
  // (404 = success).
  console.log(`culling egg ${egg.well_name} (id: ${egg.id})`);
  const ok = await directWellDestroy(egg.well_name);

  // Always remove the pool.json entry — even if well destroy failed,
  // the entry is stale and Pete can manually `well destroy` later.
  await withPoolLock(async () => {
    const f = await loadPool();
    f.members = f.members.filter((e) => e.id !== eggId);
    await savePool(f);
  });

  if (ok) {
    console.log(`✓ egg ${eggId} culled and removed from registry`);
  } else {
    console.warn(`! egg ${eggId} removed from registry, but well destroy was uncertain — verify with 'well list'`);
  }
}

// ───── pool refill / drain — pool maintenance CLI ─────
//
// `cells pool refill` brings the pool back to V1_POOL_TARGET_DEPTH.
// Idempotent: returns immediately if the pool is already full, logs each
// bake otherwise. The V1 pool is uniform (one generic egg shape,
// variant_signature "v1-generic"), so there is no variant fan-out — just
// a single depth target.
//
// `cells pool drain` culls every open egg in the registry. Useful before
// re-baking cell-base or before quitting wells. Idempotent.

async function cmdPoolRefill() {
  // Lazy reconcile first: don't bake against stale state. Pass
  // skipRefill so we don't trigger a recursive refill before our own
  // bake pass runs.
  await reconcilePool({ silent: false, skipRefill: true }).catch(() => { /* don't fail refill on reconcile error */ });

  const current = await countOpenPoolMembers();
  if (current >= V1_POOL_TARGET_DEPTH) {
    console.log(`pool at target depth (${current}/${V1_POOL_TARGET_DEPTH})`);
    return;
  }
  console.log(`refilling pool: ${current} → ${V1_POOL_TARGET_DEPTH}…`);
  const baked = await refillPoolToDepth();
  console.log(`✓ baked ${baked} egg(s); pool now at ${await countOpenPoolMembers()}/${V1_POOL_TARGET_DEPTH}`);
}

async function cmdPoolDrain(args: string[]) {
  const yes = args.includes("-y") || args.includes("--yes");
  const file = await loadPool();
  const openEggs = file.members.filter((e) => e.state === "open");

  if (openEggs.length === 0) {
    console.log("(no open pool members to drain)");
    return;
  }

  if (!yes) {
    console.log(`about to cull ${openEggs.length} open egg${openEggs.length === 1 ? "" : "s"}:`);
    for (const e of openEggs) {
      console.log(`  ${e.id}  ${e.variant_signature}`);
    }
    console.log(`\nrun with -y to confirm`);
    return;
  }

  let culled = 0;
  for (const e of openEggs) {
    console.log(`culling ${e.well_name} (id: ${e.id})`);
    const ok = await directWellDestroy(e.well_name);
    await withPoolLock(async () => {
      const f = await loadPool();
      f.members = f.members.filter((x) => x.id !== e.id);
      await savePool(f);
    });
    if (ok) culled++;
    else console.warn(`! ${e.id} registry-removed but well destroy was uncertain`);
  }

  console.log(`✓ drained ${culled}/${openEggs.length} egg${openEggs.length === 1 ? "" : "s"}`);
}

// ───── bake — produce a forkable cell-base image ─────
//
// `cells bake [--name=cell-base]` spins up a fresh well, runs the full
// cell provision (bun, pi, terminal toolkit, DNA push, pi-ai patches,
// bashrc.d shims, login shim), rinses identity, stops the well, and
// `well image save`s the disk as a reusable image. Birth then forks from
// the saved image via `well create --from-image=<name>` — APFS clonefile
// is sub-millisecond regardless of size, so per-cell birth shrinks from
// ~5min to ~15s.
//
// Re-run when DNA or the toolchain materially changes (e.g. pi-ai bump,
// new extension default, new helper script).

type BakeOpts = {
  name?: string;
  sourceName?: string;
  keepSource?: boolean;
  force?: boolean;
  // Verify defaults true. `--no-verify` to skip the post-save fork test.
  // Verify forks a temp well from the new image, waits for DHCP + SSH,
  // and destroys it — catches broken images before birth fails on them.
  noVerify?: boolean;
  noSave?: boolean;
};

function parseBakeArgs(args: string[]): BakeOpts {
  const opts: BakeOpts = {};
  for (const a of args) {
    if (a.startsWith("--name=")) opts.name = a.slice("--name=".length);
    else if (a.startsWith("--source=")) opts.sourceName = a.slice("--source=".length);
    else if (a === "--keep-source") opts.keepSource = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--no-verify") opts.noVerify = true;
    else if (a === "--no-save") opts.noSave = true;
    else {
      console.error(`unknown flag: ${a}`);
      console.error("usage: cells bake [--name=cell-base] [--source=<temp-well>] [--keep-source] [--force] [--no-verify] [--no-save]");
      process.exit(1);
    }
  }
  return opts;
}

async function cmdBake(opts: BakeOpts) {
  const imageName = opts.name ?? "cell-base";
  const sourceName = opts.sourceName ?? `bake-${Math.floor(Date.now() / 1000)}`;

  console.log(`baking image '${imageName}' via temp well '${sourceName}'`);

  // Pre-flight: welld up + image conflict
  await api("/healthz");
  const existing = await api("/v1/wells/images").catch(() => null);
  const conflict = existing?.images?.find?.((i: any) => i.name === imageName);
  if (conflict && !opts.force) {
    console.error(`image '${imageName}' already exists. Pass --force to overwrite.`);
    process.exit(1);
  }

  // 1. Create the temp well from the ubuntu base. Wells team's
  //    ubuntu-25.10-base (2026-05-09 onward) ships with bun, node, npm,
  //    pi, pi-web-access, and the apt baseline (tmux/micro/fzf/rg/bat)
  //    pre-installed — so bake's job collapsed to "push cells-specific
  //    DNA + apply patches + save." Default 1GB memory is fine since
  //    we no longer run installs.
  console.log(`→ create well ${sourceName} (from ubuntu base)`);
  const create = Bun.spawn(["well", "create", sourceName], {
    stdout: "inherit", stderr: "inherit",
  });
  if (await create.exited !== 0) {
    console.error(`well create failed`);
    process.exit(1);
  }

  let imageWasSaved = false;
  try {
    // 2. Wait for first-boot identity injection to complete
    console.log(`→ wait for well-firstboot done`);
    await waitForCloudInit(sourceName);

    // 2b. (Removed) — as of wells-stable-2026-05-12h ubuntu-base ships the
    //     cell user, /root home, cell sudoers, ubuntu→cell delegation, and
    //     /root/.ssh/authorized_keys. Cells-side useradd is no-op now.

    // 3. Push DNA — cells-specific package.json, .pi/, scripts/, site/, etc.
    console.log(`→ push DNA → /root`);
    await pushLocalDirToWell(sourceName, DNA_DIR, "/root");

    // 3b. Write the per-cell tmux config template (placeholders for cell
    //     name + bg/fg color get filled in at birth time, step 3b of the
    //     mother skill). The template lives in the cells repo so we don't
    //     ship it via DNA — DNA is the agent's data, this is its terminal.
    console.log(`→ write /root/.tmux.conf template`);
    const tmuxConf = await readFile(join(REPO_ROOT, "scripts/cell-tmux.conf"), "utf-8");
    // Write as root via tee. Avoids quoting hell — tmux conf contains
    // single quotes (in comments and bind-key strings) that would fight
    // any `bash -c '...'` wrapping.
    const writeTmux = await wellExecCapture(
      sourceName,
      `sudo tee /root/.tmux.conf >/dev/null <<'__TMUX_EOF__'\n${tmuxConf}\n__TMUX_EOF__`,
    );
    if (!writeTmux.ok) {
      throw new Error(`write tmux conf failed: ${writeTmux.stderr.slice(0, 200)}`);
    }

    // 4a. Install pi globally. Wells's ubuntu-25.10-base used to ship pi
    //     pre-installed, but the -10g rebake (2026-05-10) dropped it to keep
    //     the base minimal. Cells owns its agent stack — pi belongs in our
    //     bake recipe, not in wells's substrate. npm install -g lands the
    //     binary at /usr/local/bin/pi and modules at /usr/lib/node_modules/.
    //     Also bun for the well user (cells's CLI uses bun; pi tooling does
    //     too in places). Bun's installer is a one-liner curl|bash that
    //     drops a tarball at ~/.bun. Both are best-effort idempotent.
    console.log(`→ install pi globally + bun for root`);
    const installTools = await wellExecCapture(
      sourceName,
      `set -euo pipefail
sudo npm install -g @mariozechner/pi-coding-agent
# Bun for root: the agent runs as root (HOME=/root), so install into
# /root/.bun. cells-env.sh puts /root/.bun/bin on the cell's PATH.
if [ ! -x /root/.bun/bin/bun ]; then
  sudo bash -lc 'export HOME=/root; curl -fsSL https://bun.sh/install | bash'
fi
echo "pi: $(/usr/bin/pi --version 2>&1 | head -1 || /usr/local/bin/pi --version 2>&1 | head -1 || echo MISSING)"
echo "bun: $(/root/.bun/bin/bun --version 2>&1 | head -1 || echo MISSING)"`,
    );
    if (!installTools.ok) {
      throw new Error(`install pi+bun failed: ${installTools.stderr.slice(0, 400) || installTools.stdout.slice(0, 400)}`);
    }

    // 4b. Patch the just-installed pi (anthropic baseUrl → proxy.cells.md,
    //    codex extractAccountId neutralized, adaptive thinking unclamped).
    //    Global install lands at /usr/lib/node_modules/@mariozechner/... —
    //    root-owned. Run the patch script with sudo so sed -i works there.
    console.log(`→ apply pi patches`);
    const patch = await wellExecCapture(
      sourceName,
      `sudo bash /root/scripts/apply-pi-patches.sh`,
    );
    if (!patch.ok) {
      throw new Error(`apply-pi-patches failed: ${patch.stderr.slice(0, 400) || patch.stdout.slice(0, 400)}`);
    }

    // 5. System-wide env shim at /etc/profile.d/cells-env.sh (replaces the
    //    old per-user ~/.bashrc.d/ shims). /etc/profile.d is sourced by
    //    every login shell automatically — no .profile dance, no per-user
    //    install, survives any /home rinse, works for both `well` and
    //    `cell` users.
    console.log(`→ write /etc/profile.d/cells-env.sh`);
    await bakeWriteProfileD(sourceName);

    // 7. Make /root/bin/cells executable. /root/bin is on root's PATH
    //    via /etc/profile.d/cells-env.sh, so no symlink needed.
    const linkRes = await wellExecCapture(
      sourceName,
      `sudo chmod +x /root/bin/cells`,
    );
    if (!linkRes.ok) {
      throw new Error(`cells bin chmod failed: ${linkRes.stderr.slice(0, 200) || linkRes.stdout.slice(0, 200)}`);
    }

    // 7c. (REMOVED) well-site.service install. Bridge logic moved to the
    //     host-side daemon (cli/host-bridge.ts) which SSHs into the cell
    //     and spawns pi on demand. Cells become "just a Linux VM with pi
    //     installed" — no in-cell server. See plan: fizzy-wobbling-globe.md.

    // 7b. Force fs journal commit before save. Empirically (2026-05-10)
    //     wells's server-side `stop+save` can hard-kill the guest before
    //     ext4's commit=30 timer fires, dropping unsync'd writes. /etc/passwd
    //     survives (PAM fsyncs) but our /root tree, /etc/profile.d shim,
    //     and pi-patch sed-edits do not. Explicit `sync` here flushes.
    console.log(`→ sync filesystem before save`);
    const syncRes = await wellExecCapture(sourceName, `sudo sync && sudo sync`);
    if (!syncRes.ok) {
      throw new Error(`sync failed: ${syncRes.stderr.slice(0, 200)}`);
    }
    // --no-save: bail before the wells-side rinse fires. Used to debug the
    // recipe's interaction with rinse — source stays alive with full
    // identity bits so we can ssh in and audit state pre-rinse.
    if (opts.noSave) {
      console.log(`(--no-save: stopping before rinse+clonefile. Source well '${sourceName}' kept with full identity. SSH it with: well exec -s ${sourceName} -- …)`);
      return;
    }
    // Identity rinse runs server-side now via POST /v1/wells/images
    // {validate:true} — wells team's 335c86b ships rinseGuest +
    // shutdownGuest. Wipes machine-id, /etc/.well-ready, network state,
    // host SSH keys, and authorized_keys before clonefile. Cells doesn't
    // need a manual `rm /etc/.well-ready` anymore.

    // 8. Stop the source well, then snapshot it. Wells team retired the
    //    SSH-side rinse (the old `clean:true` flag); identity reset on fork
    //    is now handled by cloud-init's instance-id detection re-running
    //    runcmd on the cloned VM. POST /v1/wells/images requires the source
    //    to be stopped (409 well_running otherwise) — clonefile of a hot
    //    disk would tear.
    if (conflict && opts.force) {
      console.log(`→ delete existing image '${imageName}' (--force)`);
      const del = await fetch(`http://127.0.0.1:7878/v1/wells/images/${encodeURIComponent(imageName)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await wellsToken()}` },
      });
      if (!del.ok && del.status !== 404) {
        throw new Error(`image delete failed: ${del.status} ${await del.text()}`);
      }
    }
    // POST /v1/wells/images {validate:true} (wells 335c86b) does the
    // rinse + SSH-shutdown + wait-for-disk-release + clonefile in one
    // server-side step. We don't need a separate /stop call anymore;
    // welld handles the lifecycle internally and only returns once the
    // image is fork-ready.
    console.log(`→ save image '${imageName}' (with validate=true rinse)`);
    const saveRes = await fetch(`http://127.0.0.1:7878/v1/wells/images`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await wellsToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: imageName, from_well: sourceName, validate: true }),
    });
    if (!saveRes.ok) {
      throw new Error(`image save failed: ${saveRes.status} ${await saveRes.text()}`);
    }
    imageWasSaved = true;

    const meta = await saveRes.json().catch(() => null);
    console.log(`✓ image '${imageName}' saved` + (meta?.size_bytes ? ` (${Math.round(meta.size_bytes / 1024 / 1024)} MB)` : ""));
  } finally {
    if (!opts.keepSource) {
      console.log(`→ destroying temp well ${sourceName}`);
      await directWellDestroy(sourceName);
    } else {
      console.log(`(keeping temp well ${sourceName} per --keep-source)`);
    }
  }

  // Verify the freshly-saved image actually forks: spin up a temp well from
  // it, require DHCP + SSH, then destroy. Catches images whose internal
  // state breaks fork-time identity reset (cloud-init runcmd missing,
  // stale machine-id, etc.) before they break a real birth.
  if (imageWasSaved && !opts.noVerify) {
    const probeName = `verify-${Math.floor(Date.now() / 1000)}`;
    console.log(`→ verify: fork '${probeName}' from '${imageName}'`);
    let verifyOk = false;
    try {
      const createRes = await fetch(`http://127.0.0.1:7878/v1/wells`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await wellsToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: probeName, from_image: imageName }),
      });
      if (!createRes.ok) {
        throw new Error(`verify fork failed at create: ${createRes.status} ${await createRes.text()}`);
      }
      // well create returns once DHCP + SSH are confirmed (per welld
      // semantics — see "create: ssh ready" in welld.log). If we got 200,
      // the substrate is healthy. Belt-and-suspenders: poll status briefly.
      let running = false;
      for (let i = 0; i < 10; i++) {
        const info = await fetch(`http://127.0.0.1:7878/v1/wells/${encodeURIComponent(probeName)}`, {
          headers: { Authorization: `Bearer ${await wellsToken()}` },
        });
        if (info.ok) {
          const j: any = await info.json().catch(() => ({}));
          if (j?.status === "running" && j?.ip) { running = true; break; }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!running) throw new Error(`verify fork '${probeName}' never reached running+ip status`);
      console.log(`✓ verify: '${imageName}' forks cleanly`);
      verifyOk = true;
    } catch (e) {
      console.error(`✗ verify failed: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`  image '${imageName}' is saved but unverified — births from it may fail.`);
      console.error(`  Inspect with 'well image info ${imageName}' or re-bake.`);
    } finally {
      console.log(`→ destroying verify well ${probeName}`);
      await directWellDestroy(probeName);
    }
    if (!verifyOk) process.exit(1);
  }

  if (!imageWasSaved) {
    process.exit(1);
  }
}

async function waitForCloudInit(name: string): Promise<void> {
  // Wells switched from cloud-init to well-firstboot.service (2026-05-09):
  //   /etc/.well-ready exists once well-firstboot has injected identity
  //   (hostname, machine-id, ssh host keys, well user, authorized_keys)
  // /var/lib/cloud/instance/boot-finished isn't written by the new path.
  // We still confirm authorized_keys to catch a mid-boot race where the
  // marker landed before SSH key injection completed (defensive).
  //
  // Non-transient signatures bail immediately rather than waste the full
  // 5-minute retry window — a stale `well` shim throws "Module not found",
  // which is indistinguishable from "still booting" to the retry loop.
  const NON_TRANSIENT = /Module not found|Permission denied \(publickey\)|Host key verification failed|command not found: well|ENOENT.*well\.ts|cli\/well\.ts/i;
  const deadlineMs = Date.now() + 5 * 60 * 1000;
  let lastErr = "";
  while (Date.now() < deadlineMs) {
    const r = await wellExecCapture(
      name,
      "test -f /etc/.well-ready && { test -s /root/.ssh/authorized_keys || test -s /home/well/.ssh/authorized_keys; } && echo ready || echo not-ready",
    ).catch((e) => ({ ok: false, stdout: "", stderr: String(e) }));
    if (r.ok && r.stdout.trim() === "ready") {
      return;
    }
    lastErr = r.stderr || r.stdout;
    if (NON_TRANSIENT.test(lastErr)) {
      throw new Error(`waitForCloudInit non-transient error on '${name}' — bailing without retry: ${lastErr.slice(0, 400)}`);
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`well-firstboot did not finish within 5min on '${name}' (last: ${lastErr.slice(0, 200)})`);
}

async function bakeInstallSystemTools(name: string): Promise<void> {
  // Bun + Node + gh tarball install. apt baseline goes through the host
  // script (handles dpkg locks + retries). Tmux config copied from the
  // in-repo template.
  //
  // Node is required for pi (#!/usr/bin/env node shebang in pi's launcher).
  // We install via the official tarball into /usr/local so node + npm land
  // on the default system PATH — works in well_exec without any shell init.
  const installScript = `set -euo pipefail

# Bun (for the agent's own bun install + pi-ai's package.json scripts)
curl -fsSL https://bun.sh/install | bash

# Node 22 LTS — pi needs node>=20.6 per its package.json engines field.
# Tarball into /usr/local so node + npm sit on default PATH.
NODE_VERSION=v22.11.0
curl -fsSL "https://nodejs.org/dist/\${NODE_VERSION}/node-\${NODE_VERSION}-linux-arm64.tar.xz" \\
  | sudo tar -xJ -C /usr/local --strip-components=1

# gh CLI (matches arm64 — wells run on Apple Silicon Virtualization.framework)
GH_VERSION=2.62.0
curl -fsSL "https://github.com/cli/cli/releases/download/v\${GH_VERSION}/gh_\${GH_VERSION}_linux_arm64.tar.gz" \\
  | sudo tar -xz -C /usr/local --strip-components=1 \\
    "gh_\${GH_VERSION}_linux_arm64/bin/gh"

mkdir -p ~/.local/bin
ln -sf /usr/bin/batcat ~/.local/bin/bat 2>/dev/null || true`;
  const r = await wellExecCapture(name, installScript);
  if (!r.ok) {
    throw new Error(`install bun/gh failed: ${r.stderr.slice(0, 400) || r.stdout.slice(0, 400)}`);
  }

  const apt = Bun.spawn(
    ["bash", join(REPO_ROOT, "scripts/apt-install-on-cell.sh"), name, "tmux", "micro", "fzf", "ripgrep", "bat"],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (await apt.exited !== 0) {
    throw new Error(`apt-install-on-cell failed`);
  }

  const tmuxConf = await readFile(join(REPO_ROOT, "scripts/cell-tmux.conf"), "utf-8");
  const writeConf = await wellExecCapture(
    name,
    `cat > ~/.tmux.conf <<'__TMUX_EOF__'\n${tmuxConf}\n__TMUX_EOF__`,
  );
  if (!writeConf.ok) {
    throw new Error(`write tmux conf failed: ${writeConf.stderr}`);
  }
}

// Push a local dir to a well, untarring as root so files land root-owned
// at a /root-rooted path. Used by the bake to lay down DNA at /root —
// `well exec` connects as user `well`, so we sudo to root for the untar.
// /root is root:root by default, so no chown ceremony is needed afterward.
async function pushLocalDirToWell(name: string, localPath: string, remotePath: string): Promise<void> {
  const tar = Bun.spawn(["tar", "czf", "-", "-C", localPath, "."], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const proc = Bun.spawn(
    ["well", "exec", "-s", name, "--", "bash", "-c",
      `sudo mkdir -p ${remotePath} && sudo bash -c 'cd ${remotePath} && tar xzf -'`],
    { stdin: tar.stdout, stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`push ${localPath} → ${name}:${remotePath} failed: ${err.slice(0, 300)}`);
  }
}

async function bakeRunBunInstall(name: string): Promise<void> {
  // pi is installed via npm -g (sudo) so its launcher lands at
  // /usr/local/bin/pi — on the default system PATH for every shell,
  // including non-interactive well_exec sessions. Bun's -g install
  // landed pi in ~/.bun/bin which isn't on PATH unless the user
  // sources their shell init, and that doesn't happen in well_exec.
  //
  // We also pre-install pi-web-access here (the only optional package
  // in OPTIONAL_PACKAGES today) so birth's step 3e is a no-op for
  // the default cell — no per-cell npm install round-trip needed.
  const r = await wellExecCapture(name, `set -euo pipefail
export PATH="$HOME/.bun/bin:/usr/local/bin:$PATH"
cd /root
bun install --frozen-lockfile
sudo npm install -g @mariozechner/pi-coding-agent@latest
# Sanity-check pi + pre-load the default extension. Both run under
# sudo + HOME=/root so the extension lands in /root/.pi/ — the tree the
# live cell reads. A bare invocation here runs as the well user and
# would install pi-web-access to /home/well/.pi/, invisible to the cell.
which pi >/dev/null && sudo bash -lc 'export HOME=/root; pi --version && pi install -l npm:pi-web-access'
chmod +x /root/bin/cells
ln -sf /root/bin/cells ~/.local/bin/cells`);
  if (!r.ok) {
    throw new Error(`bun install failed: ${r.stderr.slice(0, 400) || r.stdout.slice(0, 400)}`);
  }
}

// CELLS_ENV_SH_BODY — the body of /etc/profile.d/cells-env.sh — now lives in
// ./lib/cells-env.ts (imported at the top) so it's unit-testable in isolation.
// Used at bake time (bakeWriteProfileD), shell time (refreshShellNiceness),
// and birth (provisioning).

async function bakeWriteProfileD(name: string): Promise<void> {
  // System-wide env shim. Replaces the old per-user ~/.bashrc.d/ +
  // ~/.profile dance. /etc/profile.d/*.sh is sourced automatically by
  // every login shell (bash, sh, dash) via /etc/profile, so works for
  // cell, well, and anyone else who logs in. Survives any /home rinse
  // since it lives at /etc/. Image stays secret-free; CELLS_PROXY_SECRET
  // is injected at birth time via `well create --env CELLS_PROXY_SECRET=…`,
  // which welld writes to /etc/environment.
  const r = await wellExecCapture(name, `set -euo pipefail
sudo tee /etc/profile.d/cells-env.sh >/dev/null <<'EOF'
${CELLS_ENV_SH_BODY}EOF
sudo chmod 644 /etc/profile.d/cells-env.sh`);
  if (!r.ok) {
    throw new Error(`write /etc/profile.d/cells-env.sh failed: ${r.stderr.slice(0, 400)}`);
  }
}

// Self-heal step for `cells shell`: push the latest cells-env.sh
// before launching tmux, so existing cells pick up new niceness
// (PS1, banner) without needing a re-bake. Quick best-effort — if
// the write fails the shell still opens, just without the upgrade.
async function refreshShellNiceness(wellName: string): Promise<void> {
  try {
    // Symlink batcat → bat so the user can also type `bat` directly
    // (Ubuntu renames it batcat due to a binary-name collision with
    // the unrelated "bacula console" package). Idempotent.
    await wellExecCapture(wellName, `set -euo pipefail
sudo tee /etc/profile.d/cells-env.sh >/dev/null <<'EOF'
${CELLS_ENV_SH_BODY}EOF
sudo chmod 644 /etc/profile.d/cells-env.sh
[ -e /usr/local/bin/bat ] || sudo ln -sf /usr/bin/batcat /usr/local/bin/bat 2>/dev/null || true`);
  } catch (_) {
    // best-effort — shell opens regardless
  }
}

// `cells agents` (alias `cells fleet`) — the fleet cockpit. A launcher loop
// around the Ink view in agents-ui.tsx: render every cell grouped by project,
// and when the operator picks an action that takes over the terminal (attach
// to a cell's TUI, talk to it, birth a new one) unmount the view, run the
// action with inherited stdio, then re-render. Regroup + retag happen inside
// the view with no round-trip. This is the cells analog of `claude agents`.
async function cmdAgents(args: string[]): Promise<void> {
  let grouping: "project" | "state" = "project";
  let projectFilter: string | null = null;
  for (const a of args) {
    if (a === "--by=state" || a === "--state") grouping = "state";
    else if (a === "--by=project") grouping = "project";
    else if (a.startsWith("--project=")) projectFilter = a.slice("--project=".length).trim() || null;
  }

  // Non-interactive (piped / no TTY): print a one-shot grouped snapshot.
  // The cockpit needs a keyboard, so stdin must be a TTY too — Ink's
  // useInput sets raw mode on stdin and throws otherwise.
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    const { loadFleet, groupFleet, formatAge } = await import("./lib/fleet");
    const snap = await loadFleet();
    const cells = snap.cells.filter((c) => !projectFilter || c.project === projectFilter);
    if (!snap.welldReachable) console.log("(welld offline — power shown as unknown)");
    for (const g of groupFleet(cells, grouping)) {
      console.log(`\n${g.label}`);
      for (const c of g.cells) {
        console.log(`  ${c.power.padEnd(7)} ${c.name.padEnd(20)} ${c.harness}·${c.model}  ${formatAge(c.ageMinutes)}`);
      }
    }
    return;
  }

  const { runAgentsView } = await import("./agents-ui.tsx");
  let selectName: string | null = null;
  for (;;) {
    const res = await runAgentsView({ initialGrouping: grouping, projectFilter, selectName });
    grouping = res.grouping;
    selectName = res.selectName;
    const action = res.action;
    if (action.type === "quit") break;
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clean handoff to the child
    if (action.type === "attach") {
      await cmdTui(action.name);
    } else if (action.type === "talk") {
      await cmdTalk(action.name, []);
    } else if (action.type === "birth") {
      await cmdCreate(action.name, action.project ? { project: action.project } : {});
      selectName = action.name ?? selectName;
    }
  }
}

// `cells project <cell> [<project>]` — set or clear a cell's fleet-grouping
// project label in the registry. Omitting <project> (or "none") clears it.
// Pure Mac-side metadata — never wakes the cell.
async function cmdProject(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error("usage: cells project <cell> [<project>]   (omit project to clear)");
    process.exit(1);
  }
  const project = args.slice(1).join(" ").trim();
  const before = findCellIn((await loadRegistry()).cells, name);
  if (!before) {
    console.error(`cell '${name}' not found in registry`);
    process.exit(1);
  }
  const clearing = !project || project.toLowerCase() === "none";
  const newProject = clearing ? undefined : project;
  const globalPulse = process.env.CELLS_PULSE_CELL ?? "pulse";

  // Which pulse owns this cell's schedule BEFORE the retag.
  const oldOwner = pulseOwner(before.project, (await loadRegistry()).cells, globalPulse);

  await mutateRegistry((cells) =>
    cells.map((c) => {
      if (c.name !== name) return c;
      if (clearing) {
        const { project: _drop, ...rest } = c;
        return rest;
      }
      return { ...c, project };
    }),
  );
  console.log(clearing ? `cleared ${name}'s project` : `${name} → project '${project}'`);

  // If the retag moved this cell to a different owning pulse (e.g. into/out of
  // a project that runs its own pulse), migrate its schedule so it keeps firing
  // from exactly one pulse — seed into the new owner, then forget from the old.
  // The registry is already mutated above, so the proxy now routes this cell to
  // the new owner; we forget from the old REGARDLESS (mirroring birth) — leaving
  // it would double-fire on the cell's next edit. Unseedable → go-dark over
  // double-fire (self-heals on next edit / reseed). No-op when owner unchanged.
  const after = (await loadRegistry()).cells;
  const newOwner = pulseOwner(newProject, after, globalPulse);
  if (newOwner !== oldOwner) {
    const content = await readHeartbeatContent(name);
    const toWell = findCellIn(after, newOwner) ? await wellNameForCell(newOwner) : null;
    const fromWell = findCellIn(after, oldOwner) ? await wellNameForCell(oldOwner) : null;
    const seeded = content != null && toWell != null && (await seedPulseInbox(toWell, name, content));
    if (fromWell) await forgetCellFromPulse(fromWell, name);
    if (seeded) {
      console.log(`  moved ${name}'s schedule: ${oldOwner} → ${newOwner}`);
    } else {
      const restore = newProject ? `cells sync ${name} && cells heartbeat reseed ${newProject}` : `cells sync ${name} (re-fires on its next HEARTBEAT.md edit)`;
      console.warn(`! ${name}'s schedule ${content == null ? "is uncached" : `couldn't seed into ${newOwner}`} — dropped from ${oldOwner} to avoid a double-fire; restore with \`${restore}\``);
    }
  }
}

// cells chain <cell> [--add <entry>] [--remove <entry>] — inspect or edit a
// cell's registry modelChain. The chain is Mac-side metadata: the proxy's
// Max-policy gate reads it (a `claude-code:anthropic/...` entry licenses a
// pi cell's deep_research tool to ride the Anthropic route), and `cells
// list`/fleet display it. It is NOT the cell's runtime fallback chain — that
// lives in the cell's own .pi/settings.json and is untouched here.
async function cmdChain(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith("--")) {
    console.error("usage: cells chain <cell> [--add <entry>] [--remove <entry>]");
    console.error('  entry format: [<harness>:]<provider>/<model>:<thinking>  e.g. claude-code:anthropic/opus:high');
    process.exit(1);
  }
  const existing = findCellIn((await loadRegistry()).cells, name);
  if (!existing) {
    console.error(`cell '${name}' not found in registry`);
    process.exit(1);
  }
  const chain: string[] = Array.isArray(existing.modelChain) ? [...existing.modelChain] : [];
  let changed = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--add") {
      const entry = args[++i];
      if (!entry) { console.error("--add needs an entry"); process.exit(1); }
      if (!chain.includes(entry)) { chain.push(entry); changed = true; console.log(`+ ${entry}`); }
      else console.log(`already present: ${entry}`);
    } else if (args[i] === "--remove") {
      const entry = args[++i];
      if (!entry) { console.error("--remove needs an entry"); process.exit(1); }
      const at = chain.indexOf(entry);
      if (at >= 0) { chain.splice(at, 1); changed = true; console.log(`- ${entry}`); }
      else console.log(`not in chain: ${entry}`);
    } else {
      console.error(`unknown flag: ${args[i]}`);
      process.exit(1);
    }
  }
  if (changed) {
    // Re-read fresh under the lock and replace only this cell's chain, so a
    // concurrent writer (a birth promoting, cells model) isn't clobbered.
    await mutateRegistry((cells) => cells.map((c) => (c.name === name ? { ...c, modelChain: chain } : c)));
  }
  console.log(`${name} modelChain:`);
  for (const e of chain) console.log(`  ${e}`);
}

// cells model <cell> [<provider>/<model>:<thinking>] — the CONVERSATION
// model: what the cell's chat turns run on. Show with no entry; set with
// one. Setting edits the cell's runtime config in place (pi:
// .pi/settings.json defaults + chain head; claude-code: .claude/settings.json
// model/effortLevel), restarts the supervisor so the next turn picks it up,
// and mirrors the new head into the registry chain for display. No rebirth.
//
// This is the speed knob (Pete 2026-06-11): conversational, channel-facing
// cells chat on openai-codex/gpt-5.5:low; depth comes from the deep_research
// tool, not the chat path. The Max policy still applies — anthropic
// conversation models are claude-code-harness-only.
// Per-session model/harness (uniform-cell): write the sidecar config the cell's
// supervisor reads at dispatch (/root/.cell/session-config/<session>.json =
// {harness?, model, role?}), so one cell runs a pi/gpt-5.5 buyer session and a
// claude/opus staff session. When a session is set to claude on a non-claude
// cell, also add a `claude-code:anthropic/*` entry to the cell's registry chain
// so the proxy's Max-policy gate allows the Anthropic route (the mother pattern).
const SESSION_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
async function setSessionModel(
  name: string,
  cellHarness: string,
  session: string,
  entry: string | undefined,
  role: string,
): Promise<void> {
  if (!SESSION_NAME_RE.test(session)) {
    console.error(`bad --session name '${session}' — want [a-z][a-z0-9_-]{0,31}`);
    process.exit(1);
  }
  if (role && !SESSION_NAME_RE.test(role)) {
    console.error(`bad --role '${role}' — want [a-z][a-z0-9_-]{0,31}`);
    process.exit(1);
  }
  const wellName = await wellNameForCell(name);

  if (!entry) {
    const r = await wellExecCapture(wellName, `cat /root/.cell/session-config/${session}.json 2>/dev/null || echo '(no per-session config — uses the cell default harness/model)'`);
    console.log(`${name} session=${session}:`);
    console.log("  " + (r.ok ? r.stdout.trim() : "(live config unreadable — well may be asleep)"));
    return;
  }

  // Parse [<harness>:]<provider>/<model>:<effort>  (provider optional).
  let sessionHarness = "";
  let spec = entry;
  const hm = entry.match(/^(pi|claude-code|codex):(.+)$/);
  if (hm) { sessionHarness = hm[1]!; spec = hm[2]!; }
  const sm = spec.match(/^(?:([a-z0-9-]+)\/)?[A-Za-z0-9.:_-]+?:(minimal|low|medium|high|xhigh|max|off|none)$/);
  if (!sm) {
    console.error(`bad model spec '${spec}' — want [<harness>:]<provider>/<model>:<effort>, e.g. claude-code:anthropic/opus-4-8:medium`);
    process.exit(1);
  }
  const effHarness = sessionHarness || cellHarness;
  if (effHarness !== "pi" && effHarness !== "claude-code" && effHarness !== "codex") {
    console.error(`session harness '${effHarness}' not supported (pi | claude-code | codex)`);
    process.exit(1);
  }
  const provider = sm[1] ?? "";
  if (provider === "anthropic" && effHarness !== "claude-code") {
    console.error(`anthropic models run on a claude-code session — use: cells model ${name} --session=${session} claude-code:${spec}`);
    process.exit(1);
  }
  if (provider && provider !== "anthropic" && effHarness === "claude-code") {
    console.error(`a claude-code session only runs anthropic models — '${spec}' would be unrunnable`);
    process.exit(1);
  }

  const cfg: Record<string, string> = { model: spec };
  if (sessionHarness) cfg.harness = sessionHarness;
  if (role) cfg.role = role;
  const cfgJson = JSON.stringify(cfg); // values are validated → no shell metachars

  const writeScript = `set -euo pipefail
sudo mkdir -p /root/.cell/session-config
printf '%s' '${cfgJson}' | sudo tee /root/.cell/session-config/${session}.json >/dev/null
sudo chown -R root:root /root/.cell/session-config`;
  const r = await wellExecCapture(wellName, writeScript);
  if (!r.ok) {
    console.error(`writing session config failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
    process.exit(1);
  }

  // Proxy-gate opener: a claude session on a non-claude cell needs a
  // claude-code:anthropic/* chain entry or anthropicRouteVerdict 403s it.
  let chainNote = "";
  if (effHarness === "claude-code" && cellHarness !== "claude-code") {
    const chainEntry = `claude-code:${spec}`;
    await mutateRegistry((cells) =>
      cells.map((c) => {
        if (c.name !== name) return c;
        const chain: string[] = Array.isArray(c.modelChain) ? [...c.modelChain] : [];
        if (!chain.some((e) => e.startsWith("claude-code:anthropic/"))) chain.push(chainEntry);
        return { ...c, modelChain: chain };
      }),
    );
    chainNote = `\n  + added '${chainEntry}' to the registry chain so the proxy allows opus on this ${cellHarness} cell`;
  }
  console.log(`${name} session=${session} → ${entry}${chainNote}\n  (applies on the session's next (re)spawn — no supervisor restart needed)`);
}

async function cmdModel(args: string[]): Promise<void> {
  // Pull optional flags out first so positionals stay [cell, entry].
  // --session=<name> sets a PER-SESSION model/harness (uniform-cell), --role=<name>
  // overrides the role file the session reads (defaults to the session name).
  let sessionFlag = "";
  let roleFlag = "";
  const pos: string[] = [];
  for (const a of args) {
    if (a.startsWith("--session=")) sessionFlag = a.slice("--session=".length);
    else if (a.startsWith("--role=")) roleFlag = a.slice("--role=".length);
    else pos.push(a);
  }
  const name = pos[0];
  if (!name) {
    console.error("usage: cells model <cell> [<provider>/<model>:<thinking>]");
    console.error("  e.g. cells model advisor-pete openai-codex/gpt-5.5:low");
    console.error("  per-session: cells model <cell> --session=staff [<harness>:]<provider>/<model>:<effort>");
    console.error("  e.g. cells model advisor-pete --session=staff claude-code:anthropic/opus-4-8:medium");
    process.exit(1);
  }
  const cell = findCellIn((await loadRegistry()).cells, name);
  if (!cell) {
    console.error(`cell '${name}' not found in registry`);
    process.exit(1);
  }
  const harness = cell.harness ?? "pi";

  if (sessionFlag) { await setSessionModel(name, harness, sessionFlag, pos[1], roleFlag); return; }

  const entry = pos[1];

  if (!entry) {
    console.log(`${name} (harness=${harness})`);
    console.log(`  registry chain: ${(cell.modelChain ?? []).join("  →  ") || "(none)"}`);
    const wellName = await wellNameForCell(name);
    const probe =
      harness === "claude-code"
        ? `jq -r '"  live conversation model: " + .model + ":" + .effortLevel' /root/.claude/settings.json`
        : `jq -r '"  live conversation model: " + .defaultProvider + "/" + .defaultModel + ":" + .defaultThinkingLevel' /root/.pi/settings.json`;
    const r = await wellExecCapture(wellName, probe);
    console.log(r.ok ? r.stdout.trim() : `  (live config unreadable — well may be asleep)`);
    return;
  }

  const m = entry.match(/^([a-z0-9-]+)\/([A-Za-z0-9.:_-]+?):(minimal|low|medium|high|xhigh|max)$/);
  if (!m) {
    console.error(`bad entry '${entry}' — want <provider>/<model>:<thinking>, e.g. openai-codex/gpt-5.5:low`);
    process.exit(1);
  }
  const [, provider, model, thinking] = m;
  if (provider === "anthropic" && harness !== "claude-code") {
    console.error(
      `${name} runs the ${harness} harness — anthropic conversation models are claude-code-only (the Max policy). ` +
      `Deep Opus access for a ${harness} cell goes through the deep_research tool + ` +
      `\`cells chain ${name} --add claude-code:anthropic/opus:high\`.`,
    );
    process.exit(1);
  }
  if (provider !== "anthropic" && harness === "claude-code") {
    console.error(
      `${name} runs the claude-code harness, which only runs Anthropic models — ` +
      `writing '${entry}' would leave it with an unrunnable config. ` +
      `Fast chat needs the pi harness (rebirth, or the documented in-place flip).`,
    );
    process.exit(1);
  }
  if (harness !== "pi" && harness !== "claude-code") {
    console.error(`cells model supports pi and claude-code cells (got harness=${harness})`);
    process.exit(1);
  }

  const wellName = await wellNameForCell(name);
  const script =
    harness === "claude-code"
      ? `set -euo pipefail
jq '.model = "${model}" | .effortLevel = "${thinking}"' /root/.claude/settings.json > /tmp/cs.json
sudo mv /tmp/cs.json /root/.claude/settings.json && sudo chown root:root /root/.claude/settings.json
sudo systemctl restart well-site
sync`
      : `set -euo pipefail
jq '.defaultProvider = "${provider}" | .defaultModel = "${model}" | .defaultThinkingLevel = "${thinking}" | .modelChain = (["${provider}/${model}:${thinking}"] + ((.modelChain // [])[1:]))' /root/.pi/settings.json > /tmp/ps.json
sudo mv /tmp/ps.json /root/.pi/settings.json && sudo chown root:root /root/.pi/settings.json
sudo systemctl restart well-site
sync`;
  const r = await wellExecCapture(wellName, script);
  if (!r.ok) {
    console.error(`live config update failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
    process.exit(1);
  }

  // Mirror the new head into the registry chain AFTER the slow well-exec, by
  // re-reading fresh under the lock — the old code held a snapshot loaded
  // before the supervisor restart and saved it back, clobbering any write that
  // landed in between (a birth promoting, another cells model/chain).
  await mutateRegistry((cells) =>
    cells.map((c) => {
      if (c.name !== name) return c;
      const chain: string[] = Array.isArray(c.modelChain) ? [...c.modelChain] : [];
      if (chain.length > 0) chain[0] = entry;
      else chain.push(entry);
      return { ...c, modelChain: chain };
    }),
  );
  console.log(`${name}: conversation model → ${entry} (supervisor restarted, registry updated)`);
}

const [sub, ...rest] = process.argv.slice(2);

switch (sub) {
  case "pi":         await cmdPi(); break;
  case "birth":
  case "create": {
    // `cells birth <project> mother|pulse [--rebuild]` creates that project's
    // operator special (mother = its birther, pulse = its scheduler). Routed
    // here — before parseCreateArgs / the reserved-name guard, which both reject
    // "mother"/"pulse" — so the grammar ("<role>" inside a project means that
    // project's <role>) falls out cleanly. Bare `cells birth mother|pulse` (no
    // project) is NOT this and stays blocked.
    {
      const positionals = rest.filter((a) => !a.startsWith("--"));
      const flags = rest.filter((a) => a.startsWith("--"));
      // Mirror parseCreateArgs' brief-strip so `birth <project> <role> "brief"`
      // is recognized as the role form (and refused with a clear message)
      // instead of falling through to the misleading "'<role>' is reserved".
      const hadBrief = positionals.length > 0 && /\s/.test(positionals[positionals.length - 1]!);
      const core = hadBrief ? positionals.slice(0, -1) : positionals;
      if (core.length === 2 && (core[1] === "mother" || core[1] === "pulse")) {
        const role = core[1]!;
        const project = core[0]!;
        if (!isValidCellName(project)) {
          console.error(`bad project '${project}' — ${describeCellNameRules()}`);
          process.exit(1);
        }
        if (hadBrief) {
          console.error(`a project ${role} takes no brief — it bakes from the shared ${role} template.\n  try: cells birth ${project} ${role}`);
          process.exit(1);
        }
        // The ~1.9GB always-on cost-confirm for a project pulse lives in
        // cmdBirthSpecial (the single choke point for special births), so both
        // this path and `cells birth-special <project>-pulse` are gated. Pass
        // --yes straight through.
        const role2name = role === "pulse" ? projectPulseName(project) : projectMotherName(project);
        await cmdBirthSpecial([role2name, ...flags]);
        break;
      }
    }
    const { name, opts } = parseCreateArgs(rest);
    await cmdCreate(name, opts);
    break;
  }
  case "birth-special": await cmdBirthSpecial(rest); break;
  case "talk": {
    const targetName = needName(rest, "talk");
    await cmdTalk(targetName, rest.slice(1));
    break;
  }
  case "verify":     await cmdVerify(rest); break;
  case "run":        await cmdRun(needName(rest, "run"), rest.slice(1)); break;
  case "jobs":       await cmdJobs(needName(rest, "jobs"), rest.slice(1)); break;
  case "list":       await cmdList(); break;
  case "agents":
  case "fleet":      await cmdAgents(rest); break;
  case "project":    await cmdProject(rest); break;
  case "chain":      await cmdChain(rest); break;
  case "model":      await cmdModel(rest); break;
  case "sleep":      await cmdSleep(needName(rest, "sleep")); break;
  case "stop":       await cmdStop(needName(rest, "stop")); break;
  case "wake":       await cmdWake(needName(rest, "wake")); break;
  case "pin":        await cmdPin(needName(rest, "pin")); break;
  case "unpin":      await cmdUnpin(needName(rest, "unpin")); break;
  case "checkpoint": await cmdCheckpoint(needName(rest, "checkpoint")); break;
  case "kill":
  case "destroy":    await cmdDestroy(rest); break;
  case "dream":              await cmdDream(rest[0] ?? ""); break;
  case "tui":                await cmdTui(needName(rest, "tui"), rest.slice(1)); break;
  case "sync":               await cmdSync(rest[0] || undefined); break;
  case "schedule-pi-patches":   await cmdSchedulePiPatches(); break;
  case "unschedule-pi-patches": await cmdUnschedulePiPatches(); break;
  case "schedule-host-bridge":  await cmdScheduleHostBridge(); break;
  case "unschedule-host-bridge":await cmdUnscheduleHostBridge(); break;
  case "schedule-pool-refill":   await cmdSchedulePoolRefill(); break;
  case "unschedule-pool-refill": await cmdUnschedulePoolRefill(); break;
  case "schedule-pool-reconcile":   await cmdSchedulePoolReconcile(); break;
  case "unschedule-pool-reconcile": await cmdUnschedulePoolReconcile(); break;
  case "refresh":               await cmdRefresh(rest); break;
  case "refresh-extensions":    await cmdRefreshExtensions(rest); break;
  case "heartbeat":             await cmdHeartbeat(rest); break;
  case "channel":
  case "channels":              await cmdChannel(rest); break;
  case "doctor":             rest.includes("--json") ? await cmdDoctorJson() : await cmdDoctor(); break;
  case "shell":              await cmdShell(needName(rest, "shell")); break;
  case "exec":               await cmdExec(needName(rest, "exec"), rest.slice(1)); break;
  case "secret":             await cmdSecret(rest); break;
  case "see":                await cmdSee(needName(rest, "see")); break;
  case "pool":               await cmdPool(rest); break;
  case "egg":                await cmdPool(rest); break;  // deprecated alias
  case "bake":               await cmdBake(parseBakeArgs(rest)); break;
  case "menubar":            await cmdMenubar(rest); break;
  default:
    console.log("usage:");
    console.log("  cells pi                    open the mother Pi TUI (alias: cells talk mother)");
    console.log("  cells bake [--name=cell-base] [--force]  bake the cell-base image (one-time, ~5min)");
    console.log("  cells birth-special <mother|pulse> [--rebuild]");
    console.log("                              bake one of the named specials (cells-mother / cells-pulse), pinned always-on.");
    console.log("                              DNA template at dna/specials/<name>/. --rebuild tears down the existing well first.");
    console.log("  cells birth <name> [flags]  provision a new cell in a local well (alias: create)");
    console.log("                              flags: --harness=pi|claude-code|codex");
    console.log("                                     --model=opus|sonnet|haiku|gpt-5.5|gpt-5.5-pro");
    console.log("                                     --thinking=off|minimal|low|medium|high|xhigh|adaptive|max|auto");
    console.log("                                              (pi: off..xhigh + adaptive; claude-code: low..max + auto; codex: low..xhigh)");
    console.log("                                     --extensions=memory,mentality,wiki,dream,deep-research");
    console.log("                                     --packages=pi-web-access");
    console.log("                                     --channels=slack         (auto-creates #cells-<name>, binds, deploys worker)");
    console.log("                                     --slack-channel=C0123456789  (legacy: bind to existing channel by ID)");
    console.log("                                     --seed=<text>            (first message auto-sent post-birth; default greeting on, --seed=off disables)");
    console.log("                                     --no-pool                (skip open-egg lookup, force slow birth — testing/perf-baseline)");
    console.log("                              no flags = interactive TUI; any flag = non-interactive (defaults fill the rest)");
    console.log("  cells talk <name> [msg]     interactive bridge chat (no msg) or one-shot (with msg).");
    console.log("                              Reply streams in this terminal AND mirrors to Slack — same session as Slack.");
    console.log("                              'mother' is special: accepts any pi flag (-c, -r, --session=<id>, -p ...).");
    console.log("  cells run <name> \"<task>\" [--timeout 30m] [--session fresh|fork]");
    console.log("                              hand the cell a background JOB: returns a job id immediately, runs in a");
    console.log("                              detached session under a progress watchdog. Talk = chat; run = work.");
    console.log("                              --session fork: inherit main's context read-only, write to a throwaway");
    console.log("                              fork (main untouched); fresh (default) = no context. (main: phase 2)");
    console.log("  cells jobs <name> [<job-id>]  job status + results (DO view if the cell is asleep — never wakes it)");
    console.log("  cells tui <name>            drop into a well-side tmux shell (debug, file poking, etc).");
    console.log("  cells list                  list known cells");
    console.log("  cells sleep <name>          hibernate a cell — releases VM RAM, wakes on inbound traffic");
    console.log("  cells stop <name>           cold-stop a cell — explicit reset/recovery (use sleep for normal pause)");
    console.log("  cells wake <name>           wake a hibernated or stopped cell");
    console.log("  cells checkpoint <name>     snapshot a cell's filesystem");
    console.log("  cells dream <name|mother|--all>  run dream consolidation on a cell, the mother, or all");
    console.log("  cells sync [name]           pull cell markdown into ~/Obsidian/cells/ (default: all + mother)");
    console.log("  cells doctor                inspect mother OAuth state + proxy health (run when cells act 401-y)");
    console.log("  cells shell <name>          drop into a bash shell on a cell (separate tmux from the agent; Ctrl+D exits)");
    console.log("  cells exec <name> [--] <cmd>  run a command as root on a cell, non-interactively (HOME=/root, cells-env sourced)");
    console.log("  cells secret set <cell[,…]> <KEY> [--from-env VAR|--from-file PATH|--stdin]");
    console.log("                              ship a secret to N cells: root:root 0600 under /etc/cells.secrets.d/,");
    console.log("                              value via stdin (never argv/echoed), exported into shells+jobs+supervisor.");
    console.log("  cells secret list <cell>    list a cell's secret KEY names (never values)");
    console.log("  cells secret rm <cell[,…]> <KEY>  remove a secret from N cells");
    console.log("  cells see <name>            open https://<name>.cells.md in the browser");
    console.log("  cells schedule-pi-patches   install launchd watcher (re-applies pi patches when pi-ai is reinstalled)");
    console.log("  cells unschedule-pi-patches remove launchd watcher");
    console.log("  cells unschedule-pool-refill remove a stale pool-refill launchd plist (refill is on-birth now)");
    console.log("  cells schedule-pool-reconcile   install launchd plist (pool reconcile every 5min)");
    console.log("  cells unschedule-pool-reconcile remove pool reconcile launchd plist");
    console.log("  cells refresh <name|--all> [--dry-run] [--verify]");
    console.log("                              update a LIVE cell's infrastructure from current DNA");
    console.log("  cells refresh-extensions <name|--all> [ext...] [--restart] [--remove]");
    console.log("                              push DNA extension(s) onto existing cell(s) (default: heartbeat-watch)");
    console.log("                              --restart kicks pi on the cell so new extensions load (otherwise dormant until next pi start)");
    console.log("                              --remove deletes the extension dir + drops it from settings.json (inverse of push)");
    console.log("  cells heartbeat [name|--tail]  show pulse digest, one cell's schedule, or tail cron-fires.log");
    console.log("  cells channel link <cell> <channel-id> [--kind=slack]");
    console.log("                              bind a Slack channel to a cell (mirrors to Cloudflare KV for the Slack Worker)");
    console.log("  cells channel unlink <cell> [<channel-id>]  remove one or all bindings for a cell");
    console.log("  cells channel list           list all channel↔cell bindings");
    console.log("  cells channel sync           re-mirror channels.json to Cloudflare KV");
    console.log("  cells model <cell> [<provider>/<model>:<thinking>]");
    console.log("                              show or set the cell's CONVERSATION model (what chat runs on), live, no rebirth");
    console.log("                              e.g. cells model advisor-pete openai-codex/gpt-5.5:low");
    console.log("  cells chain <cell> [--add <entry>] [--remove <entry>]");
    console.log("                              inspect/edit the registry modelChain; a claude-code:anthropic/opus:high entry");
    console.log("                              licenses a pi cell's deep_research tool to ride the Max sub");
    console.log("  cells kill <name>... [-y]   destroy one or more cells (irreversible) (alias: destroy)");
    console.log("                              --all-but <name>... kill every cell except the listed ones");
    console.log("                              -y/--yes skip the confirmation prompt");
    process.exit(sub ? 1 : 0);
}
