/**
 * deliberate — the Foreman's tool for convening the jury.
 *
 * Two-phase deliberation across N juror cells:
 *   1. `deliberate(question)`   — fan out to all jurors, get quick takes
 *   2. `deep_dive(jurors[],…)`  — pick 2–3 to expand
 *
 * Mechanism: POST `/v1/sprites/<juror>/exec` with `bash -lc 'pi -p "…"'`.
 * Each juror's full DNA (SOUL.md, memory, etc.) loads automatically because
 * `pi -p` runs in `/home/sprite/agent` with the cell's settings.
 *
 * This extension is registered ONLY on the foreman cell (see
 * scripts/birth-jury.sh). Non-foreman cells don't load it.
 */

import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";

const API = "https://api.sprites.dev";
const TOKEN = process.env.WELL_TOKEN;
const MAX_CONCURRENCY = 4;

const JURY_FILE = "/home/sprite/agent/.pi/extensions/deliberate/jury.json";

type Juror = { name: string; displayName: string };

function loadJury(): Juror[] {
  if (!fs.existsSync(JURY_FILE)) {
    throw new Error(`jury.json not found at ${JURY_FILE}`);
  }
  return JSON.parse(fs.readFileSync(JURY_FILE, "utf-8"));
}

async function execOnSprite(name: string, command: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (!TOKEN) return { ok: false, stdout: "", stderr: "WELL_TOKEN not set" };
  try {
    const r = await fetch(`${API}/v1/sprites/${encodeURIComponent(name)}/exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command: ["bash", "-lc", command] }),
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, stdout: "", stderr: `HTTP ${r.status}: ${text.slice(0, 300)}` };
    try {
      const j = JSON.parse(text);
      return {
        ok: (j.exit_code ?? j.exitCode ?? 0) === 0,
        stdout: (j.stdout ?? "").toString(),
        stderr: (j.stderr ?? "").toString(),
      };
    } catch {
      return { ok: true, stdout: text, stderr: "" };
    }
  } catch (e: any) {
    return { ok: false, stdout: "", stderr: e?.message ?? String(e) };
  }
}

async function askJuror(juror: Juror, prompt: string): Promise<{ juror: string; displayName: string; response: string; ok: boolean; elapsedMs: number; error?: string }> {
  const start = Date.now();
  // Escape the prompt for single-quoted bash.
  const escaped = prompt.replace(/'/g, "'\\''");
  const cmd = `cd /home/sprite/agent && pi -p '${escaped}' 2>&1`;
  const r = await execOnSprite(juror.name, cmd);
  return {
    juror: juror.name,
    displayName: juror.displayName,
    response: r.ok ? r.stdout.trim() : "",
    ok: r.ok && r.stdout.trim().length > 0,
    elapsedMs: Date.now() - start,
    error: r.ok ? undefined : (r.stderr || "(empty response)"),
  };
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, n: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (true) {
      const cur = i++;
      if (cur >= tasks.length) return;
      results[cur] = await tasks[cur]!();
    }
  });
  await Promise.all(workers);
  return results;
}

function quickTakePrompt(question: string): string {
  return [
    "The Foreman has convened the jury. You are being asked to deliberate.",
    "",
    `Question: ${question}`,
    "",
    "Give your perspective in 2-4 paragraphs. Speak in your authentic voice —",
    "draw from your philosophy, your experience, your way of seeing.",
    "Be specific and direct. This person needs wisdom, not platitudes.",
    "",
    "Reply with ONLY your perspective. No preamble, no meta, no tool use —",
    "just speak as yourself.",
  ].join("\n");
}

function deepDivePrompt(question: string, priorTake: string): string {
  return [
    "The Foreman has asked you to go deeper on a question you already weighed in on.",
    "",
    `Question: ${question}`,
    "",
    "Your initial take was:",
    priorTake,
    "",
    "Now go deeper. 4-6 paragraphs. Consider nuance, edge cases, what you might be wrong about.",
    "Speak from your deepest wisdom. Reply with ONLY your expanded perspective.",
  ].join("\n");
}

// Per-process cache of the last deliberation so deep_dive can re-use the takes.
let lastDeliberation: { question: string; takes: Array<{ juror: string; displayName: string; response: string }> } | null = null;

export default function (pi: any) {
  pi.registerTool({
    name: "deliberate",
    label: "Convene the jury",
    description:
      "Round 1 of a deliberation. Puts a clearly-framed question before all jurors in parallel and returns their quick takes. After reading them, call `deep_dive` with 2-3 juror keys to expand on, then synthesize a verdict.",
    parameters: Type.Object({
      question: Type.String({ description: "The question for the jury, clearly framed." }),
    }),
    async execute(_id: string, params: { question: string }) {
      const jury = loadJury();
      const tasks = jury.map((j) => () => askJuror(j, quickTakePrompt(params.question)));
      const results = await runWithConcurrency(tasks, MAX_CONCURRENCY);

      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);

      lastDeliberation = {
        question: params.question,
        takes: succeeded.map((r) => ({ juror: r.juror, displayName: r.displayName, response: r.response })),
      };

      const out: string[] = [];
      out.push("# Jury — Round 1: Quick Takes");
      out.push("");
      out.push(`**Question:** ${params.question}`);
      out.push("");
      out.push(`*${succeeded.length} of ${jury.length} jurors responded.*`);
      if (failed.length > 0) {
        out.push(`*Did not respond: ${failed.map((f) => `${f.displayName} (${f.error?.slice(0, 80)})`).join("; ")}*`);
      }
      out.push("");
      for (const r of succeeded) {
        out.push(`### ${r.displayName} (\`${r.juror}\`)`);
        out.push(r.response);
        out.push("");
      }
      out.push("---");
      out.push("**Round 2:** Pick 2-3 jurors who should go deeper. Call `deep_dive`");
      out.push("with their juror keys. Choose for substance: whose perspective most");
      out.push("needs elaboration, which combination creates the richest contrast,");
      out.push("whose take is most provocative or worth challenging.");

      return { content: [{ type: "text", text: out.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "deep_dive",
    label: "Deep dive",
    description:
      "Round 2 of a deliberation. After `deliberate`, pick 2-3 jurors and call this with their juror keys. Each will expand on their initial take. After reading, synthesize a verdict for the person who asked.",
    parameters: Type.Object({
      jurors: Type.Array(Type.String(), {
        description: "Juror keys (lowercase, hyphenated) from the deliberate output.",
      }),
      reason: Type.Optional(Type.String({ description: "One sentence on why these were chosen." })),
    }),
    async execute(_id: string, params: { jurors: string[]; reason?: string }) {
      if (!lastDeliberation) {
        return { content: [{ type: "text", text: "No prior deliberation in this session. Call `deliberate` first." }], isError: true };
      }
      const byKey = new Map(lastDeliberation.takes.map((t) => [t.juror, t]));
      const valid = params.jurors.filter((j) => byKey.has(j));
      const unknown = params.jurors.filter((j) => !byKey.has(j));
      if (valid.length === 0) {
        return {
          content: [{ type: "text", text: `No valid juror keys. Available: ${[...byKey.keys()].join(", ")}. You passed: ${params.jurors.join(", ")}` }],
          isError: true,
        };
      }

      const tasks = valid.map((key) => {
        const t = byKey.get(key)!;
        return () => askJuror({ name: t.juror, displayName: t.displayName }, deepDivePrompt(lastDeliberation!.question, t.response));
      });
      const results = await runWithConcurrency(tasks, MAX_CONCURRENCY);

      const out: string[] = [];
      out.push("# Jury — Round 2: Deep Dives");
      out.push("");
      out.push(`**Question:** ${lastDeliberation.question}`);
      if (params.reason) out.push(`*Foreman's selection:* ${params.reason}`);
      if (unknown.length > 0) out.push(`*Ignored unknown keys:* ${unknown.join(", ")}`);
      out.push("");
      for (const r of results) {
        if (r.ok) {
          out.push(`### ${r.displayName} (expanded)`);
          out.push(r.response);
          out.push("");
        } else {
          out.push(`### ${r.displayName} — failed: ${r.error?.slice(0, 100)}`);
          out.push("");
        }
      }
      out.push("---");
      out.push("Now synthesize these perspectives into a verdict for the person who asked.");
      out.push("Lead with the core insight. Highlight the most striking perspective.");
      out.push("Note meaningful dissent. Close with something actionable.");

      return { content: [{ type: "text", text: out.join("\n") }] };
    },
  });
}
