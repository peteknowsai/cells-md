#!/usr/bin/env bun
import { $ } from "bun";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CELL_REPO = dirname(SCRIPT_DIR);
const REGISTRY_DIR = join(homedir(), ".cell");
const REGISTRY_PATH = join(REGISTRY_DIR, "cells.json");

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

async function launchKeeperTui() {
  const tmuxConf = join(CELL_REPO, ".tmux.conf");
  const proc = Bun.spawn(
    ["tmux", "-f", tmuxConf, "new-session", "-A", "-s", "keeper", "-c", CELL_REPO, "pi"],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  await proc.exited;
}

async function cmdPi() {
  await launchKeeperTui();
}

async function cmdList() {
  const reg = await loadRegistry();
  if (reg.cells.length === 0) {
    console.log("no cells");
    return;
  }
  for (const c of reg.cells) console.log(`${c.name.padEnd(20)} ${c.created_at}`);
}

async function cmdTalk(name: string, message?: string) {
  if (name === "keeper") {
    if (message) {
      console.error("one-shot talk to keeper not supported. Use `cell pi`.");
      process.exit(1);
    }
    await launchKeeperTui();
    return;
  }
  await requireCell(name);
  if (!message) {
    // No message → open the agent's TUI via sprite console.
    const proc = Bun.spawn(["sprite", "console", "-s", name], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    return;
  }
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

async function cmdSleep(name: string) {
  await requireCell(name);
  await $`sprite stop -s ${name}`;
}

async function cmdWake(name: string) {
  await requireCell(name);
  await $`sprite start -s ${name}`;
}

// ───── routed through local Pi ─────

async function cmdCreate(name: string) {
  if (name === "keeper") {
    console.error(`'keeper' is reserved for the local cell-keeper. Pick another name.`);
    process.exit(1);
  }
  if (await findCell(name)) {
    console.error(`cell '${name}' already exists in registry`);
    process.exit(1);
  }
  const { outcome } = await runPiWithOutcome("cell-create", [name]);
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

async function cmdDestroy(name: string) {
  await requireCell(name);
  const confirm = await ask(`destroying '${name}' is irreversible. type the name to confirm: `);
  if (confirm !== name) {
    console.error("name did not match — aborted");
    process.exit(1);
  }
  const { outcome } = await runPiWithOutcome("cell-destroy", [name]);
  if (!outcome || !outcome.success) {
    console.error(`destroy failed: ${outcome?.message ?? "no outcome reported"}`);
    process.exit(1);
  }
  const reg = await loadRegistry();
  reg.cells = reg.cells.filter((c) => c.name !== name);
  await saveRegistry(reg);
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
      "-c",
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

const LAUNCHD_LABEL = "com.pete.cell-dream";

function plistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function buildPlist(): string {
  const cellBin = process.execPath; // bun
  const scriptPath = fileURLToPath(import.meta.url);
  const logsDir = join(homedir(), ".cell", "logs");
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
  const logsDir = join(homedir(), ".cell", "logs");
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

  console.log(`✓ scheduled: cell dream --all nightly at 4:00am`);
  console.log(`  logs: ${logsDir}/dream.log (stdout), dream.err (stderr)`);
  console.log(`  unschedule with: cell unschedule-dreams`);
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

async function cmdDream(arg: string) {
  if (!arg) {
    console.error("usage: cell dream <name>   |   cell dream --all");
    process.exit(1);
  }
  if (arg === "--all") {
    const reg = await loadRegistry();
    if (reg.cells.length === 0) {
      console.log("no cells");
      return;
    }
    let okCount = 0;
    let failCount = 0;
    for (const cell of reg.cells) {
      const ok = await dreamOne(cell.name);
      ok ? okCount++ : failCount++;
    }
    console.log(`\n${okCount} ok, ${failCount} failed`);
    if (failCount > 0) process.exit(1);
    return;
  }
  await requireCell(arg);
  const ok = await dreamOne(arg);
  if (!ok) process.exit(1);
}

// ───── dispatch ─────

const [sub, ...rest] = process.argv.slice(2);

switch (sub) {
  case "pi":         await cmdPi(); break;
  case "create":     await cmdCreate(needName(rest, "create")); break;
  case "talk": {
    const targetName = needName(rest, "talk");
    const msg = rest.slice(1).join(" ");
    await cmdTalk(targetName, msg || undefined);
    break;
  }
  case "list":       await cmdList(); break;
  case "sleep":      await cmdSleep(needName(rest, "sleep")); break;
  case "wake":       await cmdWake(needName(rest, "wake")); break;
  case "checkpoint": await cmdCheckpoint(needName(rest, "checkpoint")); break;
  case "destroy":    await cmdDestroy(needName(rest, "destroy")); break;
  case "dream":              await cmdDream(rest[0] ?? ""); break;
  case "stream":             await cmdStream(needName(rest, "stream")); break;
  case "schedule-dreams":    await cmdScheduleDreams(); break;
  case "unschedule-dreams":  await cmdUnscheduleDreams(); break;
  default:
    console.log("usage:");
    console.log("  cell pi                    open the cell-keeper Pi TUI (alias: cell talk keeper)");
    console.log("  cell create <name>         provision a new cell on a Sprite");
    console.log("  cell talk <name> [msg]     attach to a cell's TUI (no msg) or send one-shot (with msg). 'keeper' = local.");
    console.log("  cell list                  list known cells");
    console.log("  cell sleep <name>          force-hibernate a Sprite");
    console.log("  cell wake <name>           force-wake a Sprite");
    console.log("  cell checkpoint <name>     snapshot a cell's filesystem");
    console.log("  cell dream <name|--all>    run dream consolidation on a cell or all cells");
    console.log("  cell stream <name>         interactive multi-turn streaming chat with a cell (Pi RPC)");
    console.log("  cell schedule-dreams       install launchd plist (nightly 4am, all cells)");
    console.log("  cell unschedule-dreams     remove launchd plist");
    console.log("  cell destroy <name>        destroy a cell (irreversible)");
    process.exit(sub ? 1 : 0);
}
