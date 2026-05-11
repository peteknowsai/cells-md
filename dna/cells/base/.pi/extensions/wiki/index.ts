/**
 * pi-cell-wiki — LLM-curated wiki for Pi-driven Cell agents.
 *
 * Long-term semantic memory as a network of cross-linked markdown
 * pages. Karpathy's LLM-Wiki pattern: index.md (catalog), log.md
 * (chronological provenance + cursor for dream), SCHEMA.md
 * (LLM-tunable rules), <topic>.md (topic pages).
 *
 * Standalone behavior: agent calls wiki_write to author pages,
 * wiki_query to search, wiki_lint to check for issues. Without
 * dream installed, the wiki is manually-curated.
 *
 * No system-prompt injection — wiki pages are too big to always-load.
 * Agent queries the wiki when relevant.
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

/**
 * Where the wiki lives:
 *   - Legacy well (HOME=/home/well, $HOME/agent exists): $HOME/agent/state/wiki/
 *   - New /cell layout (HOME=/cell, no $HOME/agent): cwd/state/wiki/
 *     (cwd=/cell when pi runs on a cell)
 *   - Local dev / mother: cwd/state/wiki/
 *   - Override via env var CELL_WIKI_DIR.
 */
function resolveWikiDir(): string {
  if (process.env.CELL_WIKI_DIR) return process.env.CELL_WIKI_DIR;
  const home = process.env.HOME ?? "";
  if (home && existsSync(join(home, "agent"))) return join(home, "agent", "state", "wiki");
  return join(process.cwd(), "state", "wiki");
}

const WIKI_DIR = resolveWikiDir();
const INDEX_FILE = join(WIKI_DIR, "index.md");
const LOG_FILE = join(WIKI_DIR, "log.md");
const SCHEMA_FILE = join(WIKI_DIR, "SCHEMA.md");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(SCRIPT_DIR, "templates");

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

function ensureDirs(): void {
  mkdirSync(WIKI_DIR, { recursive: true });
  if (!existsSync(SCHEMA_FILE)) {
    const seed = readTemplate("SCHEMA.md", "# Schema\n\n_(rules for this wiki)_\n");
    writeFileSync(SCHEMA_FILE, seed);
  }
  if (!existsSync(INDEX_FILE)) {
    const seed = readTemplate("index.md", "# Wiki\n\n_(no pages yet)_\n");
    writeFileSync(INDEX_FILE, seed);
  }
  if (!existsSync(LOG_FILE)) {
    const seed = readTemplate(
      "log.md",
      "# Wiki log\n\nChronological record of writes, lints, and dream ingestions.\n\n",
    );
    writeFileSync(LOG_FILE, seed);
  }
}

function readTemplate(name: string, fallback: string): string {
  const path = join(TEMPLATES_DIR, name);
  if (existsSync(path)) return readFileSync(path, "utf-8");
  return fallback;
}

function safeWikiPath(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return null;
  const filename = `${slug}.md`;
  const cleaned = basename(filename);
  if (cleaned !== filename) return null;
  const full = normalize(join(WIKI_DIR, filename));
  if (!full.startsWith(WIKI_DIR + sep) && full !== WIKI_DIR) return null;
  return full;
}

const RESERVED = new Set(["index", "log", "SCHEMA", "schema"]);

function listPages(): string[] {
  if (!existsSync(WIKI_DIR)) return [];
  return readdirSync(WIKI_DIR)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => {
      const slug = f.replace(/\.md$/, "");
      return !RESERVED.has(slug);
    })
    .sort();
}

function appendLog(line: string): void {
  ensureDirs();
  const stamp = new Date().toISOString();
  const entry = `\n## [${stamp}] ${line}\n`;
  const cur = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf-8") : "";
  writeFileSync(LOG_FILE, cur + entry);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchPages(query: string): Array<{ page: string; matches: string[] }> {
  const re = new RegExp(escapeRegex(query), "i");
  const results: Array<{ page: string; matches: string[] }> = [];
  for (const filename of listPages()) {
    const path = join(WIKI_DIR, filename);
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n");
    const matches: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length, i + 2);
        matches.push(lines.slice(start, end).join("\n"));
      }
    }
    if (matches.length > 0) {
      results.push({ page: filename, matches });
    }
  }
  return results;
}

