#!/usr/bin/env bun
/**
 * cells-dashboard — local Bun.serve daemon that surfaces cells fleet state.
 *
 * Public route (no auth): dashboard.cells.md via cloudflared-tunnel
 * (com.pete.cells-tunnel infra). Also accessible from cells VMs over
 * vmnet at http://192.168.64.1:7881 (bound on 0.0.0.0 so the narrator
 * cell can reach /api/state + /api/talk without going through CF).
 *
 * Reads:
 *   ~/.cells/cells.json  (cell registry)
 *   ~/.cells/pool.json   (pool members; falls back to legacy eggs.json)
 *   welld :7878 /healthz + /v1/wells (substrate liveness + IPs)
 *   host-bridge :7880 /healthz (open sessions)
 *
 * Serves:
 *   GET  /                  HTML dashboard (auto-refreshes via JS)
 *   GET  /api/state         JSON snapshot — public
 *   GET  /healthz           daemon liveness — public
 *   POST /api/talk/<name>   single-shot roll-call to a cell — bearer-gated.
 *                           Body: {prompt, wake?}. Returns {answer, elapsed_ms}.
 *                           Used by cells-narrator on each Refresh press.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { connect as netConnect } from "node:net";

const PORT = Number(process.env.CELLS_DASHBOARD_PORT ?? 7881);
const WELL_API = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
const HOST_BRIDGE_API = `http://127.0.0.1:${process.env.HOST_BRIDGE_PORT ?? 7880}`;
const HOST_BRIDGE_WS = `ws://127.0.0.1:${process.env.HOST_BRIDGE_PORT ?? 7880}/agent`;
const TALK_TIMEOUT_MS = Number(process.env.CELLS_DASHBOARD_TALK_TIMEOUT_MS ?? 20_000);

function readSecretSync(name: string): string | null {
  try {
    const obj = JSON.parse(readFileSync(join(homedir(), ".cells", "secrets.json"), "utf8"));
    return typeof obj[name] === "string" ? obj[name] : null;
  } catch { return null; }
}
const CELLS_PROXY_SECRET = readSecretSync("CELLS_PROXY_SECRET");

// ── Types ─────────────────────────────────────────────────────────────────

type PoolMemberSnapshot = {
  id: string;
  well_name: string;
  state: string;
  age_minutes: number;
  tier: number | null;
  claimed_by: string | null;
  // Harness (agent runtime) baked into the egg's pi-coding-agent install.
  // Today: always "pi". v2 variants: claude-code, codex, etc.
  harness: string;
  // Default model the egg's harness is configured for. Today: deepseek-v4-flash.
  // v2 variants will pre-bake different model chains per egg.
  model: string;
};

// Map variant_signature → user-facing harness + model strings. Add rows as
// new variant eggs ship (v2 will introduce claude-code-* and codex-* variants).
const POOL_VARIANT_META: Record<string, { harness: string; model: string }> = {
  "v1-generic": { harness: "pi", model: "deepseek-v4-flash" },
};
function poolMemberMeta(variantSig: string | undefined): { harness: string; model: string } {
  if (variantSig && POOL_VARIANT_META[variantSig]) return POOL_VARIANT_META[variantSig];
  return { harness: "?", model: "?" };
}

type CellSnapshot = {
  name: string;
  status: string;
  // Agent runtime. Today: always "pi". v2 variants: claude-code, codex, etc.
  harness: string;
  model: string;
  thinking: string;
  age_minutes: number;
  hatched_from: string | null;
  well_status: string | null;
  // Wells's wedge-detection signal (commit landing 2026-05-15). One of
  // "ok" | "suspected" | "confirmed", or null for cells whose well welld
  // hasn't yet probed (asleep/just-spawned). Cells's recovery loop reacts
  // on "confirmed"; the dashboard shows "suspected" as a soft warning.
  wedge: string | null;
  ip: string | null;
  // Birth-to-first-token in milliseconds. Captured by cmdCreateV1Fast's
  // onFirstToken callback and persisted in ~/.cells/logs/perf/first-token.jsonl.
  // Null if not yet measured (very fresh cells, or pre-instrumentation births).
  first_token_ms: number | null;
};

type StatePayload = {
  ts: string;
  pool: {
    total: number;
    warm: number;
    hot: number;       // tier 4: running, instant-claim
    cold: number;      // tier 2: hibernated, ~3s wake
    claimed: number;
    live: number;
    culling: number;
    target_depth: number;
    target_hot: number;
    list: PoolMemberSnapshot[];
  };
  cells: CellSnapshot[];
  daemons: {
    welld: { ok: boolean; uptime_minutes: number | null; degraded: boolean; vmnet_orphans: number };
    host_bridge: { ok: boolean; sessions: number };
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function readJSON<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function wellsToken(): Promise<string> {
  try {
    return (await readFile(join(homedir(), ".wells", "token"), "utf8")).trim();
  } catch {
    return "";
  }
}

// Promise-wrapped TCP-connect probe. Returns true if the host:port accepts
// a TCP connection within timeoutMs, false otherwise. We end the socket
// immediately on connect — we only care that the handshake landed. Used
// by wake-on-talk to confirm sshd is actually reachable before we hand
// the cell to host-bridge.
function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

function ageMinutes(iso: string | undefined): number {
  if (!iso) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
}

async function fetchJSON(url: string, headers: Record<string, string> = {}, timeoutMs = 2000): Promise<any | null> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ── State assembly ────────────────────────────────────────────────────────

// Parse ~/.cells/logs/perf/first-token.jsonl and return cell-name → most-recent
// first_token_ms. Tail-only: reads the whole file (small append-only log).
// Best-effort: missing/corrupt → empty map.
async function loadFirstTokenIndex(): Promise<Map<string, number>> {
  const path = join(homedir(), ".cells", "logs", "perf", "first-token.jsonl");
  try {
    const raw = await readFile(path, "utf8");
    const idx = new Map<string, number>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row.cell === "string" && typeof row.first_token_ms === "number") {
          idx.set(row.cell, row.first_token_ms);
        }
      } catch { /* skip malformed */ }
    }
    return idx;
  } catch {
    return new Map();
  }
}

