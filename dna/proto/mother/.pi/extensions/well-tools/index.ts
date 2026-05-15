/**
 * well-tools — Pi extension that exposes well VM operations as LLM-callable
 * tools for the mother agent.
 *
 * Wraps the local `well` CLI via node:child_process. The CLI handles auth
 * via the macOS keyring, so we don't manage tokens here.
 */

import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type ShellResult = { ok: boolean; exit: number; stdout: string; stderr: string; timedOut?: boolean };

// Hard cap on every well CLI invocation. Without this, a hung `well
// exec` (e.g. an `npm install` that silently stops streaming) blocks
// mother indefinitely — observed in the wild on 2026-05-06: a single
// `pi install -l npm:pi-web-access` ran 54+ minutes inside a birth.
//
// Default 10min is generous: the slowest legitimate well ops we run are
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
        const tag = `\n[killed by well-tools after ${Math.round(timeoutMs / 1000)}s — process never exited]`;
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

// `WELL_BINARY` lets cells.ts route mother to a different backend without
// touching this file — set to `well` for local wells, default `well` for
// cloud sprites.dev. Both CLIs honor the same flag shapes per the wells
// wells-API parity contract. The agent user inside the VM is named
// after the substrate (`well` on wells, `well` on wells); paths in
// remote command bodies should use `~` / `$HOME` so the in-VM shell
// resolves them per the substrate's user.
const SPRITE_CLI = process.env.WELL_BINARY ?? "well";

