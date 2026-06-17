/**
 * deep-research — fire off the latest Claude Opus for hard questions.
 *
 * The pattern (Pete, 2026-06-11): a chat-facing cell runs a fast model
 * (gpt-5.5 low) so conversation stays snappy, and reaches for this tool when
 * a question deserves deep thinking. The tool shells out to `claude -p
 * --model opus` ON THIS BOX — the claude-code harness binary baked into
 * every cell — which rides the Mac proxy on the Claude Max sub. That keeps
 * the Max policy intact (Max is claude-code-only): the cell *chats* on the
 * ChatGPT sub and *researches* through the claude binary.
 *
 * Plumbing the call rides on (all baked at birth, nothing to configure here):
 *   - /root/.claude/settings.json → ANTHROPIC_BASE_URL=https://proxy.cells.md
 *     + the x-cell-name header.
 *   - /etc/profile.d/cells-env.sh (sourced by bash -lc) → ANTHROPIC_AUTH_TOKEN.
 *   - The proxy gate: the cell's registry modelChain must carry a
 *     `claude-code:anthropic/opus:high` entry or the proxy 403s the call
 *     (grant it with `cells chain <cell> --add claude-code:anthropic/opus:high`).
 *   - `--model opus` is the latest-Opus alias, and the proxy normalizes any
 *     opus-family ID to the newest Opus regardless — never pinned.
 */

import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";

const AGENT_DIR = "/root";
// Deep turns are minutes, not seconds. The leash exists so a wedged claude
// process can't hang the conversation forever.
const TIMEOUT_MS = Number(process.env.DEEP_RESEARCH_TIMEOUT_S ?? 360) * 1000;

type RunResult = { ok: boolean; exit: number; timedOut: boolean; stdout: string; stderr: string };

function runClaude(prompt: string, signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    // bash -lc: a login shell sources /etc/profile.d/cells-env.sh, which is
    // where ANTHROPIC_AUTH_TOKEN (the proxy bearer), CELL_NAME, and PATH
    // come from.
    //
    // Preflight self-heal: cells born by a pre-2026-06-11 bake only
    // imprinted .claude/settings.json on the claude-code harness, so a pi
    // cell can still carry `x-cell-name: __NAME__` — which the proxy gate
    // looks up verbatim and 403s. Imprint from CELL_NAME (the canonical
    // identity in /etc/environment) before the first call; a no-op on
    // imprinted cells.
    const preflight =
      'if grep -q __NAME__ /root/.claude/settings.json 2>/dev/null; then ' +
      'sudo sed -i "s/__NAME__/${CELL_NAME:?}/g; s/__MODEL__/opus/g; s/__THINKING__/high/g" /root/.claude/settings.json; fi; ';
    const proc = spawn(
      "bash",
      [
        "-lc",
        preflight +
          "export HOME=/root IS_SANDBOX=1; cd /root && exec claude -p --model opus --permission-mode bypassPermissions",
      ],
      { cwd: AGENT_DIR, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, TIMEOUT_MS);
    const onAbort = () => proc.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ ok: code === 0, exit: code ?? -1, timedOut, stdout, stderr });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ ok: false, exit: -1, timedOut, stdout, stderr: stderr + (e.message ?? String(e)) });
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export default function (pi: any) {
  pi.registerTool({
    name: "deep_research",
    label: "Deep research",
    description:
      "Hand a hard question to a much stronger, slower reasoning model (the latest Claude Opus) running on this box. " +
      "Call this when a question deserves deep analysis — multi-step reasoning, research, planning, anything where " +
      "quality matters more than speed — rather than answering a hard question shallowly yourself. " +
      "Do NOT call it for routine chat, simple lookups, or anything you can answer well directly. " +
      "It takes one to five minutes and the conversation waits, so tell the user you're digging in. " +
      "The researcher starts cold: pass the full question AND whatever conversation context it needs. " +
      "It can read this cell's files (memory, notes, state) and reach the web.",
    parameters: Type.Object({
      question: Type.String({
        description: "The full question or task for the deep model. Be specific about what a great answer looks like.",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Conversation context the researcher needs: who's asking, constraints, what's been discussed, relevant file paths.",
        }),
      ),
    }),
    async execute(_id: string, params: { question: string; context?: string }, signal: AbortSignal) {
      if (signal.aborted) throw new Error("aborted");
      const prompt = [
        "You are the deep-research half of a two-speed agent: a fast chat model handles conversation and has handed you a question that deserves real thought.",
        "Think it through fully and answer with depth and rigor. Your reply goes back to the chat model, which will relay it — write the substance, not pleasantries.",
        params.context ? `\nContext from the conversation:\n${params.context}` : "",
        `\nThe question:\n${params.question}`,
      ].join("\n");
      let r = await runClaude(prompt, signal);
      // One retry on a fast, empty failure. Observed live (bob, 2026-06-11):
      // the very first in-fork claude invocation on a cell can die in a few
      // seconds with no output, and every call after it succeeds. A single
      // deterministic retry absorbs that class without masking real errors —
      // a second identical failure is reported.
      if (!r.ok && !r.timedOut && !r.stdout.trim() && !signal.aborted) {
        r = await runClaude(prompt, signal);
      }
      if (r.timedOut) {
        return {
          content: [
            {
              type: "text",
              text: `✗ deep_research timed out after ${TIMEOUT_MS / 1000}s. Partial output (may be empty):\n${r.stdout.trim()}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: r.ok
              ? r.stdout.trim() || "(deep_research returned no text)"
              : `✗ deep_research failed (exit=${r.exit}): ${r.stderr.trim().slice(0, 800)}`,
          },
        ],
      };
    },
  });
}
