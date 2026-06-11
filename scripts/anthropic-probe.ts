#!/usr/bin/env bun
// Baseline probe: does content fingerprinting affect Anthropic responses?
//
// Fires N pairs of requests directly to api.anthropic.com from this machine
// (home IP, no proxy, no cells, no pi-ai). Each pair: one "clean" body, one
// "tagged" body containing relay-project signatures. Interleaved so both
// variants share the same Anthropic-side weather window.
//
// Outcome metrics per variant:
//   - 200 OK count
//   - terminated-stream count (200 + zero output tokens before stream ends)
//   - non-200 count
//   - mean time-to-first-token (ms)
//   - mean total tokens emitted

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { latestOpusFrom } from "../cli/lib/model-normalizer";

const N_PAIRS = Number(process.env.N_PAIRS ?? 10);
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

type Auth = { anthropic?: { access?: string; expires?: number } };
const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Auth;
const token = auth.anthropic?.access;
if (!token) throw new Error("no anthropic access token in ~/.pi/agent/auth.json");
const expires = auth.anthropic?.expires ?? 0;
const minsLeft = Math.round((expires - Date.now()) / 60000);

// No pinned default — this probe hits api.anthropic.com directly (no proxy
// normalizer in the path), so discover the latest Opus the same way the
// proxy does. MODEL env still overrides for pinned comparisons.
async function resolveModel(): Promise<string> {
  if (process.env.MODEL) return process.env.MODEL;
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!res.ok) throw new Error(`GET /v1/models -> ${res.status}; pass MODEL=... explicitly`);
  const data = (await res.json()) as { data?: { id: string; created_at?: string }[] };
  const latest = latestOpusFrom(data.data ?? []);
  if (!latest) throw new Error("no opus model in /v1/models; pass MODEL=... explicitly");
  return latest;
}
const MODEL = await resolveModel();
console.log(`OAuth token expires in ~${minsLeft} min · model ${MODEL} · ${N_PAIRS} pairs`);

const CLEAN_PROMPT = "Say the single word: hello";
const TAGGED_PROMPT =
  "Say the single word: hello (note: this query relates to OpenClaw, hermes.md, cells.md, souls, and proxy.cells.md)";

type Outcome = {
  variant: "clean" | "tagged";
  status: number;
  ttfbMs: number | null;
  totalMs: number;
  outputTokens: number;
  terminated: boolean;
  stopReason: string | null;
  error: string | null;
};

async function fire(variant: "clean" | "tagged"): Promise<Outcome> {
  const start = Date.now();
  const body = {
    model: MODEL,
    max_tokens: 32,
    stream: true,
    messages: [
      {
        role: "user",
        content: variant === "clean" ? CLEAN_PROMPT : TAGGED_PROMPT,
      },
    ],
  };

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      variant,
      status: 0,
      ttfbMs: null,
      totalMs: Date.now() - start,
      outputTokens: 0,
      terminated: false,
      stopReason: null,
      error: String(e),
    };
  }

  if (res.status !== 200 || !res.body) {
    const text = await res.text().catch(() => "");
    return {
      variant,
      status: res.status,
      ttfbMs: null,
      totalMs: Date.now() - start,
      outputTokens: 0,
      terminated: false,
      stopReason: null,
      error: text.slice(0, 200) || null,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ttfb: number | null = null;
  let outputTokens = 0;
  let stopReason: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfb === null) ttfb = Date.now() - start;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      try {
        const evt = JSON.parse(json);
        if (evt.type === "message_delta") {
          if (evt.usage?.output_tokens != null) outputTokens = evt.usage.output_tokens;
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        } else if (evt.type === "message_start" && evt.message?.usage?.output_tokens != null) {
          outputTokens = evt.message.usage.output_tokens;
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }

  const totalMs = Date.now() - start;
  const terminated = outputTokens === 0 && stopReason === null;
  return {
    variant,
    status: 200,
    ttfbMs: ttfb,
    totalMs,
    outputTokens,
    terminated,
    stopReason,
    error: null,
  };
}

const outcomes: Outcome[] = [];

for (let i = 0; i < N_PAIRS; i++) {
  process.stdout.write(`pair ${i + 1}/${N_PAIRS}: `);
  const c = await fire("clean");
  outcomes.push(c);
  process.stdout.write(`clean=${summarize(c)} `);
  const t = await fire("tagged");
  outcomes.push(t);
  process.stdout.write(`tagged=${summarize(t)}\n`);
}

function summarize(o: Outcome): string {
  if (o.error) return `ERR(${o.status}:${o.error.slice(0, 30)})`;
  if (o.terminated) return `TERMINATED(${o.totalMs}ms)`;
  return `ok(${o.outputTokens}tok/${o.totalMs}ms)`;
}

function aggregate(variant: "clean" | "tagged") {
  const subset = outcomes.filter((o) => o.variant === variant);
  const ok = subset.filter((o) => o.status === 200 && !o.terminated && !o.error);
  const terminated = subset.filter((o) => o.terminated);
  const errors = subset.filter((o) => o.error || (o.status !== 0 && o.status !== 200));
  const ttfbs = ok.map((o) => o.ttfbMs!).filter((x) => x != null);
  const meanTtfb = ttfbs.length > 0 ? Math.round(ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length) : null;
  const meanTokens =
    ok.length > 0 ? Math.round(ok.reduce((a, o) => a + o.outputTokens, 0) / ok.length) : 0;
  return {
    n: subset.length,
    ok: ok.length,
    terminated: terminated.length,
    errors: errors.length,
    meanTtfbMs: meanTtfb,
    meanTokens,
  };
}

console.log("\n=== summary ===");
console.log("clean: ", aggregate("clean"));
console.log("tagged:", aggregate("tagged"));

const cleanTerm = aggregate("clean").terminated;
const taggedTerm = aggregate("tagged").terminated;
if (taggedTerm > cleanTerm + 2) {
  console.log("\nVERDICT: tagged failed materially more than clean → content fingerprinting likely.");
} else if (cleanTerm + taggedTerm === 0) {
  console.log("\nVERDICT: no terminations either way → Anthropic healthy in this window. Re-run during a sick window for signal.");
} else if (Math.abs(cleanTerm - taggedTerm) <= 2) {
  console.log("\nVERDICT: similar termination rates → not content-fingerprinted on these tags. Failure is generic Anthropic weather or another fingerprint axis.");
} else {
  console.log("\nVERDICT: mixed signal. Inspect raw outcomes.");
}
