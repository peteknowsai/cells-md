/**
 * agent-envelope (worker-side mirror) — kept in sync with
 * dna/cells/base/lib/agent-envelope.ts. The DNA copy is loaded inside the
 * cell (by site/server.ts and the on-cell `cells talk` CLI). This copy is
 * loaded inside the CF Worker (by cli/worker/cell/cell-agent.ts).
 *
 * If you change one, change both. The shapes must match — the envelope
 * crosses the worker ↔ supervisor boundary.
 */

export type AgentTarget = "fork" | "main";

export const MAX_HOPS = 5;

export interface AgentEnvelope {
  kind: "agent";
  from: string;
  to: string;
  corr_id: string;
  thread_id: string;
  target: AgentTarget;
  // Named durable session (e.g. "buyer", "staff") → the cell's interactive talk
  // pool, overriding target routing. "main" ≡ target:"main". Absent = target.
  session?: string;
  reply_to: string;
  hops: number;
  sent_at: string;
  expires_at: string;
  in_reply_to: string | null;
  text: string;
}

// ---- ULID generation (Crockford base32, 26 chars) ----

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number): string {
  let out = "";
  for (let i = 9; i >= 0; i--) {
    out = B32[ms % 32]! + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function encodeRandom(rand: Uint8Array): string {
  let bits = "";
  for (let i = 0; i < 10; i++) {
    bits += rand[i]!.toString(2).padStart(8, "0");
  }
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += B32[parseInt(bits.slice(i * 5, i * 5 + 5), 2)]!;
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  return encodeTime(now) + encodeRandom(rand);
}

export function sortedThreadId(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export function validateEnvelope(e: any): { ok: true; env: AgentEnvelope } | { ok: false; reason: string } {
  if (!e || typeof e !== "object") return { ok: false, reason: "not an object" };
  if (e.kind !== "agent") return { ok: false, reason: "kind != agent" };
  if (typeof e.from !== "string" || !e.from) return { ok: false, reason: "missing from" };
  if (typeof e.to !== "string" || !e.to) return { ok: false, reason: "missing to" };
  if (typeof e.corr_id !== "string" || !e.corr_id) return { ok: false, reason: "missing corr_id" };
  if (typeof e.text !== "string") return { ok: false, reason: "missing text" };
  const hops = Number(e.hops ?? 0);
  if (!Number.isFinite(hops) || hops < 0) return { ok: false, reason: "bad hops" };
  const target: AgentTarget = e.target === "main" ? "main" : "fork";
  return {
    ok: true,
    env: {
      kind: "agent",
      from: e.from,
      to: e.to,
      corr_id: e.corr_id,
      thread_id: typeof e.thread_id === "string" ? e.thread_id : sortedThreadId(e.from, e.to),
      target,
      ...(typeof e.session === "string" && e.session ? { session: e.session } : {}),
      reply_to: typeof e.reply_to === "string" ? e.reply_to : "",
      hops,
      sent_at: typeof e.sent_at === "string" ? e.sent_at : new Date().toISOString(),
      expires_at: typeof e.expires_at === "string" ? e.expires_at : "",
      in_reply_to: typeof e.in_reply_to === "string" ? e.in_reply_to : null,
      text: e.text,
    },
  };
}

export function isExpired(env: AgentEnvelope, now: number = Date.now()): boolean {
  if (!env.expires_at) return false;
  return new Date(env.expires_at).getTime() < now;
}
