/**
 * self-tools — operate on your own Sprite from inside the agent.
 *
 * Scoped intentionally:
 *   - `talk_to_self` forks a fresh Pi locally (no API needed).
 *   - `info_self` shells out to the on-cell `cell` CLI which talks to the
 *     Sprites HTTP API directly (bypasses the broken local `sprite` CLI).
 *
 * `checkpoint_self` snapshots only this cell's own filesystem — also via
 * the on-cell `cell` CLI → HTTP API. Lifecycle ops on *other* cells
 * (create, destroy, peer checkpoints) are intentionally NOT exposed here.
 */

import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";

const AGENT_DIR = "/home/sprite/agent";

type ShellResult = { ok: boolean; exit: number; stdout: string; stderr: string };

function runShell(cmd: string, args: string[], cwd?: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, exit: code ?? -1, stdout, stderr });
    });
    proc.on("error", (e) => {
      resolve({ ok: false, exit: -1, stdout, stderr: stderr + (e.message ?? String(e)) });
    });
  });
}

export default function (pi: any) {
  pi.registerTool({
    name: "talk_to_self",
    label: "Talk to self",
    description:
      "Fork a fresh Pi instance with your same persona, memory, and tools — ask it a question, give it a task, brainstorm with it. Returns its reply. Useful for thinking out loud without polluting the main conversation, planning multi-step work, or self-critique. The forked instance doesn't see this conversation, only your persistent state (memory, persona).",
    parameters: Type.Object({
      message: Type.String({
        description: "What to ask or task yourself with.",
      }),
    }),
    async execute(_id: string, params: { message: string }, signal: AbortSignal) {
      if (signal.aborted) throw new Error("aborted");
      const r = await runShell("pi", ["-p", params.message], AGENT_DIR);
      return {
        content: [
          {
            type: "text",
            text: r.ok
              ? `(self) ${r.stdout.trim()}`
              : `✗ talk_to_self failed (exit=${r.exit}): ${r.stderr.trim()}`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "checkpoint_self",
    label: "Checkpoint self",
    description:
      "Snapshot your own filesystem (~300ms, copy-on-write). Use before risky operations so you can roll back. Last 5 checkpoints retained automatically.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any) {
      const r = await runShell("cell", ["checkpoint", "self"]);
      const text = r.ok
        ? r.stdout.trim()
        : `✗ checkpoint_self failed (exit=${r.exit})\n${r.stdout.trim()}\n${r.stderr.trim()}`.trim();
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool({
    name: "info_self",
    label: "Info about self",
    description:
      "Report your sprite's current state: name, status, egress allowlist, organization. Backed by the on-cell `cell` CLI which talks to the Sprites HTTP API. Use to debug capability or environment issues.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any) {
      const r = await runShell("cell", ["info", "self"]);
      const text = r.ok
        ? r.stdout.trim()
        : `✗ info_self failed (exit=${r.exit})\n${r.stdout.trim()}\n${r.stderr.trim()}`.trim();
      return { content: [{ type: "text", text }] };
    },
  });

  // create/destroy and peer-targeted ops are intentionally NOT exposed —
  // they live with the keeper on Pete's Mac.
}