function lintWiki(): { issues: string[]; pages: number } {
  const issues: string[] = [];
  const pages = listPages();

  // Orphan check: pages not mentioned in index.md.
  const indexContent = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, "utf-8") : "";
  for (const filename of pages) {
    const slug = filename.replace(/\.md$/, "");
    if (!indexContent.includes(filename) && !indexContent.includes(slug)) {
      issues.push(`orphan: ${filename} not in index.md`);
    }
  }

  // Dead links: index entries that point to non-existent files.
  const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(indexContent)) !== null) {
    const target = m[2];
    const targetPath = join(WIKI_DIR, target);
    if (!existsSync(targetPath) && !target.startsWith("http")) {
      issues.push(`dead link in index.md: ${target}`);
    }
  }

  // Stale: pages with TODO or "needs update" markers, or unmodified for >180d.
  const cutoff = Date.now() - 180 * 24 * 3600 * 1000;
  for (const filename of pages) {
    const path = join(WIKI_DIR, filename);
    const content = readFileSync(path, "utf-8");
    if (/\bTODO\b|needs update|TBD\b/i.test(content)) {
      issues.push(`stale marker in ${filename}: contains TODO/TBD/needs-update`);
    }
    const stat = statSync(path);
    if (stat.mtimeMs < cutoff) {
      const days = Math.floor((Date.now() - stat.mtimeMs) / (24 * 3600 * 1000));
      issues.push(`stale: ${filename} unmodified for ${days}d`);
    }
  }

  return { issues, pages: pages.length };
}

export default function (pi: any) {
  pi.on("session_start", async () => {
    ensureDirs();
  });

  pi.registerTool({
    name: "wiki_write",
    label: "Write wiki page",
    description:
      "Author or update a wiki topic page. Slug must be lowercase alphanumeric with underscores or hyphens (e.g. 'cell_lifecycle', 'auth-story'). Body is full markdown. Overwrites if the page exists. After writing, you should also update wiki/index.md with a link to the new/updated page using the `read` and `write` tools.",
    parameters: Type.Object({
      slug: Type.String({
        description: "Page slug, e.g. 'cell_lifecycle'. Becomes <slug>.md.",
      }),
      content: Type.String({
        description: "Full markdown content of the page.",
      }),
    }),
    async execute(_id: string, params: { slug: string; content: string }) {
      ensureDirs();
      if (RESERVED.has(params.slug)) {
        return {
          content: [
            {
              type: "text",
              text: `rejected: '${params.slug}' is reserved (use the index/log/schema files directly via read/write tools).`,
            },
          ],
        };
      }
      const path = safeWikiPath(params.slug);
      if (!path) {
        return {
          content: [
            {
              type: "text",
              text: `rejected: invalid slug '${params.slug}'. Must match /^[a-z0-9][a-z0-9_-]*$/.`,
            },
          ],
        };
      }
      const existed = existsSync(path);
      writeFileSync(path, params.content);
      appendLog(`write | ${params.slug}.md | ${existed ? "updated" : "new"}`);
      return {
        content: [
          {
            type: "text",
            text: `${existed ? "updated" : "wrote new"} wiki/${params.slug}.md\n\nReminder: update wiki/index.md to link to this page if it isn't already linked.`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "wiki_query",
    label: "Query wiki",
    description:
      "Search the wiki for a query string and return matching page excerpts (case-insensitive). Use to recall what the wiki already knows on a topic before writing or asking. Returns a list of pages with surrounding context lines for each hit.",
    parameters: Type.Object({
      query: Type.String({ description: "Search string." }),
    }),
    async execute(_id: string, params: { query: string }) {
      ensureDirs();
      const results = searchPages(params.query);
      if (results.length === 0) {
        return {
          content: [
            { type: "text", text: `no matches for "${params.query}" across ${listPages().length} wiki pages` },
          ],
        };
      }
      const text = results
        .map((r) => `### ${r.page}\n\n${r.matches.map((m) => "```\n" + m + "\n```").join("\n")}`)
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool({
    name: "wiki_lint",
    label: "Lint wiki",
    description:
      "Check the wiki for orphan pages (not in index), dead index links, stale-marker pages (TODO/TBD/needs-update), and pages unmodified for >180 days. Returns a report and appends findings to wiki/log.md. Use periodically; dream consolidation handles deeper structural cleanup.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any) {
      ensureDirs();
      const { issues, pages } = lintWiki();
      if (issues.length === 0) {
        const msg = `lint clean — ${pages} pages, no issues found`;
        appendLog(`lint | clean | ${pages} pages`);
        return { content: [{ type: "text", text: msg }] };
      }
      const report = `lint found ${issues.length} issue${issues.length === 1 ? "" : "s"} across ${pages} pages:\n\n${issues.map((i) => `- ${i}`).join("\n")}`;
      appendLog(`lint | ${issues.length} issues\n${issues.map((i) => `  - ${i}`).join("\n")}`);
      return { content: [{ type: "text", text: report }] };
    },
  });
}