async function buildState(): Promise<StatePayload> {
  // Prefer pool.json (post-rename); fall back to legacy eggs.json.
  const poolPath = join(homedir(), ".cells", "pool.json");
  const legacyPath = join(homedir(), ".cells", "eggs.json");
  const poolRaw = await readJSON<{ members?: any[]; eggs?: any[] }>(
    poolPath,
    await readJSON<{ members?: any[]; eggs?: any[] }>(legacyPath, { members: [] }),
  );
  const poolEntries = poolRaw.members ?? poolRaw.eggs ?? [];
  const regFile = await readJSON<{ cells: any[] }>(join(homedir(), ".cells", "cells.json"), { cells: [] });
  const token = await wellsToken();
  // /dashboard/data has wedge (wells team 2026-05-15); /v1/wells does not.
  // The shapes overlap for everything we read (name, status, ip), so use
  // dashboard/data uniformly.
  const [welldHealth, welldDash, hbHealth, firstTokenIdx] = await Promise.all([
    fetchJSON(`${WELL_API}/healthz`, { Authorization: `Bearer ${token}` }),
    fetchJSON(`${WELL_API}/dashboard/data`, { Authorization: `Bearer ${token}` }),
    fetchJSON(`${HOST_BRIDGE_API}/healthz`, {}, 800),
    loadFirstTokenIndex(),
  ]);

  const wellByName = new Map<string, any>();
  for (const w of welldDash?.wells ?? []) wellByName.set(w.name, w);

  // Eggs
  const poolMembers: PoolMemberSnapshot[] = poolEntries.map((e: any) => {
    const meta = poolMemberMeta(e.variant_signature);
    return {
      id: String(e.id ?? ""),
      well_name: String(e.well_name ?? ""),
      state: String(e.state ?? "?"),
      age_minutes: ageMinutes(e.born_at),
      tier: typeof e.tier === "number" ? e.tier : null,
      claimed_by: e.claimed_by ?? null,
      harness: meta.harness,
      model: meta.model,
    };
  });
  const memberCounts: Record<string, number> = {};
  for (const e of poolMembers) memberCounts[e.state] = (memberCounts[e.state] ?? 0) + 1;

  // Cells
  const cells: CellSnapshot[] = (regFile.cells ?? []).map((c: any) => {
    const wellName = c.hatched_from ? `egg-${c.hatched_from}` : c.name;
    const well = wellByName.get(wellName);
    const head = (c.modelChain?.[0] ?? "").toString();
    const [providerModel, thinking] = head.split(":");
    const model = providerModel ? providerModel.split("/").slice(-1)[0] : "?";
    // Harness defaults to "pi" (today's only harness). v2 will persist
    // c.harness on the cells.json record at birth time.
    const harness = (c.harness as string | undefined) ?? "pi";
    return {
      name: c.name,
      status: c.status ?? "alive",
      harness,
      model,
      thinking: thinking ?? "?",
      age_minutes: ageMinutes(c.created_at),
      hatched_from: c.hatched_from ?? null,
      well_status: well?.status ?? null,
      wedge: well?.wedge ?? null,
      ip: well?.ip ?? null,
      first_token_ms: firstTokenIdx.get(c.name) ?? null,
    };
  });
  // Newest first
  cells.sort((a, b) => a.age_minutes - b.age_minutes);

  const hot = poolMembers.filter((e) => e.state === "warm" && e.tier === 4).length;
  const cold = poolMembers.filter((e) => e.state === "warm" && e.tier === 2).length;

  return {
    ts: new Date().toISOString(),
    pool: {
      total: poolMembers.length,
      warm: memberCounts.warm ?? 0,
      hot,
      cold,
      claimed: memberCounts.claimed ?? 0,
      live: memberCounts.live ?? 0,
      culling: memberCounts.culling ?? 0,
      target_depth: 10,    // matches V1_POOL_TARGET_DEPTH
      target_hot: 10,      // matches V1_HOT_POOL_TARGET (pure-hot v1)
      list: poolMembers.sort((a, b) => {
        // warm first, then claimed/culling, live last; secondary: youngest first
        const rank = (s: string) => (s === "warm" ? 0 : s === "claimed" ? 1 : s === "culling" ? 2 : 3);
        const r = rank(a.state) - rank(b.state);
        return r !== 0 ? r : a.age_minutes - b.age_minutes;
      }),
    },
    cells,
    daemons: {
      welld: {
        ok: !!welldHealth?.ok,
        uptime_minutes: welldHealth?.started_at ? ageMinutes(welldHealth.started_at) : null,
        degraded: !!welldHealth?.degraded,
        vmnet_orphans: welldHealth?.vmnet_leases?.orphan_count ?? 0,
      },
      host_bridge: {
        ok: !!hbHealth?.ok,
        sessions: (hbHealth?.sessions ?? []).length,
      },
    },
  };
}

