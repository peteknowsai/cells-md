/**
 * orchestrate — the four-phase dream loop.
 *
 *   1. Orient — survey existing storage (memory/, mentality.md, wiki/)
 *   2. Gather signal — surgical grep over JSONL since cursor
 *   3. Consolidate — fork a Pi subagent to write into storage
 *   4. Prune & index — subagent updates indexes; we update cursor + log
 *
 * Detects which storage packages are installed by looking for their
 * canonical files. Writes only into what's present.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { AGENT_ROOT, readCursor, writeCursor } from "./cursor.ts";
import { gatherSignals, SESSIONS_DIR } from "./digest-jsonl.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(SCRIPT_DIR, "..", "prompts");
const INGEST_PROMPT_PATH = join(PROMPTS_DIR, "ingest-prompt.md");

type StorageMap = {
  memory: { present: boolean; path: string };
  mentality: { present: boolean; path: string };
  wiki: { present: boolean; path: string };
};

function detectStorage(): StorageMap {
  const memoryDir = join(AGENT_ROOT, "memory");
  const mentalityFile = join(AGENT_ROOT, "mentality.md");
  const wikiDir = join(AGENT_ROOT, "wiki");
  return {
    memory: { present: existsSync(memoryDir), path: memoryDir },
    mentality: { present: existsSync(mentalityFile), path: mentalityFile },
    wiki: { present: existsSync(wikiDir), path: wikiDir },
  };
}

function buildOrientation(storage: StorageMap): string {
  const lines: string[] = [];
  if (storage.memory.present) {
    const memDir = storage.memory.path;
    const indexFile = join(memDir, "MEMORY.md");
    const index = existsSync(indexFile) ? readFileSync(indexFile, "utf-8").slice(0, 4000) : "(no MEMORY.md)";
    const files = readdirSync(memDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    lines.push(`### memory/MEMORY.md\n\n${index}\n\n### memory atom files (${files.length})\n${files.map((f) => `- ${f}`).join("\n") || "(none)"}`);
    const yDir = join(memDir, "yearnings");
    if (existsSync(yDir)) {
      const ys = readdirSync(yDir).filter((f) => f.endsWith(".md"));
      lines.push(`### memory/yearnings (${ys.length})\n${ys.map((f) => `- ${f}`).join("\n") || "(none)"}`);
    }
  }
  if (storage.mentality.present) {
    const body = readFileSync(storage.mentality.path, "utf-8").slice(0, 4000);
    lines.push(`### mentality.md\n\n${body}`);
  }
  if (storage.wiki.present) {
    const indexFile = join(storage.wiki.path, "index.md");
    const index = existsSync(indexFile) ? readFileSync(indexFile, "utf-8").slice(0, 3000) : "(no wiki/index.md)";
    const files = readdirSync(storage.wiki.path).filter((f) => f.endsWith(".md") && !["index.md", "log.md", "SCHEMA.md"].includes(f));
    lines.push(`### wiki/index.md\n\n${index}\n\n### wiki pages (${files.length})\n${files.map((f) => `- ${f}`).join("\n") || "(none)"}`);
  }
  if (lines.length === 0) lines.push("(no storage packages detected — install pi-cell-memory, pi-cell-mentality, or pi-cell-wiki)");
  return lines.join("\n\n");
}

function buildSignalBundle(signals: ReturnType<typeof gatherSignals>): string {
  if (signals.length === 0) return "(no new signal since last dream)";
  const lines: string[] = [];
  for (const s of signals) {
    const ts = s.timestamp ? `[${s.timestamp}] ` : "";
    lines.push(`---\n${ts}source: ${s.source} · pattern: ${s.pattern}\n\n${s.excerpt}`);
  }
  return lines.join("\n\n");
}

function appendWikiLog(storage: StorageMap, summary: string, signalCount: number, sessionCount: number): void {
  if (!storage.wiki.present) return;
  const logFile = join(storage.wiki.path, "log.md");
  const stamp = new Date().toISOString();
  const entry = `\n## [${stamp}] ingest jsonl | ${sessionCount} session(s) | ${signalCount} signal(s)\n\n${summary}\n`;
  const cur = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "# Wiki log\n\n";
  writeFileSync(logFile, cur + entry);
}

function runSubagent(prompt: string, systemPrompt: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const tmpCwd = join(tmpdir(), `dream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpCwd, { recursive: true });
    const proc = spawn(
      "pi",
      [
        "-p",
        prompt,
        "--system-prompt",
        systemPrompt,
        "--tools",
        "read,write,edit,bash",
        "--no-prompt-templates",
      ],
      {
        cwd: AGENT_ROOT, // CRITICAL: subagent runs in agent root so memory/ wiki/ mentality.md paths resolve
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CELL_DREAM_TMP: tmpCwd },
      },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
    proc.on("error", (e) => {
      resolve({ ok: false, stdout, stderr: stderr + (e.message ?? String(e)) });
    });
  });
}

export async function distill(): Promise<{ ok: boolean; summary: string }> {
  const storage = detectStorage();
  const cursor = readCursor();
  const signals = gatherSignals(cursor);
  const sessionsCount = new Set(signals.map((s) => s.source)).size;

  if (signals.length === 0) {
    appendWikiLog(storage, "(no new signal since last dream cursor)", 0, 0);
    // Still advance cursor so we don't re-scan the same range next time.
    writeCursor(new Date());
    return {
      ok: true,
      summary: `no new signal since last dream${cursor ? ` at ${cursor.toISOString()}` : ""} — sessions dir: ${SESSIONS_DIR}`,
    };
  }

  const orientation = buildOrientation(storage);
  const signalBundle = buildSignalBundle(signals);

  const ingestPrompt = existsSync(INGEST_PROMPT_PATH)
    ? readFileSync(INGEST_PROMPT_PATH, "utf-8")
    : "Consolidate the agent's memory, mentality, and wiki based on the signals provided.";

  const userPrompt = [
    "## Current state",
    "",
    orientation,
    "",
    "## Signal since last dream",
    "",
    signalBundle,
    "",
    "## Your task",
    "",
    "Follow the four phases in your system prompt. Edit the agent's storage files in place using the read/write/edit tools. Return a one-paragraph summary of what changed.",
  ].join("\n");

  const result = await runSubagent(userPrompt, ingestPrompt);
  if (result.ok) {
    writeCursor(new Date());
  }
  const summary = result.stdout.trim() || "(subagent returned no output)";
  appendWikiLog(storage, summary, signals.length, sessionsCount);
  return { ok: result.ok, summary };
}
