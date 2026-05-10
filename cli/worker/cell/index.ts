/**
 * cells-front-<cell> — per-cell twin (v2).
 *
 * One Worker per cell, named at birth (cells-front-bob, cells-front-pete, …).
 *
 * Routes:
 *   POST /inbox/append — receive Slack events from the Slack Worker.
 *                        Forwarded into the per-cell Durable Object,
 *                        which holds a persistent outbound WebSocket
 *                        to the well at wss://${WELL_HOST}/agent.
 *                        That WS is the bidirectional bridge for
 *                        prompts (down) and pi RPC events (up).
 *
 *   GET  /debug         — dump current DO state (ws status, active turn).
 *
 * Pi runs in --mode rpc inside the well, supervised by site/server.ts.
 * The DO renders pi's event stream into Slack messages by
 * chat.postMessage on agent_start and chat.update as deltas arrive.
 * No slack_post tool needed.
 */

export { CellAgent } from "./cell-agent";

export interface Env {
  CELL_NAME: string;
  WELL_HOST: string;
  CELL_AGENT: DurableObjectNamespace;
  CHANNELS: KVNamespace;
  CELLS_PROXY_SECRET: string;
}

function doStub(env: Env): DurableObjectStub {
  return env.CELL_AGENT.get(env.CELL_AGENT.idFromName(env.CELL_NAME));
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${env.CELLS_PROXY_SECRET}`) {
      return new Response("unauthorized", { status: 401 });
    }

    if (req.method === "POST" && url.pathname === "/inbox/append") {
      const bodyText = await req.text();
      // Forward into the DO, which owns the WebSocket to the well and
      // the per-turn Slack message lifecycle.
      const r = await doStub(env).fetch("https://do/append", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
      });
      return new Response(null, { status: r.ok ? 202 : r.status });
    }

    if (req.method === "GET" && url.pathname === "/debug") {
      return doStub(env).fetch("https://do/debug");
    }

    return new Response("not found", { status: 404 });
  },
};
