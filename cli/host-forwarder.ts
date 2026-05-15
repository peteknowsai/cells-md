#!/usr/bin/env bun
// host-forwarder for the cells dashboard cell.
//
// cloudflared-under-launchd can't reach the vmnet IP directly — macOS gates
// local-network access for LaunchAgents (same workaround the wells team uses
// in wells/scripts/host-forwarder.ts). Loopback is always reachable, so
// cloudflared connects here and we hop to the cell.
//
// Forwards:
//   127.0.0.1:13001  →  <cells-narrator-IP>:3000   (Next.js)
//   127.0.0.1:13211  →  <cells-narrator-IP>:3210   (Convex backend)
//
// The cell's IP is read from welld (/v1/wells/<egg>) at startup and re-
// resolved if the upstream connection fails (cell may have been recreated
// at a different IP). If welld is unreachable, we fall back to a stale
// cached IP and log noisily.

import { createServer, connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const CELL_NAME = process.env.CELLS_NARRATOR_CELL ?? "cells-narrator";
const WELL_API = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";

function wellsToken(): string {
  try { return readFileSync(join(homedir(), ".wells", "token"), "utf8").trim(); } catch { return ""; }
}

async function resolveCellIp(): Promise<string | null> {
  try {
    const reg = JSON.parse(readFileSync(join(homedir(), ".cells", "cells.json"), "utf8"));
    const cell = (reg?.cells ?? []).find((c: any) => c.name === CELL_NAME);
    if (!cell?.hatched_from) {
      console.error(`[cells-host-forwarder] no cell '${CELL_NAME}' in registry`);
      return null;
    }
    const wellName = `egg-${cell.hatched_from}`;
    const token = wellsToken();
    const r = await fetch(`${WELL_API}/v1/wells/${encodeURIComponent(wellName)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!r.ok) {
      console.error(`[cells-host-forwarder] welld ${wellName} → ${r.status}`);
      return null;
    }
    const data = await r.json() as any;
    return data?.ip ?? null;
  } catch (e: any) {
    console.error(`[cells-host-forwarder] resolve failed: ${e?.message ?? e}`);
    return null;
  }
}

// Cache the IP across requests; refresh on connection failure.
let cachedIp: string | null = null;

async function getIp(force = false): Promise<string | null> {
  if (cachedIp && !force) return cachedIp;
  const ip = await resolveCellIp();
  if (ip) {
    if (cachedIp && cachedIp !== ip) {
      console.log(`[cells-host-forwarder] IP changed: ${cachedIp} → ${ip}`);
    } else if (!cachedIp) {
      console.log(`[cells-host-forwarder] resolved ${CELL_NAME} → ${ip}`);
    }
    cachedIp = ip;
  }
  return cachedIp;
}

type Forward = { listen: number; remote_port: number; label: string };

const FORWARDS: Forward[] = [
  { listen: 13001, remote_port: 3000, label: "Next.js" },
  { listen: 13211, remote_port: 3210, label: "Convex" },
];

// Initial resolve so cachedIp is set before the first connection.
await getIp();

for (const { listen, remote_port, label } of FORWARDS) {
  const server = createServer((client) => {
    // Use the cached IP directly — match wells's synchronous pattern. Async
    // resolve was racing with the client socket's first read.
    const ip = cachedIp;
    if (!ip) {
      console.error(`[cells-host-forwarder] ${listen}: no IP cached for ${CELL_NAME}`);
      client.destroy();
      return;
    }
    const upstream = connect(remote_port, ip);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", (e) => {
      console.error(`[cells-host-forwarder] ${listen} → ${ip}:${remote_port} ${e.message}`);
      // If we got ECONNREFUSED/EHOSTUNREACH, the cell may have been recreated
      // at a different IP. Re-resolve so the next connection works.
      if ((e as any).code === "ECONNREFUSED" || (e as any).code === "EHOSTUNREACH" || (e as any).code === "ETIMEDOUT") {
        getIp(true).catch(() => {});
      }
      client.destroy();
    });
  });
  server.listen(listen, "127.0.0.1", () => {
    console.log(`[cells-host-forwarder] 127.0.0.1:${listen} → ${CELL_NAME}:${remote_port} (${label})`);
  });
}

// Re-resolve periodically — the cell's IP changes if it's recreated.
setInterval(() => { getIp(true).catch(() => {}); }, 60_000);
