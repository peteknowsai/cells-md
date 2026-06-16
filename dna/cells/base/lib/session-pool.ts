/**
 * Cell-side named-session pool — pure functions + types, no IO, no spawning.
 *
 * The stateful pool (tmux launch, the transcript-tail loop, timers) lives in
 * site/server.ts and owns the IO; every decision it makes lives HERE so it's
 * testable via `bun test dna/cells/base/lib/` without a VM — the same split
 * jobs.ts/server.ts already use for the jobs lane.
 *
 * Why this exists: a cell's talk runs through one always-on `claude --print`
 * process pinned to a single session (/root/.cell/claude-main-session). That
 * bills cc_entrypoint=sdk-cli (the metered Agent-SDK credit) AND is the only
 * reason "main is single-owner". This pool replaces it with N warm, genuinely
 * interactive claude sessions (PTY via tmux, no --print → cc_entrypoint=cli),
 * each resuming its own durable per-name id, so a cell can hold several
 * independent durable conversations (e.g. main, buyer↔WhatsApp, staff↔Slack)
 * at once. Design: docs/proposals/named-sessions.html.
 */

import { isInsideDir } from "./path-guard";

// ---- registry paths --------------------------------------------------------

// "main" keeps its existing pin (the file bake/birth already captures and the
// --print supervisor reads), so an upgrade is seamless and a rollback to the
// --print path finds the same id. Every other name gets its own file under
// SESSIONS_DIR, created on first use.
export const MAIN_SESSION_FILE = "/root/.cell/claude-main-session";
export const SESSIONS_DIR = "/root/.cell/sessions";
// Where claude writes a session's transcript JSONL (cwd is always /root, so the
// project slug is fixed). The tail loop reads <CLAUDE_PROJECT_DIR>/<id>.jsonl.
export const CLAUDE_PROJECT_DIR = "/root/.claude/projects/-root";

export const DEFAULT_SESSION = "main";

// ---- tunables (the load-bearing RAM/latency defenses) ----------------------

// Idle warm sessions are killed after this; the next turn cold-starts and
// --resumes the durable id. Keeps standing RAM bounded (~1.9GB per warm claude
// on the 48GB Mini).
export const IDLE_TTL_MS = 15 * 60 * 1000;
// Max warm sessions per cell. A 4th spawn LRU-evicts the least-recently-used
// idle session first. Not optional — this is the fleet RAM ceiling.
export const WARM_CAP = 3;
// Boot past SessionStart. The job runner waits 60s (cold job boots); talk gates
// are pre-seeded so boot is single-digit seconds — a tighter bound keeps the
// first post-eviction turn snappy without risking a false timeout.
export const SESSIONSTART_TIMEOUT_MS = 25_000;

// ---- session-name validation + path resolution -----------------------------

// Lowercase, starts alpha, [a-z0-9_-], ≤32 chars. No `.` or `/` → traversal is
// structurally impossible; sessionIdPath still defends in depth via isInsideDir.
const SESSION_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export type SessionName = string;

export function validateSessionName(raw: unknown): SessionName | null {
  return typeof raw === "string" && SESSION_NAME_RE.test(raw) ? raw : null;
}

// Registry file for a validated name. "main" aliases the legacy pin; everything
// else lives under SESSIONS_DIR. Returns null for an invalid or escaping name
// (defense in depth — validateSessionName already forbids the metacharacters).
export function sessionIdPath(name: string): string | null {
  if (name === "main") return MAIN_SESSION_FILE;
  if (!validateSessionName(name)) return null;
  const p = `${SESSIONS_DIR}/${name}`;
  return isInsideDir(SESSIONS_DIR, p) ? p : null;
}

// The transcript JSONL path for a resolved claude session id.
export function transcriptPathForId(id: string): string {
  return `${CLAUDE_PROJECT_DIR}/${id}.jsonl`;
}

// ---- claude launch flags ---------------------------------------------------

// Resume a known id, or create-on-first-use with a caller-supplied uuid (so the
// caller can persist the id to the registry before launch — claude honors the
// asserted --session-id, unlike a bare fresh session whose id it picks itself).
// No --fork-session: a named session writes durably to its own id.
export function sessionFlags(
  resumedId: string | null,
  freshId: string,
): { args: string[]; created: boolean } {
  if (resumedId) return { args: ["--resume", resumedId], created: false };
  return { args: ["--session-id", freshId], created: true };
}

