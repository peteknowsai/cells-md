/**
 * agent-envelope — the wire format for cells-to-cells messaging.
 *
 * Used by:
 *   - cli/worker/cell/cell-agent.ts (DO routes inbound /inbox/append events
 *     with kind:"agent" to either the supervisor or the corr_id matcher).
 *   - dna/cells/base/site/server.ts (supervisor handles agent_message WS
 *     frames forwarded by the DO; fork-and-asks via the harness adapter).
 *   - dna/cells/base/bin/cells (the `cells talk` CLI builds these envelopes
 *     and POSTs them to <peer>.cells.md/inbox/append).
 *
 * Pure shapes + helpers. No I/O, no harness coupling. The worker's
 * bundler can't reach into dna/ — see cli/worker/shared/agent-envelope.ts
 * for the worker-side mirror of the types.
 */

export type AgentTarget = "fork" | "main";

export const MAX_HOPS = 5;

export interface AgentEnvelope {
  kind: "agent";
  from: string;          // sender cell name
  to: string;            // recipient cell name
  corr_id: string;       // ULID — matches reply to send
  thread_id: string;     // conversation id; default = sorted pair joined by ":"
  target: AgentTarget;   // "fork" (default, read main, no write-back) | "main" (writes)
  session?: string;      // named durable session (e.g. "buyer", "staff"); overrides
                         // target routing → the cell's interactive talk pool. "main"
                         // is equivalent to target:"main". Absent = target routing.
  reply_to: string;      // URL to POST the response to; "" for fire-and-forget
  hops: number;          // incremented at each relay; drop if > MAX_HOPS
  sent_at: string;       // ISO 8601
  expires_at: string;    // ISO 8601 — receiver drops if processing starts after expiry
  in_reply_to: string | null;  // corr_id this is responding to; null for new sends
  text: string;          // the actual prompt or response
}

// ---- ULID generation (Crockford base32, 26 chars, monotonic timestamp + random) ----

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford alphabet

function encodeTime(ms: number): string {
  let out = "";
  for (let i = 9; i >= 0; i--) {
    out = B32[ms % 32]! + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function encodeRandom(rand: Uint8Array): string {
  // 16 base32 chars = 80 bits. Take 10 bytes of randomness, encode bit-packed.
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

// ---- Validation ----

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

export function sortedThreadId(a: string, b: string): string {
  return [a, b].sort().join(":");
}

// ---- Construction helpers ----

export interface SendArgs {
  from: string;
  to: string;
  text: string;
  target?: AgentTarget;
  session?: string;      // named durable session; overrides target → talk pool
  thread_id?: string;
  reply_to?: string;     // sender's inbox URL; "" for fire-and-forget
  timeout_seconds?: number;
}

export function makeOutgoing(args: SendArgs): AgentEnvelope {
  const now = Date.now();
  const sent_at = new Date(now).toISOString();
  const expires_at = args.timeout_seconds
    ? new Date(now + args.timeout_seconds * 1000).toISOString()
    : "";
  return {
    kind: "agent",
    from: args.from,
    to: args.to,
    corr_id: ulid(now),
    thread_id: args.thread_id ?? sortedThreadId(args.from, args.to),
    target: args.target ?? "fork",
    ...(args.session ? { session: args.session } : {}),
    reply_to: args.reply_to ?? "",
    hops: 0,
    sent_at,
    expires_at,
    in_reply_to: null,
    text: args.text,
  };
}

export interface ReplyArgs {
  from: string;
  to: string;
  in_reply_to: string;
  text: string;
  thread_id?: string;
}

export function makeReply(args: ReplyArgs): AgentEnvelope {
  const now = Date.now();
  return {
    kind: "agent",
    from: args.from,
    to: args.to,
    corr_id: ulid(now),
    thread_id: args.thread_id ?? sortedThreadId(args.from, args.to),
    target: "fork",          // replies always go to the sender's matcher, not their main
    reply_to: "",            // no chained reply expected
    hops: 0,
    sent_at: new Date(now).toISOString(),
    expires_at: "",
    in_reply_to: args.in_reply_to,
    text: args.text,
  };
}

// ---- TTL check ----

export function isExpired(env: AgentEnvelope, now: number = Date.now()): boolean {
  if (!env.expires_at) return false;
  return new Date(env.expires_at).getTime() < now;
}
