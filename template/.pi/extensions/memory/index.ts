/**
 * pi-cell-memory — auto-memory + yearnings for Pi-driven Cell agents.
 *
 * Loads MEMORY.md and the yearnings list into the system prompt at every
 * session start. Provides tools the agent uses to write topical memory
 * files and record open questions during conversation. Truncates
 * MEMORY.md on every turn to stay under 200-line / 25KB caps, preserving
 * the index header.
 *
 * No dream tool here — that's `pi-cell-dream`. This package is the
 * synchronous live-save layer; dream is the asynchronous learner that
 * complements it. The two compose cleanly when both are installed.
 *
 * Composes via `ctx.getSystemPrompt()` so it stacks with persona /
 * identity extensions: <prior prompt>\n\n<memory section>.
 */

import { Type } from "@sinclair/typebox";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, basename, normalize, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where memory lives depends on context:
 *   - On a Sprite (where the agent runs in /home/sprite/agent): use the
 *     sprite-side state dir.
 *   - Otherwise: cwd/state/memory (e.g. local dev, mother).
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

const MAX_LINES = 200;
const MAX_BYTES = 25 * 1024;
const HEADER_LINES_PRESERVED = 10;

const ALLOWED_PREFIXES = ["user_", "feedback_", "project_", "reference_"];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE_PATH = join(SCRIPT_DIR, "prompts", "auto-memory-prompt.md");
const INITIAL_INDEX_TEMPLATE = join(SCRIPT_DIR, "templates", "MEMORY.md");

function ensureDirs(): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  mkdirSync(YEARNINGS_DIR, { recursive: true });
  if (!existsSync(INDEX_FILE)) {
    const seed = existsSync(INITIAL_INDEX_TEMPLATE)
      ? readFileSync(INITIAL_INDEX_TEMPLATE, "utf-8")
      : "# MEMORY.md\n\nIndex of topical memory files.\n\n";
    writeFileSync(INDEX_FILE, seed);
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
 * HEADER_LINES_PRESERVED lines (file header / pointer block); trims
 * from the tail until both caps are satisfied.
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

/**
 * Expand the `## Always-load` section of MEMORY.md by inlining the
 * contents of every `.md` file referenced as a bullet under that header.
 * Lets the agent treat specific topical files as pinned context without
 * having to read them on every turn. Section ends at the next `##`
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
    .replace("{{YEARNINGS_LIST}}", yearningsList);
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
}
