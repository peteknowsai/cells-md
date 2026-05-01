/**
 * sprite-tools — Pi extension that exposes Sprite VM operations as LLM-callable
 * tools for the mother agent.
 *
 * Wraps the local `sprite` CLI via node:child_process. The CLI handles auth
 * via the macOS keyring, so we don't manage tokens here.
 */

import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type ShellResult = { ok: boolean; exit: number; stdout: string; stderr: string };

function runCommand(
  cmd: string,
  args: string[],
  pipeStdin?: NodeJS.ReadableStream,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    if (pipeStdin) {
      pipeStdin.pipe(proc.stdin);
    } else {
      proc.stdin.end();
    }
    proc.on("close", (code) => {
      resolve({ ok: code === 0, exit: code ?? -1, stdout, stderr });
    });
    proc.on("error", (e) => {
      resolve({ ok: false, exit: -1, stdout, stderr: stderr || e.message });
    });
  });
}

const runSprite = (args: string[]) => runCommand("sprite", args);

function fmt(label: string, r: ShellResult): string {
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  const head = r.ok ? `✓ ${label}` : `✗ ${label} (exit=${r.exit})`;
  const parts = [head];
  if (out) parts.push(`stdout:\n${out}`);
  if (err) parts.push(`stderr:\n${err}`);
  return parts.join("\n\n");
}

export default function (pi: any) {
  pi.registerTool({
    name: "sprite_create",
    label: "Create Sprite",
    description:
      "Create a new Sprite VM with the given name. Blocks ~15 seconds until the VM is ready. The Sprite name doubles as the agent's identity.",
    parameters: Type.Object({
      name: Type.String({ description: "Name for the Sprite (also the agent's name)." }),
    }),
    async execute(_id: string, params: { name: string }, signal: AbortSignal) {
      if (signal.aborted) throw new Error("aborted");
      const r = await runSprite(["create", params.name]);
      return { content: [{ type: "text", text: fmt(`sprite_create ${params.name}`, r) }] };
    },
  });

  pi.registerTool({
    name: "sprite_destroy",
    label: "Destroy Sprite",
    description:
      "Destroy a Sprite VM. Irreversible — all filesystem state is lost. Use only after the user has confirmed.",
    parameters: Type.Object({
      name: Type.String({ description: "Sprite name to destroy." }),
    }),
    async execute(_id: string, params: { name: string }) {
      const r = await runSprite(["destroy", "-s", params.name, "--force"]);
      return { content: [{ type: "text", text: fmt(`sprite_destroy ${params.name}`, r) }] };
    },
  });

  pi.registerTool({
    name: "sprite_exec",
    label: "Run on Sprite",
    description:
      "Run a bash command on a Sprite as user `sprite`. Returns stdout and stderr. Use for any setup, install, or one-shot operation on the VM.",
    parameters: Type.Object({
      name: Type.String({ description: "Sprite name." }),
      command: Type.String({ description: "Bash command to run on the Sprite." }),
    }),
    async execute(_id: string, params: { name: string; command: string }, signal: AbortSignal) {
      if (signal.aborted) throw new Error("aborted");
      const r = await runSprite(["exec", "-s", params.name, "--", "bash", "-c", params.command]);
      return { content: [{ type: "text", text: fmt(`sprite_exec ${params.name}`, r) }] };
    },
  });

  pi.registerTool({
    name: "sprite_push",
    label: "Push directory to Sprite",
    description:
      "Push a local directory's contents to a path on the Sprite via tar pipe. Creates the destination if missing. Use for shipping the agent template.",
    parameters: Type.Object({
      name: Type.String({ description: "Sprite name." }),
      localPath: Type.String({ description: "Absolute local path to the directory whose contents will be pushed." }),
      remotePath: Type.String({ description: "Absolute path on the Sprite where contents will land." }),
    }),
    async execute(
      _id: string,
      params: { name: string; localPath: string; remotePath: string },
      signal: AbortSignal,
    ) {
      if (signal.aborted) throw new Error("aborted");
      const tar = spawn("tar", ["czf", "-", "-C", params.localPath, "."], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const remoteCmd = `mkdir -p ${params.remotePath} && cd ${params.remotePath} && tar xzf -`;
      const r = await runCommand(
        "sprite",
        ["exec", "-s", params.name, "--", "bash", "-c", remoteCmd],
        tar.stdout,
      );
      return {
        content: [
          {
            type: "text",
            text: fmt(`sprite_push ${params.localPath} → ${params.name}:${params.remotePath}`, r),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "sprite_egress_allow",
    label: "Set Sprite egress",
    description:
      "Replace a Sprite's egress allowlist. Pass ['*'] to allow all outbound. Each domain is a hostname or wildcard like '*.example.com'.",
    parameters: Type.Object({
      name: Type.String({ description: "Sprite name." }),
      domains: Type.Array(Type.String(), { description: "Domains to allow." }),
    }),
    async execute(_id: string, params: { name: string; domains: string[] }) {
      const body = JSON.stringify({
        rules: params.domains.map((d) => ({ action: "allow", domain: d })),
      });
      const r = await runSprite([
        "api",
        "-s",
        params.name,
        `/v1/sprites/${params.name}/policy/network`,
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-d",
        body,
      ]);
      return {
        content: [
          {
            type: "text",
            text: fmt(`sprite_egress_allow ${params.name} [${params.domains.join(", ")}]`, r),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "report_outcome",
    label: "Report outcome to CLI",
    description:
      "Signal whether the current multi-step operation succeeded or failed. ALWAYS call this as the FINAL action of a multi-step ritual (birth, destroy, checkpoint, etc.). The Bun CLI reads the result to decide whether to update the local registry. If you skip this call, the CLI assumes failure.",
    parameters: Type.Object({
      success: Type.Boolean({
        description: "true if the operation completed end-to-end; false if you stopped at any step.",
      }),
      message: Type.String({
        description: "Short description: success summary, or which step failed and why.",
      }),
    }),
    async execute(_id: string, params: { success: boolean; message: string }) {
      const path = process.env.CELL_OUTCOME_FILE;
      if (!path) {
        return {
          content: [
            {
              type: "text",
              text: `CELL_OUTCOME_FILE not set — outcome acknowledged but not persisted: ${params.success ? "success" : "failure"} — ${params.message}`,
            },
          ],
        };
      }
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(params));
        return {
          content: [
            {
              type: "text",
              text: `Recorded ${params.success ? "success" : "failure"}: ${params.message}`,
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed to write outcome file: ${e.message}` }],
        };
      }
    },
  });

  pi.registerTool({
    name: "sprite_checkpoint",
    label: "Checkpoint Sprite",
    description: "Take a filesystem checkpoint of a Sprite (~300ms, copy-on-write). Last 5 retained.",
    parameters: Type.Object({
      name: Type.String({ description: "Sprite name." }),
    }),
    async execute(_id: string, params: { name: string }) {
      const r = await runSprite(["checkpoint", "create", "-s", params.name]);
      return { content: [{ type: "text", text: fmt(`sprite_checkpoint ${params.name}`, r) }] };
    },
  });
}
