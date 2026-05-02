/**
 * memory — auto-memory + yearnings extension for Cell agents.
 *
 * Modeled on Claude Code's auto-memory pattern. Loads MEMORY.md and the
 * yearnings list into the system prompt at every session start. Provides
 * tools the agent uses to write topical memory files and record open
 * questions. Truncates MEMORY.md on every turn to stay under Claude Code's
 * 200-line / 25KB caps, preserving the index header.
 *
 * Phase 1.0 — no dream tool yet. The dream subagent comes in Phase 1.1.
 *
 * Loads after the identity extension (settings.json order). Composes with
 * identity's systemPrompt via ctx.getSystemPrompt() so the agent sees:
 *   <persona from identity>
 *   ----
 *   <memory section from this extension>
 */

import { Type } from "@sinclair/typebox";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, basename, normalize, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * Where memory lives depends on context:
 *   - On a Sprite (where the agent runs in /home/sprite/agent): use the
 *     sprite-side state dir.
 *   - On Pete's Mac (mother running in ~/Projects/cells): cwd/state/memory.
 *   - Override via env var CELL_MEMORY_DIR.
 *
 * Both contexts get identical structure: MEMORY.md + topical files +
 * yearnings/ subdir, all under <agent>/state/memory/.
 */
function resolveMemoryDir(): string {
  if (process.env.CELL_MEMORY_DIR) return process.env.CELL_MEMORY_DIR;
  if (existsSync("/home/sprite/agent")) return "/home/sprite/agent/state/memory";
  return join(process.cwd(), "state", "memory");
}

const MEMORY_DIR = resolveMemoryDir();
const YEARNINGS_DIR = join(MEMORY_DIR, "yearnings");
const INDEX_FILE = join(MEMORY_DIR, "MEMORY.md");
const LAST_DREAM_FILE = join(MEMORY_DIR, ".last-dream");
const DREAM_LOCK_FILE = join(MEMORY_DIR, ".dreaming");

const MAX_LINES = 200;
const MAX_BYTES = 25 * 1024;
const HEADER_LINES_PRESERVED = 10;

const ALLOWED_PREFIXES = ["user_", "feedback_", "project_", "reference_"];

// Resolve auto-memory-prompt.md alongside this extension file.
// __dirname isn't always available in ESM; derive from import.meta.url.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE_PATH = join(SCRIPT_DIR, "auto-memory-prompt.md");
const DREAM_RITUAL_PATH = join(SCRIPT_DIR, "dream-ritual.md");

const INITIAL_MEMORY_HEADER = `# MEMORY.md

Index of topical memory files. One line per topic. Read individual files
on demand for full content.

`;

function ensureDirs(): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  mkdirSync(YEARNINGS_DIR, { recursive: true });
  if (!existsSync(INDEX_FILE)) {
    writeFileSync(INDEX_FILE, INITIAL_MEMORY_HEADER);
  }
}

/**
 * Reject anything but a plain filename inside the target directory.
 * No traversal, no absolute paths, no nested subdirs.
 */
function safePath(name: string, dir: string): string | null {
  const cleaned = basename(name);
  if (cleaned !== name) return null;
  const full = normalize(join(dir, cleaned));
  if (!full.startsWith(dir + sep) && full !== dir) return null;
  return full;
}

function nameValid(name: string): boolean {
  return (
    name.endsWith(".md") &&
    ALLOWED_PREFIXES.some((p) => name.startsWith(p))
  );
}

/**
 * Truncate MEMORY.md if it exceeds either cap. Preserves the first
 * HEADER_LINES_PRESERVED lines (the file header / index pointer block);
 * trims from the tail until both caps are satisfied.
 */
function truncateIndex(): void {
  if (!existsSync(INDEX_FILE)) return;
  const content = readFileSync(INDEX_FILE, "utf-8");
  const lines = content.split("\n");
  const bytes = Buffer.byteLength(content, "utf-8");
  if (lines.length <= MAX_LINES && bytes <= MAX_BYTES) return;

  const header = lines.slice(0, HEADER_LINES_PRESERVED);
  const body = lines.slice(HEADER_LINES_PRESERVED);

  while (body.length > 0) {
    const candidate = header.concat(body).join("\n");
    if (
      header.length + body.length <= MAX_LINES &&
      Buffer.byteLength(candidate, "utf-8") <= MAX_BYTES
    ) {
      break;
    }
    body.pop();
  }

  writeFileSync(INDEX_FILE, header.concat(body).join("\n"));
}

