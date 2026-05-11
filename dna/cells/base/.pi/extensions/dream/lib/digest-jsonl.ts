/**
 * digest-jsonl — find signal in Pi session JSONL files.
 *
 * Surgical grep over a small set of patterns (corrections, explicit
 * saves, key decisions, recurring markers). Never reads full
 * transcripts — only matched lines + surrounding context.
 *
 * Adding a new source type? See ../docs/ADDING_A_SOURCE.md.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type SignalHit = {
  source: string; // session filename (or other source identifier)
  pattern: string; // which pattern fired
  excerpt: string; // matched line + surrounding context
  timestamp: string | null; // event timestamp if extractable
};

/**
 * Patterns we look for. Imperfect but cheap. The dream subagent gets
 * the hits + context and decides what's actually signal vs. noise.
 *
 * Tune these in collaboration with the agent — see
 * docs/PROMPT_TUNING.md.
 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "correction", re: /\b(actually|wait,|that's wrong|not (quite |right)|let me correct|mistake|i was wrong)\b/i },
  { name: "save", re: /\b(remember (this|that)|save this|note that|important:|FYI:?|don't forget|TIL\b)/i },
  { name: "decision", re: /\b(we decided|let's go with|we'll|going to|the plan is|locked in)\b/i },
  { name: "preference", re: /\b(i (prefer|like|hate|don't like)|always|never)\b/i },
  { name: "mind-change", re: /\b(used to think|changed my mind|turns out|i was wrong about)\b/i },
];

const CONTEXT_LINES = 2;
const MAX_HITS_PER_SESSION = 30;
const MAX_TOTAL_HITS = 200;
const MAX_LINE_LEN = 600;

function resolveSessionsDir(): string {
  if (process.env.CELL_SESSIONS_DIR) return process.env.CELL_SESSIONS_DIR;
  // Pi's default: ~/.pi/agent/sessions/
  return join(homedir(), ".pi", "agent", "sessions");
}

export const SESSIONS_DIR = resolveSessionsDir();

/**
 * List session JSONL files modified after `since`. Skip the most
 * recently-modified file (it's likely the active session — race
 * condition guard).
 */
export function listSessionsSince(since: Date | null): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const entries = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const full = join(SESSIONS_DIR, f);
      const stat = statSync(full);
      return { full, mtime: stat.mtimeMs };
    });
  entries.sort((a, b) => a.mtime - b.mtime); // oldest first
  // Drop the freshest file (active session protection).
  if (entries.length > 0) entries.pop();
  return entries
    .filter((e) => since === null || e.mtime > since.getTime())
    .map((e) => e.full);
}

/**
 * Extract user/assistant text from a Pi JSONL line. Returns null for
 * lines that don't have meaningful conversational content (tool
 * calls, tool results, system events, etc.).
 */
function extractText(line: string): { role: string; text: string; ts: string | null } | null {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  // Pi session entries have varying shapes. Look for message-like ones.
  const msg = event?.message ?? event;
  const role = msg?.role;
  if (role !== "user" && role !== "assistant") return null;
  const content = msg?.content;
  if (!content) return null;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === "text" && typeof c.text === "string") text += c.text + "\n";
    }
  }
  text = text.trim();
  if (!text) return null;
  if (text.length > MAX_LINE_LEN) text = text.slice(0, MAX_LINE_LEN) + "…";
  const ts = msg?.timestamp ? new Date(msg.timestamp).toISOString() : null;
  return { role, text, ts };
}

export function digestSession(path: string): SignalHit[] {
  if (!existsSync(path)) return [];
  const filename = path.split("/").pop() ?? path;
  const lines = readFileSync(path, "utf-8").split("\n");
  const turns: { role: string; text: string; ts: string | null }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const t = extractText(line);
    if (t) turns.push(t);
  }
  const hits: SignalHit[] = [];
  for (let i = 0; i < turns.length && hits.length < MAX_HITS_PER_SESSION; i++) {
    const { role, text, ts } = turns[i];
    for (const { name, re } of PATTERNS) {
      if (!re.test(text)) continue;
      const start = Math.max(0, i - CONTEXT_LINES);
      const end = Math.min(turns.length, i + CONTEXT_LINES + 1);
      const excerpt = turns
        .slice(start, end)
        .map((t) => `[${t.role}] ${t.text}`)
        .join("\n");
      hits.push({ source: filename, pattern: name, excerpt, timestamp: ts });
      break; // one hit per turn is enough
    }
  }
  return hits;
}

export function gatherSignals(since: Date | null): SignalHit[] {
  const sessions = listSessionsSince(since);
  const all: SignalHit[] = [];
  for (const path of sessions) {
    const hits = digestSession(path);
    all.push(...hits);
    if (all.length >= MAX_TOTAL_HITS) break;
  }
  return all.slice(0, MAX_TOTAL_HITS);
}