// ── HTML page (single self-contained doc, polls /api/state every 4s) ─────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>cells</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --cells: #4ca87a;
    --cells-dark: #2d7050;
    --cells-light: #e8f5ee;
    --wells: #3b82c4;
    --warn: #d99834;
    --warn-light: #fff5e0;
    --leak: #d65454;
    --leak-light: #fce8e8;
    --neutral: #6b7280;
    --neutral-light: #f3f4f6;
    --ink: #1a1a1a;
    --ink-muted: #6b6b6b;
    --bg: #fafaf8;
    --paper: #ffffff;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;
    background: var(--bg);
    color: var(--ink);
    line-height: 1.5;
    margin: 0;
    padding: 24px 28px 64px;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    border-bottom: 1px solid #e0e0dc;
    padding-bottom: 16px;
    margin-bottom: 28px;
  }
  header h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
    margin: 0;
    color: var(--cells-dark);
  }
  header h1 .dot {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--cells);
    margin-right: 8px;
    transform: translateY(-2px);
  }
  header .meta {
    font-size: 12px;
    color: var(--ink-muted);
    font-variant-numeric: tabular-nums;
  }

  .row {
    display: grid;
    gap: 14px;
    margin-bottom: 28px;
  }
  .row.cards-3 { grid-template-columns: repeat(3, 1fr); }
  .row.cards-2 { grid-template-columns: repeat(2, 1fr); }

  .card {
    background: var(--paper);
    border: 1px solid #e0e0dc;
    border-radius: 8px;
    padding: 18px 20px;
  }
  .card .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-muted);
    margin-bottom: 8px;
  }
  .card .big {
    font-size: 34px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    color: var(--cells-dark);
  }
  .card .big .small {
    font-size: 18px;
    color: var(--ink-muted);
    font-weight: 400;
    margin-left: 2px;
  }
  .card .sub {
    margin-top: 8px;
    font-size: 12px;
    color: var(--ink-muted);
  }

  h2 {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-muted);
    margin: 32px 0 12px;
    font-weight: 600;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--paper);
    border: 1px solid #e0e0dc;
    border-radius: 8px;
    overflow: hidden;
    font-size: 13px;
  }
  table th {
    background: #f3f3f0;
    padding: 9px 14px;
    text-align: left;
    font-weight: 600;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink-muted);
    border-bottom: 1px solid #e0e0dc;
  }
  table td {
    padding: 10px 14px;
    border-bottom: 1px solid #ecebe6;
    font-variant-numeric: tabular-nums;
  }
  table tr:last-child td { border-bottom: none; }
  table tr.empty td {
    text-align: center;
    color: var(--ink-muted);
    font-style: italic;
    padding: 24px;
  }

  .pill {
    display: inline-block;
    padding: 2px 9px;
    border-radius: 11px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .pill-warm { background: var(--cells-light); color: var(--cells-dark); }
  .pill-hot { background: var(--cells-light); color: var(--cells-dark); font-weight: 700; }
  .pill-cold { background: var(--neutral-light); color: var(--neutral); }
  .pill-claimed { background: var(--warn-light); color: #8a6a1f; }
  .pill-live { background: var(--neutral-light); color: var(--neutral); }
  .pill-culling { background: var(--leak-light); color: #8a3333; }
  .pill-alive { background: var(--cells-light); color: var(--cells-dark); }
  .pill-warming { background: var(--warn-light); color: #8a6a1f; }
  .pill-running { background: var(--cells-light); color: var(--cells-dark); }
  .pill-stopped { background: var(--neutral-light); color: var(--neutral); }

  .daemons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  .daemon {
    background: var(--paper);
    border: 1px solid #e0e0dc;
    border-radius: 8px;
    padding: 14px 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
  }
  .daemon .name {
    font-weight: 600;
    color: var(--ink);
  }
  .daemon .name code {
    background: var(--neutral-light);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--ink-muted);
    margin-left: 6px;
    font-family: "SF Mono", Menlo, monospace;
  }
  .daemon .right { color: var(--ink-muted); font-variant-numeric: tabular-nums; }
  .daemon.ok .name::before {
    content: "●";
    color: var(--cells);
    margin-right: 8px;
  }
  .daemon.bad .name::before {
    content: "●";
    color: var(--leak);
    margin-right: 8px;
  }
  .daemon.warn .name::before {
    content: "●";
    color: var(--warn);
    margin-right: 8px;
  }

  code {
    font-family: "SF Mono", Menlo, monospace;
    font-size: 0.92em;
  }
  .mono { font-family: "SF Mono", Menlo, monospace; font-size: 12px; }
  .muted { color: var(--ink-muted); }
</style>
</head>
<body>

<header>
  <h1><span class="dot"></span>cells</h1>
  <div class="meta">
    <span id="updated">connecting…</span>
  </div>
</header>

<div class="row cards-3">
  <div class="card">
    <div class="label">Live cells</div>
    <div class="big" id="cell-count">—</div>
    <div class="sub" id="cell-sub"></div>
  </div>
  <div class="card">
    <div class="label">Pool</div>
    <div class="big">
      <span id="pool-warm">—</span><span class="small" id="pool-target"></span>
    </div>
    <div class="sub" id="pool-sub"></div>
  </div>
  <div class="card">
    <div class="label">Open talk sessions</div>
    <div class="big" id="session-count">—</div>
    <div class="sub">host-bridge</div>
  </div>
</div>

<h2>Cells</h2>
<table id="cells-table">
  <thead>
    <tr>
      <th>Name</th>
      <th>Status</th>
      <th>Harness</th>
      <th>Model</th>
      <th>Thinking</th>
      <th>First reply</th>
      <th>Well</th>
      <th>IP</th>
      <th>Age</th>
    </tr>
  </thead>
  <tbody id="cells-body">
    <tr class="empty"><td colspan="9">…</td></tr>
  </tbody>
</table>

<h2>Pool <span class="muted" style="text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 12px;" id="pool-headline"></span></h2>
<table id="pool-table">
  <thead>
    <tr>
      <th>Egg</th>
      <th>State</th>
      <th>Harness</th>
      <th>Model</th>
      <th>Status</th>
      <th>Age</th>
      <th>Claimed by</th>
    </tr>
  </thead>
  <tbody id="pool-body">
    <tr class="empty"><td colspan="7">…</td></tr>
  </tbody>
</table>

<h2>Substrate</h2>
<div class="daemons" id="daemons"></div>

<script>
  const $ = (id) => document.getElementById(id);

  function fmtAge(m) {
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  }

  function pill(label, klass) {
    const span = document.createElement("span");
    span.className = "pill pill-" + klass;
    span.textContent = label;
    return span;
  }

  function setText(id, val) { $(id).textContent = val; }

  async function refresh() {
    let s;
    try {
      const r = await fetch("/api/state");
      if (!r.ok) throw new Error("http " + r.status);
      s = await r.json();
    } catch (e) {
      setText("updated", "connection lost");
      $("updated").style.color = "#d65454";
      return;
    }
    $("updated").style.color = "";
    const now = new Date(s.ts);
    setText("updated", "updated " + now.toLocaleTimeString());

    // Top cards
    setText("cell-count", s.cells.length);
    const warmingCount = s.cells.filter(c => c.status === "warming").length;
    setText("cell-sub", warmingCount > 0 ? warmingCount + " warming" : "all alive");
    setText("pool-warm", s.pool.warm);
    setText("pool-target", "/" + s.pool.target_depth);
    setText(
      "egg-sub",
      "hot " + s.pool.hot + "/" + s.pool.target_hot + " · cold " + s.pool.cold,
    );
    setText("session-count", s.daemons.host_bridge.sessions);

    // Cells table
    const cellsBody = $("cells-body");
    cellsBody.innerHTML = "";
    if (s.cells.length === 0) {
      const tr = document.createElement("tr");
      tr.className = "empty";
      const td = document.createElement("td");
      td.colSpan = 9;
      td.textContent = "no live cells";
      tr.appendChild(td);
      cellsBody.appendChild(tr);
    } else {
      for (const c of s.cells) {
        const tr = document.createElement("tr");
        const nameTd = document.createElement("td");
        nameTd.innerHTML = '<code>' + c.name + '</code>';
        tr.appendChild(nameTd);
        const statTd = document.createElement("td");
        statTd.appendChild(pill(c.status, c.status));
        tr.appendChild(statTd);
        const harnessTd = document.createElement("td");
        harnessTd.className = "mono";
        harnessTd.textContent = (c as any).harness ?? "pi";
        tr.appendChild(harnessTd);
        const modelTd = document.createElement("td");
        modelTd.textContent = c.model;
        tr.appendChild(modelTd);
        const thinkTd = document.createElement("td");
        thinkTd.className = "mono muted";
        thinkTd.textContent = c.thinking;
        tr.appendChild(thinkTd);
        const ftTd = document.createElement("td");
        ftTd.className = "mono";
        if (c.first_token_ms !== null && c.first_token_ms !== undefined) {
          // Format: <5s green, 5-8s neutral, >8s warn (visual outlier flag)
          const ms = c.first_token_ms;
          const sec = (ms / 1000).toFixed(2);
          if (ms < 5000) ftTd.style.color = "var(--cells-dark)";
          else if (ms > 8000) ftTd.style.color = "#8a3333";
          ftTd.textContent = sec + "s";
        } else {
          ftTd.innerHTML = '<span class="muted">—</span>';
        }
        tr.appendChild(ftTd);
        const wellTd = document.createElement("td");
        if (c.well_status) wellTd.appendChild(pill(c.well_status, c.well_status));
        else wellTd.innerHTML = '<span class="muted">—</span>';
        tr.appendChild(wellTd);
        const ipTd = document.createElement("td");
        ipTd.className = "mono muted";
        ipTd.textContent = c.ip || "—";
        tr.appendChild(ipTd);
        const ageTd = document.createElement("td");
        ageTd.textContent = fmtAge(c.age_minutes);
        tr.appendChild(ageTd);
        cellsBody.appendChild(tr);
      }
    }

    // Eggs table
    const poolBody = $("pool-body");
    poolBody.innerHTML = "";
    if (s.pool.list.length === 0) {
      const tr = document.createElement("tr");
      tr.className = "empty";
      const td = document.createElement("td");
      td.colSpan = 7;
      td.textContent = "no members in pool";
      tr.appendChild(td);
      poolBody.appendChild(tr);
    } else {
      for (const e of s.pool.list) {
        const tr = document.createElement("tr");
        const idTd = document.createElement("td");
        idTd.innerHTML = '<code>' + e.well_name + '</code>';
        tr.appendChild(idTd);
        const stTd = document.createElement("td");
        // Show hot/cold for warm members (the user-facing tier), state otherwise.
        const stateLabel =
          e.state === "warm"
            ? (e.tier === 4 ? "hot" : e.tier === 2 ? "cold" : "warm")
            : e.state;
        stTd.appendChild(pill(stateLabel, stateLabel));
        tr.appendChild(stTd);
        const harnessTd = document.createElement("td");
        harnessTd.className = "mono";
        harnessTd.textContent = e.harness;
        tr.appendChild(harnessTd);
        const modelTd = document.createElement("td");
        modelTd.className = "mono muted";
        modelTd.textContent = e.model;
        tr.appendChild(modelTd);
        const tierTd = document.createElement("td");
        tierTd.className = "mono muted";
        // VM-level status: running (hot) vs hibernated (cold) vs other states.
        tierTd.textContent = e.tier === 4 ? "running" : e.tier === 2 ? "hibernated" : "—";
        tr.appendChild(tierTd);
        const ageTd = document.createElement("td");
        ageTd.textContent = fmtAge(e.age_minutes);
        tr.appendChild(ageTd);
        const claimedTd = document.createElement("td");
        if (e.claimed_by) {
          claimedTd.innerHTML = '<code>' + e.claimed_by + '</code>';
        } else {
          claimedTd.innerHTML = '<span class="muted">—</span>';
        }
        tr.appendChild(claimedTd);
        poolBody.appendChild(tr);
      }
    }
    setText("pool-headline", "  ·  hot " + s.pool.hot + " · cold " + s.pool.cold + " · claimed " + s.pool.claimed + " · hatched " + s.pool.live + (s.pool.culling ? " · culling " + s.pool.culling : ""));

    // Daemons
    const daemonsEl = $("daemons");
    daemonsEl.innerHTML = "";
    const welld = s.daemons.welld;
    const welldEl = document.createElement("div");
    welldEl.className = "daemon " + (welld.ok ? (welld.degraded ? "warn" : "ok") : "bad");
    welldEl.innerHTML =
      '<div class="name">welld<code>:7878</code></div>' +
      '<div class="right">' +
      (welld.ok
        ? "up " + (welld.uptime_minutes !== null ? fmtAge(welld.uptime_minutes) : "?") +
          (welld.vmnet_orphans > 0 ? " · " + welld.vmnet_orphans + " orphan leases" : "")
        : "down") +
      '</div>';
    daemonsEl.appendChild(welldEl);
    const hb = s.daemons.host_bridge;
    const hbEl = document.createElement("div");
    hbEl.className = "daemon " + (hb.ok ? "ok" : "bad");
    hbEl.innerHTML =
      '<div class="name">host-bridge<code>:7880</code></div>' +
      '<div class="right">' +
      (hb.ok ? hb.sessions + " session" + (hb.sessions === 1 ? "" : "s") : "down") +
      '</div>';
    daemonsEl.appendChild(hbEl);
  }

  refresh();
  setInterval(refresh, 4000);
</script>

</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────

// ── single-shot roll-call (used by cells-narrator) ────────────────────────
//
// POST /api/talk/<name>  Bearer ${CELLS_PROXY_SECRET}
//   body: { prompt: string, wake?: boolean }
//   200:  { answer: string, elapsed_ms: number }
//   401:  { error: "auth" }
//   404:  { error: "no cell" }
//   504:  { error: "timeout" }
//
// Connects to host-bridge's WebSocket as a regular talk client, sends one
// prompt, accumulates `text_delta` deltas, and returns them at `agent_end`.
// host-bridge owns the cell's pi --mode rpc subprocess and reuses sessions
// across calls — so the second roll-call to a given cell within the idle
// window is fast.
async function handleTalk(req: Request, name: string): Promise<Response> {
  // Auth.
  if (!CELLS_PROXY_SECRET) {
    return Response.json({ error: "server missing CELLS_PROXY_SECRET" }, { status: 500 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${CELLS_PROXY_SECRET}`) {
    return Response.json({ error: "auth" }, { status: 401 });
  }

  // Parse body.
  let prompt = "";
  let wake = false;
  try {
    const body = await req.json() as { prompt?: string; wake?: boolean };
    prompt = (body.prompt ?? "").trim();
    wake = !!body.wake;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (!prompt) return Response.json({ error: "empty prompt" }, { status: 400 });

  // Verify the cell exists; resolve its well name for the wake hop below.
  let cellWellName: string | null = null;
  try {
    const reg = JSON.parse(await readFile(join(homedir(), ".cells", "cells.json"), "utf8"));
    const found = (reg?.cells ?? []).find((c: any) => c.name === name);
    if (!found) return Response.json({ error: "no cell" }, { status: 404 });
    // Hatched cells: well name == egg-<hatched_from>. Non-hatched (rare in V1):
    // well name == cell name.
    cellWellName = found.hatched_from ? `egg-${found.hatched_from}` : name;
  } catch (e) {
    return Response.json({ error: "registry unreadable" }, { status: 500 });
  }

  const t0 = Date.now();

  // Wake-on-talk. host-bridge SSHs straight to the cell IP — it does NOT
  // route through welld's vhost-dispatch, so welld's auto-wake-on-touch
  // never fires. If the cell is hibernated, SSH would just time out with
  // `Host is down`. Touch welld first to wake the well.
  //
  // welld's /wake returns once lume's restore call returns, NOT once the
  // well has a usable IP — DHCP can take an extra second or two on a
  // cold-wake. host-bridge's session-create asks welld for `ip`, gets
  // `null`, and immediately fails the session (bridge_closed before we
  // even send the prompt). So after /wake, poll welld until the well
  // record carries a non-null ip. Idempotent on already-running wells:
  // poll #1 finds the ip and returns in ~10ms.
  if (wake && cellWellName) {
    try {
      const tok = (await readFile(join(homedir(), ".wells", "token"), "utf8")).trim();
      await fetch(`${WELL_API}/v1/wells/${encodeURIComponent(cellWellName)}/wake`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}` },
        signal: AbortSignal.timeout(20_000),
      }).catch(() => {});
      // Poll for IP + SSH-port reachability. welld reports an IP as soon
      // as it has one cached, but the well may be wedged ("alive_running"
      // with no actual network — a wells-team-known state). host-bridge's
      // SSH attempt fails fast on a wedged well ("Host is down") and the
      // talk turns into an SSH-retry slog. We probe TCP 22 directly so
      // we only proceed when SSH is truly reachable. Budget 15s.
      const pollDeadline = Date.now() + 15_000;
      while (Date.now() < pollDeadline) {
        try {
          const r = await fetch(`${WELL_API}/v1/wells/${encodeURIComponent(cellWellName)}`, {
            headers: { Authorization: `Bearer ${tok}` },
            signal: AbortSignal.timeout(2_000),
          });
          if (r.ok) {
            const d = await r.json() as any;
            if (d?.ip && (await tcpReachable(d.ip, 22, 1_500))) break;
          }
        } catch { /* transient — keep polling */ }
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch { /* token unreadable — skip */ }
  }

  // Connect to host-bridge's WS as a talk client. Same bearer auth that
  // `cells talk` uses; same protocol.
  return new Promise<Response>((res) => {
    let answer = "";
    let resolved = false;
    const finish = (response: Response) => { if (!resolved) { resolved = true; res(response); } };

    const wsUrl = `${HOST_BRIDGE_WS}?cell=${encodeURIComponent(name)}`;
    let ws: WebSocket;
    try {
      // Bun.WebSocket and standard WebSocket: pass headers via protocols arg
      // isn't supported, so we use `Bun.fetch`-style by setting Sec-WebSocket-Protocol.
      // host-bridge accepts the Authorization header directly though — using a
      // standard WebSocket with `headers` works in Bun's runtime.
      ws = new WebSocket(wsUrl, {
        // @ts-ignore — Bun-specific extension
        headers: { authorization: `Bearer ${CELLS_PROXY_SECRET}` },
      } as any);
    } catch (e: any) {
      return finish(Response.json({ error: `ws ctor failed: ${e?.message ?? e}` }, { status: 502 }));
    }

    // Cold-waking a pi cell from hibernation is the slow path: /wake (1-3s)
    // → SSH (up to 10s for a freshly-woken sshd) → pi handshake (1-2s) →
    // model turn (2-10s). Budget generously when wake was requested.
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      finish(Response.json({ error: "timeout", answer, elapsed_ms: Date.now() - t0 }, { status: 504 }));
    }, TALK_TIMEOUT_MS + (wake ? 25_000 : 0));

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "prompt", message: prompt, streamingBehavior: "steer" }));
    });

    ws.addEventListener("message", (e: any) => {
      let event: any;
      try { event = JSON.parse(typeof e.data === "string" ? e.data : String(e.data)); }
      catch { return; }

      if (event.type === "message_update") {
        const ev = event.assistantMessageEvent;
        if (ev?.type === "text_delta" && typeof ev.delta === "string") {
          answer += ev.delta;
        }
      } else if (event.type === "agent_end") {
        // Order matters: finish() before ws.close() because Bun's WebSocket
        // fires the close handler *synchronously* from ws.close(), which
        // would race finish() and finish_late with "closed early".
        clearTimeout(timeout);
        finish(Response.json({ answer: answer.trim(), elapsed_ms: Date.now() - t0 }));
        try { ws.close(); } catch {}
      } else if (event.type === "agent_error" || event.type === "error") {
        clearTimeout(timeout);
        finish(Response.json({ error: event.message ?? "agent error", elapsed_ms: Date.now() - t0 }, { status: 502 }));
        try { ws.close(); } catch {}
      }
    });

    ws.addEventListener("error", (e: any) => {
      clearTimeout(timeout);
      finish(Response.json({ error: `ws error: ${String(e?.message ?? e).slice(0, 200)}`, elapsed_ms: Date.now() - t0 }, { status: 502 }));
    });

    ws.addEventListener("close", () => {
      // If neither agent_end nor agent_error fired, close means the channel
      // dropped mid-stream. Return what we accumulated.
      clearTimeout(timeout);
      if (!resolved) {
        finish(answer
          ? Response.json({ answer: answer.trim(), elapsed_ms: Date.now() - t0, note: "closed early" })
          : Response.json({ error: "closed before answer", elapsed_ms: Date.now() - t0 }, { status: 502 }));
      }
    });
  });
}

