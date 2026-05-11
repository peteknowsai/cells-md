/**
 * pi-cell-dream — asynchronous learning for Pi-driven Cell agents.
 *
 * Reads past session JSONLs surgically (via targeted grep, never
 * exhaustive ingest) and distills into whichever storage packages
 * are installed: pi-cell-memory, pi-cell-mentality, pi-cell-wiki.
 *
 * Four phases (Karpathy / claudefa.st AutoDream pattern):
 *   1. Orient — survey existing storage
 *   2. Gather signal — narrow grep over JSONL since cursor
 *   3. Consolidate — fork a Pi subagent to write into storage
 *   4. Prune & index — subagent updates indexes; we update cursor + log
 *
 * Self-extending: source layer (currently JSONL only) is designed to
 * grow. See docs/ADDING_A_SOURCE.md for the protocol when adding email
 * / web / file sources.
 */

import { Type } from "@sinclair/typebox";
import { distill } from "./lib/orchestrate.ts";

export default function (pi: any) {
  pi.registerTool({
    name: "distill",
    label: "Distill — dream consolidation",
    description:
      "Run the four-phase dream consolidation: orient over existing storage (memory/mentality/wiki), gather signal from session JSONLs since the last cursor (via targeted grep, not exhaustive read), fork a subagent to consolidate findings into the installed storage packages, and prune indexes. Use periodically (typical cadence: 24h + 5 sessions, or manual). Cheaper than reading full transcripts — only matched lines and surrounding context enter the subagent's context. Returns a summary paragraph of what changed.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any) {
      const result = await distill();
      const status = result.ok ? "✓ dream complete" : "✗ dream failed";
      return {
        content: [{ type: "text", text: `${status}\n\n${result.summary}` }],
      };
    },
  });
}
