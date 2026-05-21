/**
 * heartbeat-e2e.test.mjs — end-to-end test of the heartbeat → pulse pipeline.
 *
 * Runs a real heartbeat through the whole flow with the real components: a
 * cell's HEARTBEAT.md edit → the claude-code heartbeat-push hook → an HTTP
 * POST → an inbox file → pulse-core drain → save-schedule → fire → a wake
 * delivered to the target cell.
 *
 * Only the two HTTP endpoints are stand-ins, and each does exactly what the
 * real component does: the subscriptions proxy's /heartbeat-changed drops
 * <cell>-<ts>.md into the inbox; the bridge's /talk delivers a wake. The
 * hook and pulse-core (drain, cron eval, fire, render) are the real code.
 *
 *   node dna/specials/pulse/lib/heartbeat-e2e.test.mjs
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const HOOK = path.join(REPO, "dna/cells/base/bin/heartbeat-push.mjs");
const CLI = path.join(REPO, "dna/specials/pulse/bin/pulse-core.mjs");

let pass = 0;
let fail = 0;
const check = (label, cond) => {
  if (cond) pass++;
  else { fail++; console.log("  x " + label); }
};

// Always async — never spawnSync. The stand-in server shares this process's
// event loop and must stay responsive while a child process runs.
function run(label, cmd, args, { env, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: env ?? process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => { fail++; console.log(`  x ${label}: spawn error ${e.message}`); resolve(null); });
    p.on("close", (code) => {
      if (code !== 0) { fail++; console.log(`  x ${label}: exit ${code} — ${err.trim().slice(0, 200)}`); resolve(null); }
      else resolve(out);
    });
    if (input !== undefined) p.stdin.write(input);
    p.stdin.end();
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-e2e-"));
const cellRoot = path.join(tmp, "cell");
const runtimeDir = path.join(tmp, "pulse-rt");
const stateDir = path.join(tmp, "pulse-state");
const inboxDir = path.join(runtimeDir, "pulse-inbox");
fs.mkdirSync(cellRoot, { recursive: true });
fs.mkdirSync(inboxDir, { recursive: true });

const SECRET = "e2e-test-secret";
const CELL = os.hostname() || "unknown"; // the hook derives the cell name from hostname
const delivered = []; // wakes the bridge stand-in receives

// Stand-in for the two HTTP endpoints pulse depends on.
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if ((req.headers.authorization || "") !== `Bearer ${SECRET}`) {
      res.writeHead(401); res.end("bad bearer"); return;
    }
    let payload = {};
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end("bad json"); return; }
    if (req.url === "/heartbeat-changed") {
      // proxy handlePulseProxy: drop <cell>-<ts>.md into the inbox
      const tsMs = Date.parse(payload.ts) || Date.now();
      fs.writeFileSync(path.join(inboxDir, `${payload.cell}-${tsMs}.md`), payload.content ?? "");
      res.writeHead(200); res.end("ok");
    } else if (req.url === "/talk") {
      // bridge /talk: deliver a wake message to the cell
      delivered.push({ cell: payload.cell, message: payload.message });
      res.writeHead(200); res.end("ok");
    } else {
      res.writeHead(404); res.end("nope");
    }
  });
});

try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1 — a cell writes its HEARTBEAT.md
  const heartbeat = "# Heartbeat\n\n- every minute — ping: refresh the dataset.\n";
  fs.writeFileSync(path.join(cellRoot, "HEARTBEAT.md"), heartbeat);

  // 2 — the heartbeat-push hook fires (SessionStart) and POSTs to the proxy
  await run("hook", "node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart" }),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cellRoot,
      CELLS_PROXY_SECRET: SECRET,
      PULSE_HEARTBEAT_URL: `${base}/heartbeat-changed`,
    },
  });
  const inboxFiles = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".md"));
  check("hook -> proxy -> inbox: one file landed", inboxFiles.length === 1);

  const pulseEnv = {
    ...process.env,
    PULSE_RUNTIME_DIR: runtimeDir,
    PULSE_STATE_DIR: stateDir,
    CELLS_BRIDGE_URL: base,
    CELLS_PROXY_SECRET: SECRET,
  };

  // 3 — pulse drains the inbox
  const drained = JSON.parse((await run("drain", "node", [CLI, "drain"], { env: pulseEnv })) || "[]");
  check("drain: surfaces the pushed heartbeat", drained.length === 1 && drained[0] && drained[0].cell === CELL);
  check("drain: content survived the round-trip", drained[0] && drained[0].content === heartbeat);

  // 4 — parse the prose into a schedule (the test stands in for the LLM here)
  //     and save it. "every minute" -> "* * * * *", so it is due right now.
  const saveOut = await run("save-schedule", "node", [CLI, "save-schedule"], {
    env: pulseEnv,
    input: JSON.stringify({
      cell: CELL,
      items: [{ cron: "* * * * *", message: "refresh the dataset" }],
      sourcePath: drained[0] ? drained[0].path : undefined,
    }),
  });
  check("save-schedule: ok", !!saveOut && JSON.parse(saveOut).ok === true);

  // 5 — fire: the every-minute schedule is due, so pulse wakes the cell
  const fireOut = JSON.parse((await run("fire", "node", [CLI, "fire"], { env: pulseEnv })) || "{}");
  check("fire: one wake fired ok", fireOut.count === 1 && fireOut.fires && fireOut.fires[0] && fireOut.fires[0].result === "ok");
  check("fire -> bridge: wake delivered to the cell", delivered.length === 1 && delivered[0] && delivered[0].cell === CELL);
  check("fire -> bridge: wake carried the schedule message",
    delivered[0] && delivered[0].message === "refresh the dataset");

  // 6 — render the digest
  await run("render", "node", [CLI, "render"], { env: pulseEnv });
  const digest = path.join(stateDir, "heartbeats.md");
  check("render: digest written naming the cell",
    fs.existsSync(digest) && fs.readFileSync(digest, "utf-8").includes(CELL));
} catch (e) {
  fail++;
  console.log("  x unexpected throw: " + (e && e.stack ? e.stack : e));
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`heartbeat-e2e: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