const runWell = (args: string[], opts?: { timeoutMs?: number }) =>
  runCommand(SPRITE_CLI, args, opts);

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
    name: "well_create",
    label: "Create well",
    description:
      "Create a new well VM with the given name. The well name doubles as the agent's identity. Pass `fromImage` to fork from a saved image (sub-millisecond clonefile + ~5s boot — preferred for cell birth, see `cell-base`); without it, builds from `ubuntu-25.10-base` and runs full cloud-init (~30-60s). Pass `env` to inject env vars into the well's `/etc/environment` at first boot via cloud-init — PAM auto-loads on every shell. Use this for `CELLS_PROXY_SECRET` and other shared secrets so they're present from boot with no post-create round-trip.",
    parameters: Type.Object({
      name: Type.String({ description: "Name for the well (also the agent's name)." }),
      fromImage: Type.Optional(Type.String({ description: "Saved image to fork from (e.g. 'cell-base'). Default: 'ubuntu-25.10-base' (slow path, full cloud-init bake)." })),
      env: Type.Optional(Type.Array(Type.String(), {
        description: "List of 'KEY=VALUE' strings injected via cloud-init's --env (lands in /etc/environment, PAM-loaded on every shell).",
      })),
    }),
    async execute(_id: string, params: { name: string; fromImage?: string; env?: string[] }, signal: AbortSignal) {
      if (signal.aborted) throw new Error("aborted");
      const args = ["create", params.name];
      if (params.fromImage) args.push(`--from-image=${params.fromImage}`);
      for (const kv of params.env ?? []) args.push("--env", kv);
      const r = await runWell(args);
      return { content: [{ type: "text", text: fmt(`well_create ${params.name}`, r) }] };
    },
  });

  pi.registerTool({
    name: "well_destroy",
    label: "Destroy well",
    description:
      "Destroy a well VM. Irreversible — all filesystem state is lost. Use only after the user has confirmed.",
    parameters: Type.Object({
      name: Type.String({ description: "well name to destroy." }),
    }),
    async execute(_id: string, params: { name: string }) {
      const r = await runWell(["destroy", "-s", params.name, "--force"]);
      return { content: [{ type: "text", text: fmt(`well_destroy ${params.name}`, r) }] };
    },
  });

  pi.registerTool({
    name: "well_exec",
    label: "Run on well",
    description:
      "Run a bash command on a well. Default user is `cell` (HOME=/root, in sudo group — owns /root, /root/.pi, /root/AGENTS.md, etc.); pass `user: \"well\"` only for substrate-level operations on /etc/* outside cells's tree, /var/log inspection, or apt-style root work that doesn't fit a one-line `sudo` prefix. With the default, `~` resolves to `/root` so identity-bake-in seds (`sed -i 's/__NAME__/<NAME>/g' /root/AGENTS.md`), per-cell .pi writes (`cat > /root/.pi/status.json`), and pi-time writes all work. Returns stdout and stderr. Default timeout is 10 minutes — pass `timeoutSeconds` for steps that should fail faster (e.g. package installs that often hang on registry stalls).",
    parameters: Type.Object({
      name: Type.String({ description: "well name." }),
      command: Type.String({ description: "Bash command to run on the well." }),
      user: Type.Optional(Type.Union([Type.Literal("cell"), Type.Literal("well")], {
        description: "User to run the command as. Default 'cell' — sudoes to root so the command has full filesystem access to /root (the agent runs as root inside the VM). Use 'well' only for substrate-level operations that explicitly need the wells base user.",
      })),
      timeoutSeconds: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 1800,
        description: "Kill the command after this many seconds (max 1800 = 30min). Default 600.",
      })),
    }),
    async execute(_id: string, params: { name: string; command: string; user?: "cell" | "well"; timeoutSeconds?: number }, signal: AbortSignal) {
      if (signal.aborted) throw new Error("aborted");
      // wells's `well exec` defaults to ssh user `well`. user="cell" lifts
      // to root via sudo (the cell user is unused since the root-cell
      // migration; the agent runs as root). `well` is in NOPASSWD sudoers
      // per the wells base, so the sudo step doesn't prompt. /root is
      // root:root post-bake.
      const user = params.user ?? "cell";
      // user="cell" = agent's effective context: root with HOME=/root so
      // tools that key off HOME (codex via CODEX_HOME, claude via .claude)
      // find their cell-scoped config. user="well" = raw substrate user, no
      // sudo, no HOME tweak — for substrate-level operations.
      const args = user === "well"
        ? ["exec", "-s", params.name, "--", "bash", "-c", params.command]
        : ["exec", "-s", params.name, "--", "sudo", "bash", "-c", `export HOME=/root; ${params.command}`];
      const r = await runWell(
        args,
        params.timeoutSeconds ? { timeoutMs: params.timeoutSeconds * 1000 } : undefined,
      );
      return { content: [{ type: "text", text: fmt(`well_exec ${params.name} (user=${user})`, r) }] };
    },
  });

  pi.registerTool({
    name: "well_push",
    label: "Push directory to well",
    description:
      "Push a local directory's contents to a path on the well via tar pipe. Pushes land root-owned — destination dir is `mkdir -p`'d as root, tar extracts as root. /root is root:root and the agent runs as root, so this matches the rest of the cell's filesystem. Use absolute remote paths like `/root` (the cell's HOME). For shipping the agent DNA at bake or egg-bake time.",
    parameters: Type.Object({
      name: Type.String({ description: "well name." }),
      localPath: Type.String({ description: "Absolute local path to the directory whose contents will be pushed." }),
      remotePath: Type.String({ description: "Path on the well where contents will land (e.g. `/root`). Created if missing; lands root-owned (the agent runs as root inside the VM)." }),
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
      // Mirror cells.ts pushLocalDirToWell: mkdir as root → tar xzf as root.
      // /root is root:root post-bake; landing root-owned matches.
      const remoteCmd = `sudo mkdir -p ${params.remotePath} && sudo bash -c 'cd ${params.remotePath} && tar xzf -'`;
      const r = await runCommand(
        SPRITE_CLI,
        ["exec", "-s", params.name, "--", "bash", "-c", remoteCmd],
        { pipeStdin: tar.stdout },
      );
      return {
        content: [
          {
            type: "text",
            text: fmt(`well_push ${params.localPath} → ${params.name}:${params.remotePath}`, r),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "well_egress_allow",
    label: "Set well egress",
    description:
      "Replace a well's egress allowlist. Pass ['*'] to allow all outbound. Each domain is a hostname or wildcard like '*.example.com'.",
    parameters: Type.Object({
      name: Type.String({ description: "well name." }),
      domains: Type.Array(Type.String(), { description: "Domains to allow." }),
    }),
    async execute(_id: string, params: { name: string; domains: string[] }) {
      const body = JSON.stringify({
        rules: params.domains.map((d) => ({ action: "allow", domain: d })),
      });
      const r = await runWell([
        "api",
        "-s",
        params.name,
        `/v1/wells/${params.name}/policy/network`,
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
            text: fmt(`well_egress_allow ${params.name} [${params.domains.join(", ")}]`, r),
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
    label: "Resolve cell to well",
    description:
      "Resolve a user-facing cell name to its underlying well name. Slow-birth cells use the same name for both. Hatched cells live on a permanent egg well (e.g. 'egg-sonnet-67706a') named differently from the cell. ALWAYS call this before well_destroy / well_exec / well_push when you only know the cell name — the well API rejects cell-name lookups for hatched cells.",
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
                text: `cell_resolve: registry not found at ${cellsPath}. Falling back: well_name=${params.name}`,
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
                text: `cell_resolve: no cell named '${params.name}' in registry. Cannot resolve well.`,
              },
            ],
          };
        }
        if (!cell.hatched_from) {
          return {
            content: [
              {
                type: "text",
                text: `cell_resolve: cell '${params.name}' is slow-birth. well_name=${params.name}`,
              },
            ],
          };
        }
        if (!existsSync(eggsPath)) {
          return {
            content: [
              {
                type: "text",
                text: `cell_resolve: cell '${params.name}' references egg ${cell.hatched_from} but ${eggsPath} is missing. Cannot resolve well.`,
              },
            ],
          };
        }
        const eggs = JSON.parse(readFileSync(eggsPath, "utf8")) as {
          eggs: Array<{ id: string; well_name: string }>;
        };
        const egg = eggs.eggs.find((e) => e.id === cell.hatched_from);
        if (!egg) {
          return {
            content: [
              {
                type: "text",
                text: `cell_resolve: cell '${params.name}' references egg ${cell.hatched_from} but no such egg in eggs.json. well likely already destroyed.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `cell_resolve: cell '${params.name}' is hatched from egg ${egg.id}. well_name=${egg.well_name}`,
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
    name: "well_checkpoint",
    label: "Checkpoint well",
    description: "Take a filesystem checkpoint of a well (~300ms, copy-on-write). Last 5 retained. Pass `comment` to label the checkpoint (e.g. `phase-tools-v1`, `pristine-v1`) so future restores can target a known-good phase.",
    parameters: Type.Object({
      name: Type.String({ description: "well name." }),
      comment: Type.Optional(Type.String({
        description: "Short label for this checkpoint. Use kebab-case identifiers like `phase-tools-v1` or `pristine-v1`.",
      })),
    }),
    async execute(_id: string, params: { name: string; comment?: string }) {
      const args = ["checkpoint", "create", "-s", params.name];
      if (params.comment) args.push("--comment", params.comment);
      const r = await runWell(args);
      const label = params.comment ? `${params.name} (${params.comment})` : params.name;
      return { content: [{ type: "text", text: fmt(`well_checkpoint ${label}`, r) }] };
    },
  });
}
