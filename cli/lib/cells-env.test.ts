import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CELLS_ENV_SH_BODY } from "./cells-env.ts";

describe("CELLS_ENV_SH_BODY — rendered shim", () => {
  test("template escaping is resolved (real $, no literal backslash-dollar in the secret block)", () => {
    // If `\$` ever leaked unresolved, this exact substring wouldn't be present.
    expect(CELLS_ENV_SH_BODY).toContain('export "$_sk=$(cat "$_sf")"');
    expect(CELLS_ENV_SH_BODY).toContain("for _sf in /etc/cells.secrets.d/*");
  });

  test("disables Claude Code's auto-updater (it bricks claude-code births — bumps the baked native install into a broken npm global)", () => {
    expect(CELLS_ENV_SH_BODY).toContain("export DISABLE_AUTOUPDATER=1");
  });

  test("app-secret block is sourced BEFORE the proxy-secret re-export (collision guarantee)", () => {
    const appIdx = CELLS_ENV_SH_BODY.indexOf("/etc/cells.secrets.d");
    const proxyIdx = CELLS_ENV_SH_BODY.indexOf("ANTHROPIC_OAUTH_TOKEN");
    expect(appIdx).toBeGreaterThan(-1);
    expect(proxyIdx).toBeGreaterThan(-1);
    expect(appIdx).toBeLessThan(proxyIdx);
  });

  // Behavioral: extract the app-secret block, point it at a temp dir, run it
  // under bash, and confirm a secret file actually becomes an exported env var
  // — with no expansion of shell metacharacters in the value.
  test("the secret block exports file contents as env vars, values taken literally", async () => {
    const m = CELLS_ENV_SH_BODY.match(/if \[ -d \/etc\/cells\.secrets\.d \]; then[\s\S]*?\nfi/);
    expect(m).not.toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "cells-secd-"));
    try {
      writeFileSync(join(dir, "CONVEX_DEPLOY_KEY"), "sk-abc123XYZ"); // no trailing newline
      writeFileSync(join(dir, "WEIRD"), 'has $pecial `chars` & "quotes" and spaces');
      const block = m![0].replaceAll("/etc/cells.secrets.d", dir);
      const script = `${block}\nprintf 'A=[%s]\\n' "$CONVEX_DEPLOY_KEY"\nprintf 'B=[%s]\\n' "$WEIRD"\nprintf 'LEAK=[%s]\\n' "${"$"}{_sf-unset}"`;
      const proc = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out).toContain("A=[sk-abc123XYZ]");
      expect(out).toContain('B=[has $pecial `chars` & "quotes" and spaces]');
      expect(out).toContain("LEAK=[unset]"); // temp vars unset, no leakage
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing secrets dir is a no-op (no error)", async () => {
    const m = CELLS_ENV_SH_BODY.match(/if \[ -d \/etc\/cells\.secrets\.d \]; then[\s\S]*?\nfi/);
    const block = m![0].replaceAll("/etc/cells.secrets.d", "/nonexistent/cells-secd-xyz");
    const proc = Bun.spawn(["bash", "-c", `set -e\n${block}\necho OK`], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(out).toContain("OK");
  });
});