// ---- transcript parsing (the live-stream + fallback seams) -----------------

// Parse a newline-terminated slice of a transcript JSONL into rows. The caller
// (server.ts) only ever hands us bytes up to and including the last newline, so
// every line here is complete — and because a newline (0x0A) can't sit inside a
// multibyte UTF-8 sequence, decoding a [newline-boundary, newline-boundary)
// range is always codepoint-safe. That's why there is no partial-line state:
// the byte cursor simply never advances past an unterminated line.
export function parseJsonl(text: string): any[] {
  const rows: any[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* torn/partial — skip */ }
  }
  return rows;
}

// Newly-appended rows → the assistant TEXT deltas to stream. One string per
// text block, in order. tool_use / tool_result (a user row) / thinking blocks
// and user rows emit nothing — they advance the cursor but aren't visible
// output. Each block is emitted exactly once because the cursor is monotonic
// and we only ever see rows past it.
export function parseTranscriptDelta(rows: any[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row?.type !== "assistant") continue;
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        out.push(block.text);
      }
    }
  }
  return out;
}

// Fallback reconstruction for finishTurn: given the FULL transcript rows, the
// turn's final answer is the last assistant row AFTER the last user row
// (tool_results are user rows, so this lands on the terminal answer of a
// multi-tool turn too). Identical logic to the job runner's harvester. Used
// only when the live tail missed the terminal block (Stop fired before flush).
export function lastTurnFinal(rows: any[]): { text: string; stopReason: string } {
  let lastUser = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.type === "user") lastUser = i;
  }
  let ans: any = null;
  for (let i = lastUser + 1; i < rows.length; i++) {
    if (rows[i]?.type === "assistant") ans = rows[i];
  }
  if (!ans) return { text: "", stopReason: "" };
  const content = ans?.message?.content;
  const text = Array.isArray(content)
    ? content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("")
        .trim()
    : "";
  return { text, stopReason: ans?.message?.stop_reason || "" };
}

// A reconstructed terminal answer is "done" only with a real text body and a
// terminal stop_reason — mirrors the runner's ok check, so a turn that ends on
// a tool_use row (intermediate) isn't mistaken for the answer.
export function isTerminalAnswer(text: string, stopReason: string): boolean {
  return !!text && (stopReason === "end_turn" || stopReason === "stop_sequence");
}

// ---- lifecycle decisions ---------------------------------------------------

export function idleEvictDue(now: number, lastTurnAt: number, ttlMs: number): boolean {
  return now - lastTurnAt >= ttlMs;
}

// When a new session would exceed WARM_CAP, which existing one to evict: the
// least-recently-used IDLE session (never a busy/spawning one). null = nothing
// evictable (all warm sessions are busy) → the caller lets it run temporarily
// over cap rather than killing a live turn.
export type EvictCandidate = { name: SessionName; state: LiveSessionState; lastTurnAt: number };

export function lruEvictTarget(sessions: EvictCandidate[], cap: number): SessionName | null {
  const warm = sessions.filter((s) => s.state !== "cold");
  if (warm.length < cap) return null;
  const idle = warm
    .filter((s) => s.state === "idle")
    .sort((a, b) => a.lastTurnAt - b.lastTurnAt);
  return idle.length ? idle[0]!.name : null;
}

// ---- pool/session shape (the class lives in server.ts) ---------------------

export type LiveSessionState =
  | "cold" // no tmux; next turn must spawn + resume
  | "spawning" // tmux launched, awaiting the SessionStart ready marker
  | "idle" // warm, no turn in flight
  | "busy" // a turn is injected + streaming
  | "evicting" // idle-TTL/LRU fired; killing tmux
  | "crashed"; // tmux vanished mid-turn; cold-restart next turn

export type PendingTurn = {
  // Set for durable-conversation turns (main-turn pump, agent_message): the
  // corrId the reply is broadcast against. null for a raw interactive client
  // prompt (it streams to all WS clients, no reply correlation).
  corrId: string | null;
  text: string;
  from: string | null;
  leashMs: number;
  acc: string; // accumulated assistant text (read at agent_end for corrId turns)
  // Per-session overrides (uniform-cell): the model spec to launch this session's
  // warm claude with (e.g. "anthropic/opus-4-8:medium") and the resolved role
  // preamble (system prompt / "hat"). Absent → the cell's claude defaults. Applied
  // at (re)launch by the pool, sticky for the warm session's lifetime.
  model?: string;
  rolePreamble?: string;
};
