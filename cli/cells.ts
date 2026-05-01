#!/usr/bin/env bun
import { $ } from "bun";
import { readFile, writeFile, mkdir, unlink, symlink, cp, readdir, stat, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CELL_REPO = dirname(SCRIPT_DIR);
const REGISTRY_DIR = join(homedir(), ".cells");
const REGISTRY_PATH = join(REGISTRY_DIR, "cells.json");

// Model registry — short name → { provider, modelId }. Anthropic doesn't
// provide a floating "claude-opus-latest" alias; the major-version-stamped
// alias is what they recommend. Bump these when a new minor ships.
const MODEL_IDS = {
  opus:                { provider: "anthropic", modelId: "claude-opus-4-7" },
  sonnet:              { provider: "anthropic", modelId: "claude-sonnet-4-6" },
  haiku:               { provider: "anthropic", modelId: "claude-haiku-4-5" },
  "gpt-5.5":           { provider: "openai-codex", modelId: "gpt-5.5" },
  "gpt-5.5-pro":       { provider: "openai",    modelId: "gpt-5.5-pro" },
  "deepseek-v4-flash": { provider: "deepseek",  modelId: "deepseek-v4-flash" },
  "deepseek-v4-pro":   { provider: "deepseek",  modelId: "deepseek-v4-pro" },
} as const;
type ModelKey = keyof typeof MODEL_IDS;

// In-tree extensions a user can opt into at create time. Each lives at
// template/.pi/extensions/<name>/ — birth pushes the whole template, then
// deletes the unselected ones from the cell.
const OPTIONAL_EXTENSIONS = ["memory", "mentality", "wiki", "dream"] as const;
type OptionalExtension = (typeof OPTIONAL_EXTENSIONS)[number];

// Curated list of npm/git packages a cell can install via `pi install`.
// Default-checked entries are pre-selected when the user enters the TUI.
const OPTIONAL_PACKAGES = [
  { value: "pi-web-access", label: "pi-web-access", hint: "web search · fetch · code search", defaultChecked: true },
] as const;

const RESERVED_NAMES = new Set([
  "mother", "keeper",
  // Names that collide with tmux/sprite plumbing.
  "tmux", "shell", "agent", "pi", "sprite", "localhost",
  // Names that collide with cells subcommands.
  "create", "birth", "talk", "list", "sleep", "wake",
  "checkpoint", "destroy", "kill", "dream", "stream", "sync", "doctor",
  "schedule-dreams", "unschedule-dreams",
]);

type SelectOption = {
  value: string;
  label: string;
  hint?: string;       // dim text after label, e.g. "(coming soon)"
  disabled?: boolean;
};

const HARNESS_OPTIONS: SelectOption[] = [
  { value: "pi",          label: "pi" },
  { value: "claude-code", label: "claude-code", hint: "(coming soon)", disabled: true },
  { value: "codex",       label: "codex",       hint: "(coming soon)", disabled: true },
];

const MODEL_OPTIONS: SelectOption[] = [
  { value: "opus",              label: "opus" },
  { value: "sonnet",            label: "sonnet" },
  { value: "haiku",             label: "haiku" },
  { value: "gpt-5.5",           label: "gpt-5.5         (sub · ChatGPT Plus)" },
  { value: "gpt-5.5-pro",       label: "gpt-5.5-pro     (api · paid)" },
  { value: "deepseek-v4-flash", label: "deepseek-v4-flash" },
  { value: "deepseek-v4-pro",   label: "deepseek-v4-pro" },
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

function thinkingOptionsFor(modelKey: ModelKey): SelectOption[] {
  return modelKey === "opus" ? [...THINKING_OPTIONS_BASE, ADAPTIVE_OPTION] : THINKING_OPTIONS_BASE;
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

const PACKAGE_OPTIONS: SelectOption[] = OPTIONAL_PACKAGES.map((p) => ({
  value: p.value,
  label: p.label,
  hint: p.hint,
}));

const PACKAGE_DEFAULTS: string[] = OPTIONAL_PACKAGES.filter((p) => p.defaultChecked).map((p) => p.value);

type Cell = { name: string; created_at: string };
type Registry = { cells: Cell[] };

async function loadRegistry(): Promise<Registry> {
  if (!existsSync(REGISTRY_PATH)) return { cells: [] };
  return JSON.parse(await readFile(REGISTRY_PATH, "utf-8"));
}

async function saveRegistry(reg: Registry): Promise<void> {
  await mkdir(REGISTRY_DIR, { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

async function findCell(name: string): Promise<Cell | undefined> {
  const reg = await loadRegistry();
  return reg.cells.find((c) => c.name === name);
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
    cwd: CELL_REPO,
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

async function runPiWithOutcome(
  slashCommand: string,
  args: string[],
): Promise<{ exit: number; outcome: Outcome | null }> {
  const outcomeFile = join(
    tmpdir(),
    `cell-outcome-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  if (existsSync(outcomeFile)) await unlink(outcomeFile);

  const message = `/${slashCommand} ${args.join(" ")}`.trim();
  const proc = spawnInRepo(["pi", "-p", message], { CELL_OUTCOME_FILE: outcomeFile });
  const exit = await proc.exited;

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
}

// ───── direct (no Pi) ─────

async function launchMotherTui(extraArgs: string[] = []) {
  // Direct pi spawn — no tmux wrapper. Pete runs this on his Mac in his own
  // terminal; there's no SSH-disconnect / hibernation problem to solve here.
  // Pi persists sessions to ~/.pi/agent/sessions/ on its own, so closing the
  // terminal and re-running picks up where you left off.
  const proc = Bun.spawn(["pi", ...extraArgs], {
    cwd: CELL_REPO,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}

async function cmdPi() {
  await launchMotherTui();
}

async function cmdList() {
  const reg = await loadRegistry();
  if (reg.cells.length === 0) {
    console.log("no cells");
    return;
  }
  for (const c of reg.cells) console.log(`${c.name.padEnd(20)} ${c.created_at}`);
}

async function cmdTalk(name: string, args: string[]) {
  if (name === "mother") {
    // Mother accepts any pi flags through (e.g. `-c`, `-r`, `--session=<id>`,
    // even `-p "msg"` for a one-shot). We don't try to interpret them; pi
    // handles its own argv.
    await launchMotherTui(args);
    return;
  }
  await requireCell(name);

  const attach = async () => {
    const proc = Bun.spawn(["sprite", "console", "-s", name], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  };

  if (args.length === 0) {
    // No args → attach to the live tmux+pi service running on the cell.
    await attach();
    return;
  }
  if (args[0]!.startsWith("-")) {
    // Cells run a single persistent pi inside tmux. We can't spawn a
    // parallel pi safely — two writers on one session file = corruption.
    // Instead, drive the LIVE pi via slash commands sent through tmux.
    const flag = args[0]!;
    if (flag === "-c" || flag === "--continue") {
      // Live pi IS the most recent session by definition — just attach.
      await attach();
      return;
    }
    if (flag === "-r" || flag === "--resume") {
      // Inject /resume into the agent tmux session so the live pi opens
      // its session picker. Then attach so the user can interact with it.
      const inject = Bun.spawn(
        ["sprite", "exec", "-s", name, "--", "tmux", "send-keys", "-t", "agent", "/resume", "Enter"],
        { stdin: "ignore", stdout: "ignore", stderr: "inherit" },
      );
      const code = await inject.exited;
      if (code !== 0) {
        console.error(`failed to inject /resume into ${name}'s tmux session (exit ${code})`);
        process.exit(1);
      }
      await attach();
      return;
    }
    console.error(
      `flag '${flag}' isn't supported for cells. Supported: -c|--continue (attach to live), -r|--resume (open picker). For arbitrary --session=<id>, attach with 'cells talk ${name}' and use /resume or /tree from inside.`,
    );
    process.exit(1);
  }
  const message = args.join(" ");
  // One-shot: spawn a fresh `pi -p` on the peer. Clean stdout (just the
  // reply), no TUI chrome, no main-session pollution. The fresh pi loads
  // the agent's persona + memory + tools via extensions, so it's still
  // "the same agent" — just an ephemeral side-conversation.
  //
  // Birth writes the .bashrc.d sourcing into ~/.profile, so `bash -lc`
  // login shells get PATH and secrets automatically. No explicit source
  // needed here.
  const escaped = message.replace(/'/g, "'\\''");
  const script = `cd /home/sprite/agent && pi -p '${escaped}'`;
  const proc = Bun.spawn(
    ["sprite", "exec", "-s", name, "--", "bash", "-lc", script],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

async function cmdShell(name: string) {
  if (name === "mother") {
    // Mother lives on this Mac. Just print where; user cd's themselves.
    // (Future: when mother might run on a dedicated host, dispatch via
    // ~/.cells/mother.json — see docs/namespacing.md for the broader plan.)
    console.log(`mother lives on this Mac. its body:`);
    console.log(`  persona:    ${CELL_REPO}/.pi/agents/self.md`);
    console.log(`  config:     ${CELL_REPO}/.pi/settings.json`);
    console.log(`  extensions: ${CELL_REPO}/.pi/extensions/`);
    console.log(`  skills:     ${CELL_REPO}/.pi/skills/`);
    console.log(`  memory:     ${CELL_REPO}/memory/`);
    console.log(`  charter:    ${CELL_REPO}/AGENTS.md`);
    console.log(`  pi data:    ${process.env.HOME}/.pi/agent/  (sessions, auth.json — shared with the proxy)`);
    console.log(`  runs from:  ${CELL_REPO}  (project root; pi auto-discovers .pi/ here)`);
    return;
  }
  await requireCell(name);
  // Spawn tmux directly under sprite exec --tty. Bypasses the login-shell
  // auto-attach shim (which would dump us into pi); inside tmux, the
  // shim's `[ -z "$TMUX" ]` guard is false, so it no-ops on subsequent
  // shell invocations.
  // -A on new-session: attach if "shell" exists, create if not.
  // bash -l inside tmux loads .profile → .bashrc.d (PATH, mf/mft, env).
  // Ctrl+D exits bash, ends the tmux session, drops us back to the Mac.
  const proc = Bun.spawn(
    [
      "sprite", "exec", "-s", name, "--tty", "--",
      "tmux", "new-session", "-A", "-s", "shell",
      "-c", "/home/sprite/agent",
      "bash", "-l",
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  await proc.exited;
}

async function cmdSleep(name: string) {
  await requireCell(name);
  await $`sprite stop -s ${name}`;
}

async function cmdWake(name: string) {
  await requireCell(name);
  await $`sprite start -s ${name}`;
}

// First-line diagnostic for "auth feels broken." See docs/oauth-refresh.md.
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
}

// ───── routed through local Pi ─────

type CreateOpts = {
  harness?: string;
  model?: ModelKey;
  thinking?: string;
  extensions?: string[];
  packages?: string[];
};

const PACKAGE_VALUES = OPTIONAL_PACKAGES.map((p) => p.value);

function parseCreateArgs(args: string[]): { name: string; opts: CreateOpts } {
  let name: string | undefined;
  const opts: CreateOpts = {};
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
      const v = a.slice("--thinking=".length);
      if (!THINKING_VALUES.includes(v)) {
        console.error(`unknown thinking level: ${v}. choose: ${THINKING_VALUES.join(", ")}`);
        process.exit(1);
      }
      opts.thinking = v;
    } else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    } else if (!name) {
      name = a;
    } else {
      console.error(`unexpected arg: ${a}`);
      process.exit(1);
    }
  }
  if (!name) {
    console.error(
      "usage: cells birth <name> [--harness=pi] [--model=opus|sonnet|haiku|gpt-5.5|gpt-5.5-pro|deepseek-v4-flash|deepseek-v4-pro] [--thinking=off|minimal|low|medium|high|xhigh|adaptive] [--extensions=memory,...] [--packages=pi-web-access,...]",
    );
    process.exit(1);
  }
  return { name, opts };
}

async function cmdCreate(name: string, opts: CreateOpts) {
  if (RESERVED_NAMES.has(name)) {
    console.error(`'${name}' is reserved. Pick another name.`);
    process.exit(1);
  }
  if (await findCell(name)) {
    console.error(`cell '${name}' already exists in registry`);
    process.exit(1);
  }

  const interactive =
    opts.harness === undefined &&
    opts.model === undefined &&
    opts.thinking === undefined &&
    opts.extensions === undefined &&
    opts.packages === undefined;

  let harness: string;
  let modelKey: ModelKey;
  let thinking: string;
  let extensions: string[];
  let packages: string[];

  if (interactive) {
    console.log(`\nbirthing cell '${name}'\n`);
    // Step machine so the user can ←/⌫ back to a previous prompt mid-flow.
    const answers: (string | string[] | undefined)[] = [];
    let i = 0;
    while (i < 5) {
      const canGoBack = i > 0;
      let result: string | string[] | Back;
      if (i === 0) {
        result = await selectOne("Harness?", HARNESS_OPTIONS, {
          initialValue: answers[0] as string | undefined,
        });
      } else if (i === 1) {
        result = await selectOne("Model?", MODEL_OPTIONS, {
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
      } else {
        result = await selectOne("Thinking?", thinkingOptionsFor(answers[1] as ModelKey), {
          canGoBack,
          initialValue: (answers[4] as string | undefined) ?? DEFAULT_THINKING,
        });
      }
      if (result === BACK) {
        // selectOne/Many cleared its own menu; rewind one more line to wipe
        // the previous prompt's summary so it can be re-rendered fresh.
        process.stdout.write("\x1b[1A\x1b[2K");
        i--;
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
  } else {
    harness = opts.harness ?? "pi";
    modelKey = opts.model ?? "opus";
    thinking = opts.thinking ?? DEFAULT_THINKING;
    extensions = opts.extensions ?? [];
    packages = opts.packages ?? PACKAGE_DEFAULTS;
    if (harness !== "pi") {
      console.error(`harness '${harness}' not yet supported (only 'pi' for v1)`);
      process.exit(1);
    }
  }

  // 'adaptive' is opus-only and means "pure adaptive, no effort hint —
  // model decides depth per-turn." Cell-side configure-cell-proxy.sh
  // patches pi-ai's mapThinkingLevelToEffort to return undefined for
  // this level, which makes the anthropic provider omit output_config.effort.
  if (thinking === "adaptive" && !ADAPTIVE_THINKING_MODELS.has(modelKey)) {
    console.error(`thinking 'adaptive' is only available for --model=opus`);
    process.exit(1);
  }

  // Some models reject low-effort thinking levels server-side. Auto-bump
  // rather than birth a cell that 400s on its first message. Warn either
  // way so Pete knows what changed.
  if (MIN_MEDIUM_THINKING_MODELS.has(modelKey) && SUB_MEDIUM_THINKING.has(thinking)) {
    console.warn(`note: ${modelKey} requires thinking ≥ medium; bumping '${thinking}' → 'medium'`);
    thinking = "medium";
  }

  const choice = MODEL_IDS[modelKey];
  const payload = {
    harness,
    provider: choice.provider,
    model: choice.modelId,
    thinking,
    extensions,
    packages,
  };

  const { outcome } = await runPiWithOutcome("cell-create", [name, JSON.stringify(payload)]);
  if (!outcome) {
    console.error("agent did not report outcome — registry not updated");
    process.exit(1);
  }
  if (!outcome.success) {
    console.error(`birth failed: ${outcome.message}`);
    process.exit(1);
  }
  const reg = await loadRegistry();
  reg.cells.push({ name, created_at: new Date().toISOString() });
  await saveRegistry(reg);
}

async function cmdDestroyOne(name: string): Promise<boolean> {
  const { outcome } = await runPiWithOutcome("cell-destroy", [name]);
  if (!outcome || !outcome.success) {
    console.error(`destroy '${name}' failed: ${outcome?.message ?? "no outcome reported"}`);
    return false;
  }
  const reg = await loadRegistry();
  reg.cells = reg.cells.filter((c) => c.name !== name);
  await saveRegistry(reg);
  return true;
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
    targets = reg.cells.map((c) => c.name).filter((n) => !keep.has(n));
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
 * Multi-turn streaming conversation with a remote agent over Pi RPC.
 *
 * Spawns `pi --mode rpc` on the agent's Sprite via `sprite exec` with
 * piped stdin/stdout. We send JSONL `prompt` commands; Pi streams events
 * back including `message_update` text_deltas and `agent_end`.
 *
 * Framing is strict LF-only — same rule as Pi's own jsonl.ts. We do NOT
 * use Node's readline (it splits on Unicode line separators which can
 * appear inside JSON string values).
 */
async function cmdStream(name: string) {
  await requireCell(name);

  const proc = Bun.spawn(
    [
      "sprite",
      "exec",
      "-s",
      name,
      "--",
      "bash",
      "-lc",
      "cd /home/sprite/agent && pi --mode rpc",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );

  let reqCounter = 0;
  let inFlight = false;
  let promptOpen = true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const showPrompt = () => {
    if (!promptOpen) return;
    rl.setPrompt(`${name}> `);
    rl.prompt();
  };

  const sendCommand = (cmd: object): void => {
    const line = `${JSON.stringify(cmd)}\n`;
    proc.stdin.write(line);
  };

  // Stream stdout: split on \n strictly, parse each line as JSON, render.
  let buffer = "";
  const onChunk = (chunk: Uint8Array) => {
    buffer += new TextDecoder().decode(chunk);
    while (true) {
      const i = buffer.indexOf("\n");
      if (i === -1) return;
      const line = buffer.slice(0, i).replace(/\r$/, "");
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        // Pi may emit non-JSON banner lines on startup (e.g. "Pi Code Agent v0.70.6")
        // Print them dimly so user sees them, then ignore for protocol purposes.
        process.stderr.write(`\x1b[2m${line}\x1b[0m\n`);
        continue;
      }
      handleEvent(event);
    }
  };

  const handleEvent = (event: any) => {
    if (event.type === "message_update") {
      const ev = event.assistantMessageEvent;
      if (ev?.type === "text_delta" && typeof ev.delta === "string") {
        process.stdout.write(ev.delta);
      }
    } else if (event.type === "agent_end") {
      process.stdout.write("\n");
      inFlight = false;
      showPrompt();
    } else if (event.type === "response" && event.success === false) {
      process.stdout.write(`\n[error] ${event.error}\n`);
      inFlight = false;
      showPrompt();
    }
  };

  // Pump stdout
  (async () => {
    const reader = proc.stdout.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) onChunk(value);
    }
  })();

  // Pump stderr (just dim and pass through)
  (async () => {
    const reader = proc.stderr.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) process.stderr.write(value);
    }
  })();

  // Read user input line-by-line
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "/exit" || trimmed === "/quit") {
      promptOpen = false;
      rl.close();
      return;
    }
    if (!trimmed) {
      showPrompt();
      return;
    }
    if (inFlight) {
      // Drop input while agent is still responding. User can /abort if needed.
      console.log("(still responding — wait or type /abort)");
      showPrompt();
      return;
    }
    if (trimmed === "/abort") {
      sendCommand({ type: "abort", id: `req-${++reqCounter}` });
      return;
    }
    inFlight = true;
    sendCommand({ type: "prompt", id: `req-${++reqCounter}`, message: trimmed });
  });

  rl.on("close", () => {
    promptOpen = false;
    try {
      proc.stdin.end();
    } catch {}
    proc.kill();
  });

  showPrompt();

  await proc.exited;
  if (promptOpen) rl.close();
}

async function dreamOne(name: string): Promise<boolean> {
  console.log(`→ dreaming ${name}`);
  const proc = Bun.spawn(
    [
      "sprite",
      "exec",
      "-s",
      name,
      "--",
      "bash",
      "-lc",
      'cd /home/sprite/agent && pi -p "Run the dream tool to consolidate your memory."',
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

const LAUNCHD_LABEL = "com.pete.cells-dream";

function plistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function buildPlist(): string {
  const cellBin = process.execPath; // bun
  const scriptPath = fileURLToPath(import.meta.url);
  const logsDir = join(homedir(), ".cells", "logs");
  const path = "/Users/pete/.bun/bin:/Users/pete/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${cellBin}</string>
    <string>${scriptPath}</string>
    <string>dream</string>
    <string>--all</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${path}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${logsDir}/dream.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/dream.err</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

async function cmdScheduleDreams() {
  const logsDir = join(homedir(), ".cells", "logs");
  await mkdir(logsDir, { recursive: true });
  await mkdir(dirname(plistPath()), { recursive: true });
  await writeFile(plistPath(), buildPlist());
  console.log(`✓ wrote plist: ${plistPath()}`);

  const uid = process.getuid?.() ?? 501;

  // Unload existing first so bootstrap is idempotent.
  await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).exited;

  const proc = Bun.spawn(["launchctl", "bootstrap", `gui/${uid}`, plistPath()], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("✗ launchctl bootstrap failed");
    process.exit(1);
  }

  console.log(`✓ scheduled: cells dream --all nightly at 4:00am`);
  console.log(`  logs: ${logsDir}/dream.log (stdout), dream.err (stderr)`);
  console.log(`  unschedule with: cells unschedule-dreams`);
}

async function cmdUnscheduleDreams() {
  const uid = process.getuid?.() ?? 501;
  await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  if (existsSync(plistPath())) {
    await unlink(plistPath());
    console.log(`✓ removed ${plistPath()}`);
  } else {
    console.log("(no plist found)");
  }
  console.log("✓ unscheduled");
}

async function dreamMother(): Promise<boolean> {
  console.log(`→ dreaming mother`);
  const repoDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "Run the dream tool to consolidate your memory.",
      "--dangerously-skip-permissions",
    ],
    {
      cwd: repoDir,
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
const SECRETS_PATH = join(homedir(), ".cells", "secrets.json");

async function spritesToken(): Promise<string> {
  if (process.env.SPRITES_TOKEN) return process.env.SPRITES_TOKEN;
  if (existsSync(SECRETS_PATH)) {
    const s = JSON.parse(await readFile(SECRETS_PATH, "utf-8"));
    if (s.SPRITES_TOKEN) return s.SPRITES_TOKEN;
  }
  console.error("SPRITES_TOKEN not set (env or ~/.cells/secrets.json)");
  process.exit(1);
}

async function api(path: string): Promise<any> {
  const token = await spritesToken();
  const r = await fetch(`https://api.sprites.dev${path}`, {
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

type SpriteInfo = {
  status: string;
  url: string | null;
  created_at: string;
  last_running_at: string | null;
  egress: string;
};

async function getSpriteInfo(name: string): Promise<SpriteInfo> {
  const [sprite, policy] = await Promise.all([
    api(`/v1/sprites/${encodeURIComponent(name)}`),
    api(`/v1/sprites/${encodeURIComponent(name)}/policy/network`).catch(() => null),
  ]);
  const egress = policy?.rules
    ? policy.rules.map((r: any) => `${r.action} ${r.domain}`).join(", ")
    : "(unknown)";
  return {
    status: sprite.status ?? "?",
    url: sprite.url ?? null,
    created_at: sprite.created_at,
    last_running_at: sprite.last_running_at ?? null,
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

async function spriteExecCapture(name: string, script: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["sprite", "exec", "-s", name, "--", "bash", "-lc", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr };
}

async function pullMarkdown(name: string, vaultPath: string): Promise<{ persona: string | null }> {
  await mkdir(vaultPath, { recursive: true });
  const findScript = `cd /home/sprite/agent && find memory yearnings .pi/agents .pi/skills .pi/prompts \\( -name '*.md' -o -name 'SKILL.md' \\) -type f 2>/dev/null | tar czf - -T -`;
  const send = Bun.spawn(["sprite", "exec", "-s", name, "--", "bash", "-lc", findScript], {
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
    throw new Error(`sprite exec for ${name} failed: ${err.trim() || `exit ${sendCode}`}`);
  }
  if (recvCode !== 0) {
    const err = await new Response(recv.stderr).text();
    // Empty archive is benign — tar emits a warning but exits non-zero.
    if (!/empty archive/i.test(err)) throw new Error(`tar extract failed: ${err.trim()}`);
  }
  // Reshape the on-cell .pi/ tree into the vault layout (Pi-named dirs at
  // top level, persona body returned for inlining into AGENTS.md).
  return await restructureVault(vaultPath);
}

/**
 * After pullMarkdown drops files into vaultPath under their on-cell paths
 * (`.pi/agents/self.md`, `.pi/skills/...`, etc.), restructure to vault shape:
 *   - `.pi/skills/` → `skills/`        (Pi structure preserved)
 *   - `.pi/prompts/` → `prompts/`
 *   - `.pi/agents/self.md` → captured and returned (NOT written; goes inline into AGENTS.md)
 *   - `.pi/` removed
 */
async function restructureVault(vaultPath: string): Promise<{ persona: string | null }> {
  const piDir = join(vaultPath, ".pi");
  let persona: string | null = null;
  const personaSrc = join(piDir, "agents", "self.md");
  if (existsSync(personaSrc)) persona = await readFile(personaSrc, "utf-8");

  const skillsSrc = join(piDir, "skills");
  if (existsSync(skillsSrc)) {
    const skillsDst = join(vaultPath, "skills");
    if (existsSync(skillsDst)) await rm(skillsDst, { recursive: true, force: true });
    await cp(skillsSrc, skillsDst, { recursive: true });
  }

  const promptsSrc = join(piDir, "prompts");
  if (existsSync(promptsSrc)) {
    const promptsDst = join(vaultPath, "prompts");
    if (existsSync(promptsDst)) await rm(promptsDst, { recursive: true, force: true });
    await cp(promptsSrc, promptsDst, { recursive: true });
  }

  if (existsSync(piDir)) await rm(piDir, { recursive: true, force: true });
  return { persona };
}

async function pullExtensionDocs(name: string, vaultPath: string): Promise<Array<{ name: string; meta: ExtensionMeta }>> {
  // List extensions, then cat each index.ts.
  const list = await spriteExecCapture(name, "ls -1 /home/sprite/agent/.pi/extensions/ 2>/dev/null");
  if (!list.ok) return [];
  const exts = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const extDir = join(vaultPath, "extensions");
  await mkdir(extDir, { recursive: true });
  const results: Array<{ name: string; meta: ExtensionMeta }> = [];
  for (const ext of exts) {
    const cat = await spriteExecCapture(name, `cat /home/sprite/agent/.pi/extensions/${ext}/index.ts 2>/dev/null`);
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
  info: SpriteInfo | null,
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
      out.push(`- [${e.name}](extensions/${e.name}.md)${tail}`);
    }
    out.push("");
  }

  // Skills.
  if (skills.length > 0) {
    out.push("## Skills", "");
    for (const s of skills) out.push(`- [${s}](skills/${s}/SKILL.md)`);
    out.push("");
  }

  // Memory snapshot.
  out.push("## Memory", "");
  const topicalCount = `${mem.topicals.length} topical file${mem.topicals.length === 1 ? "" : "s"}`;
  const yearningCount = `${mem.yearnings.length} yearning${mem.yearnings.length === 1 ? "" : "s"}`;
  out.push(`${topicalCount} · ${yearningCount}${mem.lastDream ? ` · last dream ${mem.lastDream}` : ""}`);
  out.push("→ [MEMORY.md](memory/MEMORY.md)", "");

  if (mem.topicals.length > 0) {
    for (const t of mem.topicals) {
      const tail = t.preview ? ` — ${t.preview}` : "";
      out.push(`- [${t.title}](memory/${t.filename})${tail}`);
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
      out.push(`- **${y.title}** — [${y.filename}](memory/yearnings/${y.filename})`);
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

async function setupMotherVault(): Promise<void> {
  const vault = join(VAULT_DIR, "mother");
  await mkdir(vault, { recursive: true });

  // Wipe any prior layout artifacts so renames/migrations land cleanly.
  for (const f of ["README.md", "AGENTS.md", "persona.md"]) {
    if (existsSync(join(vault, f))) await rm(join(vault, f));
  }
  for (const d of ["extensions", "skills", "prompts", ".pi"]) {
    if (existsSync(join(vault, d))) await rm(join(vault, d), { recursive: true, force: true });
  }

  // Symlink memory (always replace to keep current).
  const memLink = join(vault, "memory");
  if (existsSync(memLink)) await rm(memLink, { force: true, recursive: false });
  await symlink(join(CELL_REPO, "memory"), memLink);

  // Skills tree (markdown only — follows symlinks).
  const skillsSrc = join(CELL_REPO, ".pi", "skills");
  await copyMarkdownTree(skillsSrc, join(vault, "skills"));

  // Extension docs from local sources.
  const exts = await readLocalExtensionDocs(
    join(CELL_REPO, ".pi", "extensions"),
    join(vault, "extensions"),
  );

  // Persona body — read directly, inline into AGENTS.md (no separate file).
  const personaPath = join(CELL_REPO, ".pi", "agents", "self.md");
  const persona = existsSync(personaPath) ? await readFile(personaPath, "utf-8") : null;

  const skills = await listSkills(join(vault, "skills"));
  const mem = await gatherMemoryContext(join(CELL_REPO, "memory"));
  const md = renderAgents("mother", null, persona, exts, skills, mem);
  await writeFile(join(vault, "AGENTS.md"), md);
}

async function syncOneCell(name: string): Promise<{ name: string; status: string; lastRunningAt: string | null } | null> {
  const vault = join(VAULT_DIR, name);
  await mkdir(vault, { recursive: true });

  // Wipe everything that gets regenerated. Memory/yearnings/prompts come
  // from the pull and replace whatever was there.
  for (const f of ["README.md", "AGENTS.md", "persona.md"]) {
    if (existsSync(join(vault, f))) await rm(join(vault, f));
  }
  for (const d of ["extensions", "skills", "prompts", ".pi", "memory", "yearnings"]) {
    if (existsSync(join(vault, d))) await rm(join(vault, d), { recursive: true, force: true });
  }

  const { persona } = await pullMarkdown(name, vault);
  const exts = await pullExtensionDocs(name, vault);
  const info = await getSpriteInfo(name).catch((e) => {
    console.error(`  warn: api failed for ${name}: ${(e as Error).message}`);
    return null;
  });
  const skills = await listSkills(join(vault, "skills"));
  const mem = await gatherMemoryContext(join(vault, "memory"));
  const md = renderAgents(name, info, persona, exts, skills, mem);
  await writeFile(join(vault, "AGENTS.md"), md);
  return info ? { name, status: info.status, lastRunningAt: info.last_running_at } : { name, status: "?", lastRunningAt: null };
}

async function writeRoster(rows: Array<{ name: string; status: string; lastRunningAt: string | null }>): Promise<void> {
  const lines = ["# Cells", "", "| name | status | last seen | dashboard |", "|---|---|---|---|"];
  lines.push(`| mother | local | — | [→](mother/) |`);
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
        const info = await getSpriteInfo(c.name).catch(() => null);
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
  await writeRoster(rows.filter((r): r is NonNullable<typeof r> => r !== null));
  console.log(`\nvault: ${VAULT_DIR}`);
}

// ───── dispatch ─────

const [sub, ...rest] = process.argv.slice(2);

switch (sub) {
  case "pi":         await cmdPi(); break;
  case "birth":
  case "create": {
    const { name, opts } = parseCreateArgs(rest);
    await cmdCreate(name, opts);
    break;
  }
  case "talk": {
    const targetName = needName(rest, "talk");
    await cmdTalk(targetName, rest.slice(1));
    break;
  }
  case "list":       await cmdList(); break;
  case "sleep":      await cmdSleep(needName(rest, "sleep")); break;
  case "wake":       await cmdWake(needName(rest, "wake")); break;
  case "checkpoint": await cmdCheckpoint(needName(rest, "checkpoint")); break;
  case "kill":
  case "destroy":    await cmdDestroy(rest); break;
  case "dream":              await cmdDream(rest[0] ?? ""); break;
  case "stream":             await cmdStream(needName(rest, "stream")); break;
  case "sync":               await cmdSync(rest[0] || undefined); break;
  case "schedule-dreams":    await cmdScheduleDreams(); break;
  case "unschedule-dreams":  await cmdUnscheduleDreams(); break;
  case "doctor":             await cmdDoctor(); break;
  case "shell":              await cmdShell(needName(rest, "shell")); break;
  default:
    console.log("usage:");
    console.log("  cells pi                    open the mother Pi TUI (alias: cells talk mother)");
    console.log("  cells birth <name> [flags]  provision a new cell on a Sprite (alias: create)");
    console.log("                              flags: --harness=pi --model=opus|sonnet|haiku|gpt-5.5|gpt-5.5-pro|deepseek-v4-flash|deepseek-v4-pro");
    console.log("                                     --thinking=off|minimal|low|medium|high|xhigh|adaptive");
    console.log("                                     --extensions=memory,mentality,wiki,dream");
    console.log("                                     --packages=pi-web-access");
    console.log("                              no flags = interactive TUI; any flag = non-interactive (defaults fill the rest)");
    console.log("  cells talk <name> [msg]     attach to a cell's TUI (no msg) or send one-shot (with msg).");
    console.log("                              'mother' = local pi; accepts any pi flag (-c, -r, --session=<id>, -p ...).");
    console.log("                              cells: -c/--continue attaches; -r/--resume opens picker via tmux send-keys.");
    console.log("  cells list                  list known cells");
    console.log("  cells sleep <name>          force-hibernate a Sprite");
    console.log("  cells wake <name>           force-wake a Sprite");
    console.log("  cells checkpoint <name>     snapshot a cell's filesystem");
    console.log("  cells dream <name|mother|--all>  run dream consolidation on a cell, the mother, or all");
    console.log("  cells stream <name>         interactive multi-turn streaming chat with a cell (Pi RPC)");
    console.log("  cells sync [name]           pull cell markdown into ~/Obsidian/cells/ (default: all + mother)");
    console.log("  cells doctor                inspect mother OAuth state + proxy health (run when cells act 401-y)");
    console.log("  cells shell <name>          drop into a bash shell on a cell (separate tmux from the agent; Ctrl+D exits)");
    console.log("  cells schedule-dreams       install launchd plist (nightly 4am, all cells)");
    console.log("  cells unschedule-dreams     remove launchd plist");
    console.log("  cells kill <name>... [-y]   destroy one or more cells (irreversible) (alias: destroy)");
    console.log("                              --all-but <name>... kill every cell except the listed ones");
    console.log("                              -y/--yes skip the confirmation prompt");
    process.exit(sub ? 1 : 0);
}
