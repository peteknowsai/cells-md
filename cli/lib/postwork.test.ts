import { test, expect } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizePostwork, type PostworkDoc } from "./postwork";

// ── summarizePostwork (pure) ───────────────────────────────────────────

test("pending while the chain is still running (no completed_at)", () => {
  const doc: PostworkDoc = {
    started_at: "T0", completed_at: null, steps: { site_service: { status: "ok" } },
  };
  const s = summarizePostwork(doc);
  expect(s.status).toBe("pending");
  expect(s.failed_steps).toEqual([]);
  expect(s.started_at).toBe("T0");
  expect(s.completed_at).toBeNull();
});

test("ok when completed with every step ok", () => {
  const doc: PostworkDoc = {
    started_at: "T0", completed_at: "T1",
    steps: { site_service: { status: "ok" }, worker_deploy: { status: "ok" } },
  };
  expect(summarizePostwork(doc).status).toBe("ok");
});

test("failed when completed with a failed step, naming every failure", () => {
  const doc: PostworkDoc = {
    started_at: "T0", completed_at: "T1",
    steps: {
      site_service: { status: "ok" },
      worker_deploy: { status: "failed", detail: "wrangler exit 1" },
      channels_bind: { status: "failed" },
    },
  };
  const s = summarizePostwork(doc);
  expect(s.status).toBe("failed");
  expect(s.failed_steps.sort()).toEqual(["channels_bind", "worker_deploy"]);
});

test("ok when completed with zero steps recorded", () => {
  expect(summarizePostwork({ completed_at: "T1", steps: {} }).status).toBe("ok");
});

test("a failed step but no completed_at is still pending (chain not done)", () => {
  // The chain hasn't finished, so even with a failure so far the rollup
  // is pending — completed_at is the done signal.
  const doc: PostworkDoc = { started_at: "T0", steps: { site_service: { status: "failed" } } };
  expect(summarizePostwork(doc).status).toBe("pending");
});

test("missing started_at/completed_at default to null", () => {
  const s = summarizePostwork({});
  expect(s.started_at).toBeNull();
  expect(s.completed_at).toBeNull();
  expect(s.status).toBe("pending");
});

// ── contract: real birth-postwork.sh → summarizePostwork ───────────────
//
// Spawns the actual script with every external command stubbed — a temp
// CELLS_REPO of exit-0/1 stub scripts plus a stub `well` on PATH — writing
// into a temp HOME. Round-trips the produced JSON through the reader to
// catch drift between the bash writer's jq keys and the TS reader's
// expectations (the whole point of the contract). If someone renames a
// step or a JSON field on either side, one of these assertions fails.

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "birth-postwork.sh");
const STUB_SCRIPTS = [
  "register-site-service.sh", "deploy-cell-worker.sh",
  "bind-cell-channels.sh", "update-cell-harness.sh",
];
const ALL_STEPS = [
  "site_service", "well_url_public", "worker_deploy",
  "channels_bind", "harness_update", "checkpoint",
];

function runPostwork(opts: { failScript?: string } = {}): PostworkDoc {
  const home = mkdtempSync(join(tmpdir(), "pw-home-"));
  const repo = mkdtempSync(join(tmpdir(), "pw-repo-"));
  const bin = mkdtempSync(join(tmpdir(), "pw-bin-"));
  try {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    for (const s of STUB_SCRIPTS) {
      const code = s === opts.failScript ? 1 : 0;
      const p = join(repo, "scripts", s);
      writeFileSync(p, `#!/usr/bin/env bash\nexit ${code}\n`);
      chmodSync(p, 0o755);
    }
    // Stub `well` — used by well_url_public and checkpoint.
    const wellPath = join(bin, "well");
    writeFileSync(wellPath, `#!/usr/bin/env bash\nexit 0\n`);
    chmodSync(wellPath, 0o755);

    Bun.spawnSync(["bash", SCRIPT, "testcell", "egg-test", "{}"], {
      env: { ...process.env, HOME: home, CELLS_REPO: repo, PATH: `${bin}:${process.env.PATH}` },
    });

    const file = join(home, ".cells", "postwork", "testcell.json");
    expect(existsSync(file)).toBe(true);
    return JSON.parse(readFileSync(file, "utf8")) as PostworkDoc;
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
}

test("contract: a fully-successful run reads back as ok with all six steps", () => {
  const doc = runPostwork();
  const s = summarizePostwork(doc);
  expect(s.status).toBe("ok");
  expect(s.failed_steps).toEqual([]);
  expect(s.completed_at).not.toBeNull();
  expect(s.started_at).not.toBeNull();
  // The writer's step keys are exactly what the reader/consumers expect.
  expect(Object.keys(doc.steps ?? {}).sort()).toEqual([...ALL_STEPS].sort());
});

test("contract: a failed step reads back as failed and is named", () => {
  const doc = runPostwork({ failScript: "deploy-cell-worker.sh" });
  const s = summarizePostwork(doc);
  expect(s.status).toBe("failed");
  expect(s.failed_steps).toContain("worker_deploy");
  // Other steps still succeeded — the chain doesn't abort on one failure.
  expect(s.failed_steps).not.toContain("site_service");
});
