/**
 * operator-tools — cell registry + delegation primitives.
 *
 * Registers four tools that let operator's LLM read cell state and
 * fire-and-forget delegation:
 *
 *   - cells_list      — read ~/.cells/cells.json
 *   - cells_status    — read ~/.cells/pulse.json + heartbeats digest
 *   - cells_talk      — shell out to `cells talk <cell> "<msg>"`,
 *                       fire-and-forget. Slack context is embedded in
 *                       the message so the cell's slack-channel
 *                       extension can reply in the right thread.
 *   - channel_lookup  — read ~/.cells/channels.json for a channel ID
 *
 * The slack_post / slack_react tools live in the slack-adapter
 * extension (channel-specific). Operator-tools is channel-agnostic.
 */

import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = (() => {
  // .pi/extensions/operator-tools → up five to repo root:
  // operator-tools → extensions → .pi → operator → proto → cells
  let p = HERE;
  for (let i = 0; i < 5; i++) p = dirname(p);
  return p;
})();

const REGISTRY_PATH = join(homedir(), ".cells/cells.json");
const PULSE_STATE = join(homedir(), ".cells/pulse.json");
const PULSE_DIGEST = join(REPO_ROOT, "proto/pulse/state/heartbeats.md");
const CHANNELS_PATH = join(homedir(), ".cells/channels.json");
const CELLS_BIN = join(REPO_ROOT, "cli/cells.ts");

function readJsonOrEmpty(p: string): any {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

type ShellResult = { ok: boolean; exit: number; stdout: string; stderr: string };

function runShell(cmd: string, args: string[]): Promise<ShellResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, exit: code ?? -1, stdout, stderr });
    });
    proc.on("error", (e) => {
      resolve({ ok: false, exit: -1, stdout, stderr: stderr + String(e.message ?? e) });
    });
  });
}

export default function (pi: any) {
  pi.registerTool({
    name: "cells_list",
    label: "List cells",
    description:
      "Read ~/.cells/cells.json — the registry of all cells in the family. Returns {cells: [{name, created_at}, ...]}. Cheap; safe to call any time.",
    parameters: Type.Object({}),
    async execute() {
      const reg = readJsonOrEmpty(REGISTRY_PATH);
      const cells = (reg?.cells ?? []) as Array<{ name: string; created_at?: string }>;
      const text = cells.length === 0
        ? "(no cells in registry)"
        : cells.map((c) => `${c.name}\t${c.created_at ?? "?"}`).join("\n");
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool({
    name: "cells_status",
    label: "Cells status",
    description:
      "Read ~/.cells/pulse.json (lastFire per cell, recent log tail) and the rendered heartbeats digest. Use this to decide whether to delegate to a cell — e.g., if pete fired 30s ago and is mid-task, queue or wait. Returns the digest text plus the most-recent 20 fires.",
    parameters: Type.Object({}),
    async execute() {
      const parts: string[] = [];
      if (existsSync(PULSE_DIGEST)) {
        parts.push("=== heartbeats digest ===");
        parts.push(readFileSync(PULSE_DIGEST, "utf-8").trim());
      }
      const state = readJsonOrEmpty(PULSE_STATE);
      const log = (state?.log ?? []) as Array<{
        ts: string; cell: string; id: string; result: string; exit?: number;
      }>;
      if (log.length > 0) {
        parts.push("\n=== recent fires (newest first) ===");
        for (const e of [...log].slice(-20).reverse()) {
          const tail = e.result === "ok" ? "ok" : `fail (exit ${e.exit ?? "?"})`;
          parts.push(`${e.ts}  ${e.cell.padEnd(12)} ${e.id.padEnd(20)} ${tail}`);
        }
      } else {
        parts.push("\n(no fires logged yet)");
      }
      return { content: [{ type: "text", text: parts.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "cells_talk",
    label: "Talk to a cell",
    description:
      "Fire-and-forget delegation: shell out to `cells talk <cell> \"<message>\"` (the cell's pi terminal receives the message as user input). Does NOT await the cell's response — replies come back via the cell's own slack_post tool. When forwarding from Slack, embed the channel/thread context verbatim in the message so the cell can reply in the right thread, e.g.: `from-slack channel=C0123 thread=1714.5 user=U0456 text=<verbatim>`.",
    parameters: Type.Object({
      cell: Type.String({ description: "The target cell's name (must exist in registry)." }),
      message: Type.String({ description: "What to say. For Slack delegation, use the from-slack envelope above." }),
    }),
    async execute(_id: string, params: { cell: string; message: string }) {
      const r = await runShell("bun", [CELLS_BIN, "talk", params.cell, params.message]);
      const text = r.ok
        ? `delegated to ${params.cell}: ${r.stdout.trim().slice(0, 200) || "(ok)"}`
        : `✗ cells_talk ${params.cell} failed (exit=${r.exit}): ${(r.stderr + r.stdout).trim().slice(0, 300)}`;
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool({
    name: "channel_lookup",
    label: "Look up channel binding",
    description:
      "Read ~/.cells/channels.json for a Slack channel ID. Returns {cell, kind, createdAt} if bound, or null. Use to short-circuit routing — when an inbound message arrives in #cell-pete, just delegate to pete; skip the inline-vs-delegate debate.",
    parameters: Type.Object({
      channel_id: Type.String({ description: "The Slack channel ID, e.g. C0123456789." }),
    }),
    async execute(_id: string, params: { channel_id: string }) {
      const j = readJsonOrEmpty(CHANNELS_PATH);
      const b = j?.bindings?.[params.channel_id];
      const text = b ? JSON.stringify(b) : "null";
      return { content: [{ type: "text", text }] };
    },
  });
}