const server = Bun.serve({
  port: PORT,
  // 0.0.0.0 so the narrator cell can hit us at http://192.168.64.1:7881
  // (the vmnet gateway from inside any cell VM). cloudflared still works —
  // its 127.0.0.1 origin path lands here too.
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, port: PORT });
    }
    if (url.pathname === "/api/state") {
      return Response.json(await buildState());
    }
    // POST /api/talk/<name>
    if (req.method === "POST" && url.pathname.startsWith("/api/talk/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/talk/".length));
      if (!name) return Response.json({ error: "missing cell name" }, { status: 400 });
      return await handleTalk(req, name);
    }
    if (url.pathname === "/" || url.pathname === "/dashboard") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`cells-dashboard listening on http://0.0.0.0:${server.port}/`);
console.log(`  GET  /                 dashboard HTML`);
console.log(`  GET  /api/state        JSON snapshot`);
console.log(`  POST /api/talk/<name>  single-shot roll-call (bearer-gated)`);
console.log(`  GET  /healthz          daemon liveness`);

// ── Wedge recovery loop ───────────────────────────────────────────────────
//
// Welld's watchdog probes each running well's SSH banner and surfaces a
// per-well `wedge: "ok" | "suspected" | "confirmed"` field on the well
// record (commit landing 2026-05-15 from wells team). Wedge="confirmed"
// fires after ~3 min of failed banner-reads + a diag bundle dump to
// ~/.wells/diag/wedge-<name>-<iso>/. Welld leaves recovery to us — it's
// a policy call (a wedged cell may be mid-conversation; recovering
// drops that state). We do the recovery here.
//
// Recovery is the simplest possible: POST /v1/wells/<n>/stop, then
// POST /v1/wells/<n>/start. ~5s, costs the cell's in-VM state. We only
// trigger on `confirmed` (3 min of confirmed unreachability) so we don't
// rescue cells that would have unwedged themselves.
//
// Pete's standing rule: don't let cells *ever* show as wedged in the
// dashboard. So the tick is aggressive — every 30s, matching welld's
// own probe cadence, so we react on the first confirmed event.
const WEDGE_TICK_MS = Number(process.env.CELLS_WEDGE_TICK_MS ?? 30_000);
const WEDGE_RECOVERY_COOLDOWN_MS = Number(process.env.CELLS_WEDGE_RECOVERY_COOLDOWN_MS ?? 5 * 60_000);
const WEDGE_MAX_ATTEMPTS = Number(process.env.CELLS_WEDGE_MAX_ATTEMPTS ?? 3);
// Per-well: last recovery timestamp + attempt count. Resets to {0, 0}
// when the well clears (wedge !== "confirmed").
const wedgeRecoveryState = new Map<string, { lastAttemptMs: number; attempts: number }>();