function listYearnings(): { filename: string; firstLine: string }[] {
  if (!existsSync(YEARNINGS_DIR)) return [];
  return readdirSync(YEARNINGS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((filename) => {
      const content = readFileSync(join(YEARNINGS_DIR, filename), "utf-8");
      const firstLine = content.split("\n")[0]?.trim() ?? "";
      return { filename, firstLine };
    });
}

function buildLastDreamNudge(): string {
  if (!existsSync(LAST_DREAM_FILE)) {
    return "(never) — consider running `dream` once you've accumulated some memory.";
  }
  const stat = statSync(LAST_DREAM_FILE);
  const ageMs = Date.now() - stat.mtimeMs;
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
  const isoDate = stat.mtime.toISOString().slice(0, 10);
  const ago = ageDays > 0 ? `${ageDays}d ago` : `${ageHours}h ago`;
  let suggestion = "";
  if (ageDays >= 7) {
    suggestion = " — overdue, consider running `dream`.";
  } else if (ageDays >= 3) {
    suggestion = " — consider `dream` if memory feels messy.";
  }
  return `${isoDate} (${ago})${suggestion}`;
}

/**
 * Expand the `## Always-load` section of MEMORY.md by inlining the
 * contents of every `.md` file referenced as a bullet under that header.
 * Lets the agent treat specific topical files as pinned context without
 * having to read them on every turn. The section ends at the next `##`
 * header. Missing files are silently skipped.
 */
function expandAlwaysLoad(index: string): string {
  const lines = index.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    out.push(line);
    if (/^##\s+Always[- ]?load/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    // Match "- `filename.md` — ..." or "- filename.md ..."
    const m = line.match(/^[-*]\s+[`*]?([a-zA-Z0-9_./-]+\.md)/);
    if (!m) continue;
    const filePath = join(MEMORY_DIR, m[1]);
    if (!existsSync(filePath)) continue;
    const fileContent = readFileSync(filePath, "utf-8").trim();
    if (!fileContent) continue;
    out.push("", `<!-- inlined: ${m[1]} -->`, fileContent, "<!-- /inlined -->", "");
  }
  return out.join("\n");
}

function buildMemorySection(): string {
  const template = readFileSync(PROMPT_TEMPLATE_PATH, "utf-8");
  const rawIndex = existsSync(INDEX_FILE)
    ? readFileSync(INDEX_FILE, "utf-8").trim()
    : "(empty)";
  const indexContent = expandAlwaysLoad(rawIndex);
  const yearnings = listYearnings();
  const yearningsList =
    yearnings.length === 0
      ? "(none)"
      : yearnings.map((y) => `- **${y.filename}** — ${y.firstLine}`).join("\n");
  return template
    .replace("{{MEMORY_INDEX}}", indexContent)
    .replace("{{YEARNINGS_LIST}}", yearningsList)
    .replace("{{LAST_DREAM_NUDGE}}", buildLastDreamNudge());
}

export default function (pi: any) {
  pi.on("session_start", async () => {
    ensureDirs();
  });

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    ensureDirs();
    const prior = ctx.getSystemPrompt();
    const memorySection = buildMemorySection();
    return { systemPrompt: `${prior}\n\n${memorySection}` };
  });

  pi.on("turn_end", async () => {
    truncateIndex();
  });

  pi.registerTool({
    name: "write_memory",
    label: "Write memory",
    description:
      "Write or replace a topical memory file. Filename must start with `user_`, `feedback_`, `project_`, or `reference_` and end with `.md`. The file is overwritten if it exists.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Filename, e.g. 'user_role.md' or 'feedback_response_style.md'.",
      }),
      content: Type.String({
        description: "Full markdown content of the file (replaces any existing).",
      }),
    }),
    async execute(_id: string, params: { name: string; content: string }) {
      ensureDirs();
      if (!nameValid(params.name)) {
        return {
          content: [
            {
              type: "text",
              text: `rejected: filename '${params.name}' must start with user_/feedback_/project_/reference_ and end with .md`,
            },
          ],
        };
      }
      const path = safePath(params.name, MEMORY_DIR);
      if (!path) {
        return {
          content: [{ type: "text", text: `rejected: invalid path '${params.name}'` }],
        };
      }
      writeFileSync(path, params.content);
      return { content: [{ type: "text", text: `wrote ${params.name}` }] };
    },
  });

  pi.registerTool({
    name: "remove_memory",
    label: "Remove memory",
    description:
      "Delete a topical memory file. Use when a fact is stale or has been superseded.",
    parameters: Type.Object({
      name: Type.String({ description: "Filename to delete." }),
    }),
    async execute(_id: string, params: { name: string }) {
      const path = safePath(params.name, MEMORY_DIR);
      if (!path) {
        return { content: [{ type: "text", text: `rejected: invalid path` }] };
      }
      if (!existsSync(path)) {
        return { content: [{ type: "text", text: `not found: ${params.name}` }] };
      }
      unlinkSync(path);
      return { content: [{ type: "text", text: `removed ${params.name}` }] };
    },
  });

  pi.registerTool({
    name: "write_yearning",
    label: "Write yearning",
    description:
      "Record an unanswered question worth pursuing. Body should describe what you want to know and how you might learn it.",
    parameters: Type.Object({
      subject: Type.String({
        description: "Short slug, e.g. 'hull_maintenance'. Becomes the filename.",
      }),
      content: Type.String({
        description: "Full markdown content of the yearning.",
      }),
    }),
    async execute(_id: string, params: { subject: string; content: string }) {
      ensureDirs();
      const filename = `${params.subject}.md`;
      const path = safePath(filename, YEARNINGS_DIR);
      if (!path) {
        return {
          content: [
            { type: "text", text: `rejected: invalid subject '${params.subject}'` },
          ],
        };
      }
      writeFileSync(path, params.content);
      return {
        content: [{ type: "text", text: `recorded yearning: ${params.subject}` }],
      };
    },
  });

  pi.registerTool({
    name: "resolve_yearning",
    label: "Resolve yearning",
    description:
      "Mark a yearning as answered and remove it. Move the answer to a topical file separately via `write_memory`.",
    parameters: Type.Object({
      subject: Type.String({ description: "The yearning's subject slug." }),
    }),
    async execute(_id: string, params: { subject: string }) {
      const filename = `${params.subject}.md`;
      const path = safePath(filename, YEARNINGS_DIR);
      if (!path) {
        return {
          content: [{ type: "text", text: `rejected: invalid subject` }],
        };
      }
      if (!existsSync(path)) {
        return {
          content: [{ type: "text", text: `not found: ${params.subject}` }],
        };
      }
      unlinkSync(path);
      return {
        content: [{ type: "text", text: `resolved yearning: ${params.subject}` }],
      };
    },
  });

  pi.registerTool({
    name: "dream",
    label: "Dream (consolidate memory)",
    description:
      "Fork a subagent to consolidate this agent's memory: orient, gather, merge duplicates, resolve contradictions, prune the index, walk yearnings. Use when memory feels messy, after lots of new writes, or when the user asks you to dream. The subagent has restricted tools (read/write/bash) and runs in an isolated cwd. Returns a summary paragraph of what changed.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any) {
      ensureDirs();

      if (existsSync(DREAM_LOCK_FILE)) {
        return {
          content: [
            {
              type: "text",
              text: "A dream is already in progress (memory/.dreaming exists). Skipping. If you're sure no dream is running, delete that file and retry.",
            },
          ],
        };
      }

      let ritual: string;
      try {
        ritual = readFileSync(DREAM_RITUAL_PATH, "utf-8");
      } catch (e: any) {
        return {
          content: [
            { type: "text", text: `cannot read dream ritual: ${e.message ?? String(e)}` },
          ],
        };
      }

      writeFileSync(DREAM_LOCK_FILE, new Date().toISOString());

      const tmpCwd = join(tmpdir(), `dream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(tmpCwd, { recursive: true });

      const result = await new Promise<{ ok: boolean; stdout: string; stderr: string }>(
        (resolve) => {
          const proc = spawn(
            "pi",
            [
              "-p",
              `Consolidate the memory directory at ${MEMORY_DIR}/. Read every file there, then edit in place per the ritual in your system prompt. Return a one-paragraph summary of what changed.`,
              "--system-prompt",
              ritual,
              "--tools",
              "read,write,bash",
              "--no-prompt-templates",
            ],
            {
              cwd: tmpCwd,
              stdio: ["ignore", "pipe", "pipe"],
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
        },
      );

      try {
        unlinkSync(DREAM_LOCK_FILE);
      } catch {
        // best-effort cleanup
      }

      if (result.ok) {
        writeFileSync(LAST_DREAM_FILE, new Date().toISOString());
      }

      const summary = result.stdout.trim() || "(dream returned no output)";
      const status = result.ok
        ? "✓ dream complete"
        : `✗ dream failed: ${result.stderr.trim() || "non-zero exit"}`;

      return {
        content: [{ type: "text", text: `${status}\n\n${summary}` }],
      };
    },
  });
}
