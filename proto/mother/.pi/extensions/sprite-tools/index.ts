/**
 * sprite-tools — Pi extension that exposes Sprite VM operations as LLM-callable
 * tools for the mother agent.
 *
 * Wraps the local `sprite` CLI via node:child_process. The CLI handles auth
 * via the macOS keyring, so we don't manage tokens here.
 */

import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type ShellResult = { ok: boolean; exit: number; stdout: string; stderr: string; timedOut?: boolean };

// Hard cap on every sprite CLI invocation. Without this, a hung `sprite
// exec` (e.g. an `npm install` that silently stops streaming) blocks
// mother indefinitely — observed in the wild on 2026-05-06: a single
// `pi install -l npm:pi-web-access` ran 54+ minutes inside a birth.
//
// Default 10min is generous: the slowest legitimate sprite ops we run are
// the initial bun + pi-coding-agent install (~90s) and apt baseline
// (~60s). Anything past 10min is broken, not slow.
const DEFAULT_SPRITE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SPRITE_TIMEOUT_MS     = 30 * 60 * 1000;

function runCommand(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; pipeStdin?: NodeJS.ReadableStream },
): Promise<ShellResult> {
  const timeoutMs = Math.min(
    Math.max(opts?.timeoutMs ?? DEFAULT_SPRITE_TIMEOUT_MS, 1000),
    MAX_SPRITE_TIMEOUT_MS,
  );
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first; Node will fire 'close' shortly. If the child
      // ignores it, escalate to SIGKILL after 3s.
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
    }, timeoutMs);
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    if (opts?.pipeStdin) {
      opts.pipeStdin.pipe(proc.stdin);
    } else {
      proc.stdin.end();
    }
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const tag = `\n[killed by sprite-tools after ${Math.round(timeoutMs / 1000)}s — process never exited]`;
        resolve({ ok: false, exit: code ?? -1, stdout, stderr: stderr + tag, timedOut: true });
      } else {
        resolve({ ok: code === 0, exit: code ?? -1, stdout, stderr });
      }
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exit: -1, stdout, stderr: stderr || e.message });
    });
  });
}

const runSprite = (args: string[], opts?: { timeoutMs?: number }) =>
  runCommand("sprite", args, opts);

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
      "Run a bash command on a Sprite as user `sprite`. Returns stdout and stderr. Use for any setup, install, or one-shot operation on the VM. Default timeout is 10 minutes — pass `timeoutSeconds` for steps that should fail faster (e.g. package installs that often hang on registry stalls).",
    parameters: Type.Object({
      name: Type.String({ description: "Sprite name." }),
      command: Type.String({ description: "Bash command to run on the Sprite." }),
      timeoutSeconds: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 1800,
        description: "Kill the command after this many seconds (max 1800 = 30min). Default 600.",
      })),
    }),
    async execute(_id: string, params: { name: string; command: string; timeoutSeconds?: number }, signal: AbortSignal) {
      if (signal.aborted) throw new Error("aborted");
      const r = await runSprite(
        ["exec", "-s", params.name, "--", "bash", "-c", params.command],
        params.timeoutSeconds ? { timeoutMs: params.timeoutSeconds * 1000 } : undefined,
      );
      return { content: [{ type: "text", text: fmt(`sprite_exec ${params.name}`, r) }] };
    },
  });

  pi.registerTool({
    name: "sprite_push",
    label: "Push directory to Sprite",
    description:
      "Push a local directory's contents to a path on the Sprite via tar pipe. Creates the destination if missing. Use for shipping the agent DNA.",
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
        { pipeStdin: tar.stdout },
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
    name: "cell_resolve",
    label: "Resolve cell to sprite",
    description:
      "Resolve a user-facing cell name to its underlying Sprite name. Slow-birth cells use the same name for both. Hatched cells live on a permanent egg sprite (e.g. 'egg-sonnet-67706a') named differently from the cell. ALWAYS call this before sprite_destroy / sprite_exec / sprite_push when you only know the cell name — the sprite API rejects cell-name lookups for hatched cells.",
    parameters: Type.Object({
      name: Type.String({ description: "Cell name (user-facing identity)." }),
    }),
    async execute(_id: string, params: { name: string }) {
      const cellsPath = join(homedir(), ".cells", "cells.json");
      const eggsPath = join(homedir(), ".cells", "eggs.json");
      try {
        if (!existsSync(cellsPath)) {
          return {
            content: [
              {
                type: "text",
                text: `cell_resolve: registry not found at ${cellsPath}. Falling back: sprite_name=${params.name}`,
              },
            ],
          };
        }
        const reg = JSON.parse(readFileSync(cellsPath, "utf8")) as {
          cells: Array<{ name: string; hatched_from?: string; status?: string }>;
        };
        const cell = reg.cells.find((c) => c.name === params.name);
        if (!cell) {
          return {
            content: [
              {
                type: "text",
                text: `cell_resolve: no cell named '${params.name}' in registry. Cannot resolve sprite.`,
              },
            ],
          };
        }
        if (!cell.hatched_from) {
          return {
            content: [
              {
                type: "text",
                text: `cell_resolve: cell '${params.name}' is slow-birth. sprite_name=${params.name}`,
              },
            ],
          };
        }
        if (!existsSync(eggsPath)) {
          return {
            content: [
              {
                type: "text",
                text: `cell_resolve: cell '${params.name}' references egg ${cell.hatched_from} but ${eggsPath} is missing. Cannot resolve sprite.`,
              },
            ],
          };
        }
        const eggs = JSON.parse(readFileSync(eggsPath, "utf8")) as {
          eggs: Array<{ id: string; sprite_name: string }>;
        };
        const egg = eggs.eggs.find((e) => e.id === cell.hatched_from);
        if (!egg) {
          return {
            content: [
              {
                type: "text",
                text: `cell_resolve: cell '${params.name}' references egg ${cell.hatched_from} but no such egg in eggs.json. Sprite likely already destroyed.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `cell_resolve: cell '${params.name}' is hatched from egg ${egg.id}. sprite_name=${egg.sprite_name}`,
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `cell_resolve failed: ${e.message}` }],
        };
      }
    },
  });

  pi.registerTool({
    name: "sprite_checkpoint",
    label: "Checkpoint Sprite",
    description: "Take a filesystem checkpoint of a Sprite (~300ms, copy-on-write). Last 5 retained. Pass `comment` to label the checkpoint (e.g. `phase-tools-v1`, `pristine-v1`) so future restores can target a known-good phase.",
    parameters: Type.Object({
      name: Type.String({ description: "Sprite name." }),
      comment: Type.Optional(Type.String({
        description: "Short label for this checkpoint. Use kebab-case identifiers like `phase-tools-v1` or `pristine-v1`.",
      })),
    }),
    async execute(_id: string, params: { name: string; comment?: string }) {
      const args = ["checkpoint", "create", "-s", params.name];
      if (params.comment) args.push("--comment", params.comment);
      const r = await runSprite(args);
      const label = params.comment ? `${params.name} (${params.comment})` : params.name;
      return { content: [{ type: "text", text: fmt(`sprite_checkpoint ${label}`, r) }] };
    },
  });
}