async function wedgeRecoveryTick(): Promise<void> {
  let tok: string;
  try {
    tok = (await readFile(join(homedir(), ".wells", "token"), "utf8")).trim();
  } catch { return; }

  let wells: any[];
  try {
    // /dashboard/data carries the wedge field; /v1/wells does not.
    const r = await fetch(`${WELL_API}/dashboard/data`, {
      headers: { Authorization: `Bearer ${tok}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return;
    const data = await r.json() as any;
    wells = data?.wells ?? [];
  } catch { return; }

  for (const w of wells) {
    const name = w?.name as string;
    if (!name) continue;
    const wedge = w?.wedge ?? "ok";
    if (wedge !== "confirmed") {
      // Clear state on recovery so a future re-wedge gets the full attempt budget.
      if (wedgeRecoveryState.has(name)) wedgeRecoveryState.delete(name);
      continue;
    }
    const now = Date.now();
    const st = wedgeRecoveryState.get(name) ?? { lastAttemptMs: 0, attempts: 0 };
    if (st.attempts >= WEDGE_MAX_ATTEMPTS) {
      // Gave up — leave it broken visibly. The diag bundle is on disk;
      // human will look at it.
      continue;
    }
    if (now - st.lastAttemptMs < WEDGE_RECOVERY_COOLDOWN_MS) continue;
    console.log(`[wedge-recovery] ${name}: confirmed, cycling (attempt ${st.attempts + 1}/${WEDGE_MAX_ATTEMPTS})`);
    try {
      const stopR = await fetch(`${WELL_API}/v1/wells/${encodeURIComponent(name)}/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}` },
        signal: AbortSignal.timeout(15_000),
      });
      const startR = await fetch(`${WELL_API}/v1/wells/${encodeURIComponent(name)}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}` },
        signal: AbortSignal.timeout(30_000),
      });
      console.log(`[wedge-recovery] ${name}: stop=${stopR.status} start=${startR.status}`);
    } catch (e: any) {
      console.error(`[wedge-recovery] ${name}: ${e?.message ?? e}`);
    }
    wedgeRecoveryState.set(name, { lastAttemptMs: now, attempts: st.attempts + 1 });
  }
}

setInterval(() => { wedgeRecoveryTick().catch((e) => console.error("[wedge-recovery] tick failed:", e)); }, WEDGE_TICK_MS);
console.log(`  wedge-recovery tick every ${WEDGE_TICK_MS / 1000}s (max ${WEDGE_MAX_ATTEMPTS} attempts, ${WEDGE_RECOVERY_COOLDOWN_MS / 60_000}min cooldown)`);
