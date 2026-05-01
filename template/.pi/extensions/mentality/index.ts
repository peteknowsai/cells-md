/**
 * pi-cell-mentality — the agent's working-state synthesis.
 *
 * Single file: mentality.md at the agent's working-dir root. Always
 * loaded into the system prompt at session start. The agent's "where
 * I am right now": current focus, project state, lessons learned,
 * mind changes, open threads.
 *
 * Standalone behavior: agent calls `update_mentality` mid-conversation
 * when it notices a meaningful shift. Without dream installed, the
 * file evolves voluntarily — agent has to notice and decide. With
 * dream installed, the file gets refreshed asynchronously from
 * conversation history.
 *
 * Composes via `ctx.getSystemPrompt()` so it stacks with persona +
 * memory extensions cleanly.
 */

import { Type } from "@sinclair/typebox";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where mentality lives:
 *   - On a Sprite: /home/sprite/agent/mentality.md
 *   - Otherwise: cwd/mentality.md
 *   - Override via env var CELL_MENTALITY_FILE.
 */
function resolveMentalityFile(): string {
  if (process.env.CELL_MENTALITY_FILE) return process.env.CELL_MENTALITY_FILE;
  if (existsSync("/home/sprite/agent")) return "/home/sprite/agent/mentality.md";
  return join(process.cwd(), "mentality.md");
}

const MENTALITY_FILE = resolveMentalityFile();

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKELETON_PATH = join(SCRIPT_DIR, "templates", "mentality-skeleton.md");

const MAX_BYTES = 6 * 1024;

function ensureSeed(): void {
  if (existsSync(MENTALITY_FILE)) return;
  if (existsSync(SKELETON_PATH)) {
    writeFileSync(MENTALITY_FILE, readFileSync(SKELETON_PATH, "utf-8"));
  } else {
    writeFileSync(MENTALITY_FILE, "# Mentality\n\n_(no synthesis yet)_\n");
  }
}

function readMentality(): string {
  if (!existsSync(MENTALITY_FILE)) return "";
  return readFileSync(MENTALITY_FILE, "utf-8").trim();
}

export default function (pi: any) {
  pi.on("session_start", async () => {
    ensureSeed();
  });

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    ensureSeed();
    const body = readMentality();
    if (!body) return {};
    const prior = ctx.getSystemPrompt();
    return {
      systemPrompt: `${prior}\n\n## Mentality\n\nThis is your current synthesis of where you are. It was written either by you (during conversation, via \`update_mentality\`) or by the dream tool (asynchronously, from past conversations). Treat it as your starting posture for this session.\n\n${body}`,
    };
  });

  pi.registerTool({
    name: "update_mentality",
    label: "Update mentality",
    description:
      "Rewrite your mentality.md file — your single-file synthesis of 'where I am right now'. Use when something shifts meaningfully: new focus, a lesson learned, a mind change, a thread closing or opening. Suggested sections: Current focus / Project state / Lessons learned / Mind changes / Working with / Open threads. Keep it under ~80 lines / 6KB.",
    parameters: Type.Object({
      content: Type.String({
        description:
          "Full new markdown body of mentality.md. Replaces the current file entirely.",
      }),
    }),
    async execute(_id: string, params: { content: string }) {
      const bytes = Buffer.byteLength(params.content, "utf-8");
      if (bytes > MAX_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `rejected: mentality is ${bytes} bytes, exceeds ${MAX_BYTES} cap. Tighten the synthesis.`,
            },
          ],
        };
      }
      writeFileSync(MENTALITY_FILE, params.content);
      return {
        content: [{ type: "text", text: `updated mentality (${bytes} bytes)` }],
      };
    },
  });
}
