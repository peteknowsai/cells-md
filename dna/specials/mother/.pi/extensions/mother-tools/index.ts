/**
 * mother-tools — Pi extension giving mother callback access to the Mac.
 *
 * mother used to run on the Mac filesystem and could touch ~/.cells/ and
 * shell out to `well exec` directly. Now mother lives in a well; she
 * reaches back via proxy.cells.md/bridge/* (Bearer-auth'd with the same
 * CELLS_PROXY_SECRET she already holds for LLM calls).
 *
 * Endpoints owned by proxy.ts's handleBridgeProxy:
 *   POST /bridge/pool/claim     → claim a warm egg
 *   POST /bridge/pool/sweep     → destroy half-born egg + refill
 *   POST /bridge/registry/read  → ~/.cells/cells.json
 *   POST /bridge/registry/write → overwrite cells.json
 *   POST /bridge/well/ssh       → well exec a script
 *   POST /bridge/birth/outcome  → write outcome JSON the cells CLI polls for
 *
 * Tool names mirror the legacy on-Mac primitives mother used to call so the
 * birthing ritual can swap them in one-for-one.
 */

import { Type } from "@sinclair/typebox";

const BRIDGE_BASE = process.env.CELLS_BRIDGE_URL ?? "https://proxy.cells.md/bridge";

function bearer(): string {
  const s = process.env.CELLS_PROXY_SECRET ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "";
  if (!s) throw new Error("CELLS_PROXY_SECRET not set in mother's environment");
  return `Bearer ${s}`;
}

async function bridgePost(path: string, body: any): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const r = await fetch(`${BRIDGE_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: bearer() },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: r.ok, status: r.status, data, text };
}

function fmt(label: string, r: { ok: boolean; status: number; data: any; text: string }): string {
  const head = `${label} → ${r.status}${r.ok ? " ok" : " FAIL"}`;
  const body = r.data ? JSON.stringify(r.data, null, 2) : r.text || "(empty)";
  return `${head}\n${body}`;
}

export default function (pi: any) {
  pi.registerTool({
    name: "pool_claim",
    label: "Claim a warm egg",
    description:
      "Claim a generic warm egg from the cells pool, marking it for the named cell. Returns {wellName, tier, id}, or 503 if no warm egg is available (refill is async — retry after a few seconds).",
    parameters: Type.Object({
      cellName: Type.String({ description: "Cell name (kebab-case)." }),
    }),
    async execute(_id: string, params: { cellName: string }) {
      const r = await bridgePost("/pool/claim", { cellName: params.cellName });
      return { content: [{ type: "text", text: fmt(`pool_claim ${params.cellName}`, r) }] };
    },
  });

  pi.registerTool({
    name: "pool_sweep",
    label: "Sweep half-born egg",
    description:
      "Destroy a half-born well + drop it from the pool + trigger an async refill. Use only after a birth has failed (otherwise you waste a baked egg).",
    parameters: Type.Object({
      wellName: Type.String({ description: "egg-<hex> well name to destroy." }),
    }),
    async execute(_id: string, params: { wellName: string }) {
      const r = await bridgePost("/pool/sweep", { wellName: params.wellName });
      return { content: [{ type: "text", text: fmt(`pool_sweep ${params.wellName}`, r) }] };
    },
  });

  pi.registerTool({
    name: "registry_read",
    label: "Read cells registry",
    description: "Return the full ~/.cells/cells.json (the family roster) as {cells:[...]}.",
    parameters: Type.Object({}),
    async execute() {
      const r = await bridgePost("/registry/read", {});
      return { content: [{ type: "text", text: fmt("registry_read", r) }] };
    },
  });

  pi.registerTool({
    name: "registry_write",
    label: "Overwrite cells registry",
    description:
      "Replace ~/.cells/cells.json with the supplied {cells:[...]} document. Caller must read-modify-write — there is no append op. Use sparingly; the registry is shared across the fleet.",
    parameters: Type.Object({
      cells: Type.Array(Type.Any(), { description: "Full Cell[] array (read with registry_read first, edit, write back)." }),
    }),
    async execute(_id: string, params: { cells: any[] }) {
      const r = await bridgePost("/registry/write", { cells: params.cells });
      return { content: [{ type: "text", text: fmt(`registry_write (${params.cells.length} cells)`, r) }] };
    },
  });

  pi.registerTool({
    name: "well_ssh",
    label: "Exec on a well",
    description:
      "Run a bash script in a target well (via the Mac's `well exec`). Returns {ok, exit, stdout, stderr}. Use for newborn wells you're imprinting during the birthing ritual.",
    parameters: Type.Object({
      wellName: Type.String({ description: "Target well name." }),
      script: Type.String({ description: "Bash script to execute (single string; can be multi-line)." }),
    }),
    async execute(_id: string, params: { wellName: string; script: string }) {
      const r = await bridgePost("/well/ssh", params);
      return { content: [{ type: "text", text: fmt(`well_ssh ${params.wellName}`, r) }] };
    },
  });

  pi.registerTool({
    name: "birth_outcome",
    label: "Report birth outcome",
    description:
      "Final step of the birthing ritual. Write a {success, message} outcome the cells CLI is long-polling for at ~/.cells/birth-outcomes/<birthId>.json. Always call this exactly once per birth — success=true on alive+talk-verified, false otherwise.",
    parameters: Type.Object({
      birthId: Type.String({ description: "Birth correlation id (kebab-case; supplied by the CLI in /cell-create)." }),
      success: Type.Boolean(),
      message: Type.String({ description: "Short human-readable note (one line)." }),
    }),
    async execute(_id: string, params: { birthId: string; success: boolean; message: string }) {
      const r = await bridgePost("/birth/outcome", params);
      return { content: [{ type: "text", text: fmt(`birth_outcome ${params.birthId} (${params.success ? "ok" : "FAIL"})`, r) }] };
    },
  });
}
