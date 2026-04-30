/**
 * agent-debug — keeper-only tools for interacting with remote agents.
 *
 * Lets the cell-keeper poke a running agent's Pi TUI from the outside:
 * inject messages, read the screen, fetch memory. Useful for diagnosing
 * stuck agents, chatting on Pete's behalf, or watching what they're doing.
 *
 * IMPORTANT: messages injected via `talk_to_agent` land in the agent's MAIN
 * tmux session — the same one Pete sees. If Pete is actively using the
 * agent, your input will collide. Use sparingly, for diagnostic purposes
 * or when Pete is asking you to relay a message.
 */

import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";

const TMUX_TARGET = "agent"; // session name from the birth-time login shim
const DEFAULT_WAIT_SECONDS = 8;
const DEFAULT_PEEK_LINES = 100;

type ShellResult = { ok: boolean; exit: number; stdout: string; stderr: string };

function runShell(cmd: string, args: string[]): Promise<ShellResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function (pi: any) {
  pi.registerTool({
    name: "talk_to_agent",
    label: "Talk to remote agent",
    description:
      "Send a message to a remote agent's running Pi TUI and capture what shows up in the next few seconds. The agent receives this as if Pete typed it — so the message lands in the same conversation Pete is having with that agent. Use for diagnostics, debugging, or relaying. Returns the captured pane content (the agent's response, plus surrounding context).",
    parameters: Type.Object({
      name: Type.String({ description: "Remote agent name (Sprite name)." }),
      message: Type.String({ description: "Text to send. Enter is appended automatically." }),
      wait_seconds: Type.Optional(
        Type.Number({
          description: `How long to wait before capturing the pane. Default ${DEFAULT_WAIT_SECONDS}s.`,
        }),
      ),
    }),
    async execute(
      _id: string,
      params: { name: string; message: string; wait_seconds?: number },
      signal: AbortSignal,
    ) {
      if (signal.aborted) throw new Error("aborted");
      const wait = params.wait_seconds ?? DEFAULT_WAIT_SECONDS;

      // Lazy-start tmux + pi on the peer if it isn't already running, then
      // send-keys. Single bash invocation so the start happens first.
      // Env (PATH, secrets) comes from ~/.profile sourcing .bashrc.d.
      const escaped = params.message.replace(/'/g, "'\\''");
      const sendScript = [
        `tmux has-session -t ${TMUX_TARGET} 2>/dev/null || tmux new-session -d -s ${TMUX_TARGET} -c /home/sprite/agent pi`,
        `sleep 1`,
        `tmux send-keys -t ${TMUX_TARGET} '${escaped}' Enter`,
      ].join(" && ");
      const send = await runShell("sprite", [
        "exec",
        "-s",
        params.name,
        "--",
        "bash",
        "-lc",
        sendScript,
      ]);
      if (!send.ok) {
        return {
          content: [
            {
              type: "text",
              text: `✗ failed to send to ${params.name}: ${send.stderr.trim() || `exit ${send.exit}`}\n\nIs the agent's tmux session running? Check with peek_agent_screen.`,
            },
          ],
        };
      }

      await sleep(wait * 1000);

      const capture = await runShell("sprite", [
        "exec",
        "-s",
        params.name,
        "--",
        "tmux",
        "capture-pane",
        "-p",
        "-t",
        TMUX_TARGET,
        "-S",
        "-300",
      ]);
      if (!capture.ok) {
        return {
          content: [
            {
              type: "text",
              text: `sent message but failed to capture pane: ${capture.stderr.trim()}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `(${params.name} pane, after ${wait}s):\n\n${capture.stdout.trimEnd()}`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "peek_agent_screen",
    label: "Peek agent screen",
    description:
      "Read what's currently on a remote agent's Pi screen without disturbing them. Useful to see what they're looking at, what state the conversation is in, what tool they're running, or whether they're stuck.",
    parameters: Type.Object({
      name: Type.String({ description: "Remote agent name." }),
      lines: Type.Optional(
        Type.Number({
          description: `How many lines back to capture. Default ${DEFAULT_PEEK_LINES}.`,
        }),
      ),
    }),
    async execute(_id: string, params: { name: string; lines?: number }) {
      const lines = params.lines ?? DEFAULT_PEEK_LINES;
      const r = await runShell("sprite", [
        "exec",
        "-s",
        params.name,
        "--",
        "tmux",
        "capture-pane",
        "-p",
        "-t",
        TMUX_TARGET,
        "-S",
        `-${lines}`,
      ]);
      if (!r.ok) {
        return {
          content: [
            {
              type: "text",
              text: `✗ failed to peek ${params.name}: ${r.stderr.trim() || `exit ${r.exit}`}\n\nThe agent's tmux session may not be running.`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: `(${params.name} screen):\n\n${r.stdout.trimEnd()}` }],
      };
    },
  });

  pi.registerTool({
    name: "read_agent_memory",
    label: "Read agent's memory",
    description:
      "Read a file from a remote agent's memory directory (/home/sprite/agent/memory/). Pass a filename like 'MEMORY.md' or 'feedback_response_style.md', or omit to list the directory.",
    parameters: Type.Object({
      name: Type.String({ description: "Remote agent name." }),
      file: Type.Optional(
        Type.String({
          description: "Filename to read. Omit to list the memory directory.",
        }),
      ),
    }),
    async execute(_id: string, params: { name: string; file?: string }) {
      if (!params.file) {
        const r = await runShell("sprite", [
          "exec",
          "-s",
          params.name,
          "--",
          "ls",
          "-la",
          "/home/sprite/agent/memory/",
        ]);
        return {
          content: [
            {
              type: "text",
              text: r.ok ? `(${params.name} memory listing):\n${r.stdout}` : `✗ ${r.stderr}`,
            },
          ],
        };
      }
      // Reject path traversal
      if (params.file.includes("..") || params.file.startsWith("/")) {
        return { content: [{ type: "text", text: "rejected: invalid filename" }] };
      }
      const r = await runShell("sprite", [
        "exec",
        "-s",
        params.name,
        "--",
        "cat",
        `/home/sprite/agent/memory/${params.file}`,
      ]);
      return {
        content: [
          {
            type: "text",
            text: r.ok
              ? `(${params.name}:${params.file}):\n${r.stdout}`
              : `✗ failed to read: ${r.stderr.trim() || `exit ${r.exit}`}`,
          },
        ],
      };
    },
  });
}
