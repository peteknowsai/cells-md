import { describe, expect, test } from "bun:test";
import {
  SECRETS_DIR,
  isValidSecretKey,
  validateSecretKey,
  RESERVED_SECRET_KEYS,
  parseSecretArgs,
  buildSecretSetScript,
  buildSecretRmScript,
  buildSecretListScript,
  parseSecretListOutput,
} from "./secret-cli.ts";

describe("isValidSecretKey", () => {
  test("accepts POSIX env-var names", () => {
    expect(isValidSecretKey("CONVEX_DEPLOY_KEY")).toBe(true);
    expect(isValidSecretKey("_x")).toBe(true);
    expect(isValidSecretKey("A1")).toBe(true);
    expect(isValidSecretKey("a")).toBe(true);
  });
  test("rejects leading digit, empty, and metacharacters", () => {
    expect(isValidSecretKey("")).toBe(false);
    expect(isValidSecretKey("1ABC")).toBe(false);
    expect(isValidSecretKey("FOO-BAR")).toBe(false);
    expect(isValidSecretKey("FOO BAR")).toBe(false);
    expect(isValidSecretKey("FOO=BAR")).toBe(false);
    expect(isValidSecretKey("a.b")).toBe(false);
  });
  test("rejects path-traversal / slashes (key is a filename)", () => {
    expect(isValidSecretKey("../etc/passwd")).toBe(false);
    expect(isValidSecretKey("a/b")).toBe(false);
    expect(isValidSecretKey("..")).toBe(false);
  });
  test("rejects over-long keys", () => {
    expect(isValidSecretKey("A".repeat(128))).toBe(true);
    expect(isValidSecretKey("A".repeat(129))).toBe(false);
  });
});

describe("validateSecretKey", () => {
  test("rejects reserved execution/identity/auth names", () => {
    for (const k of ["PATH", "LD_PRELOAD", "CELL_NAME", "CELLS_PROXY_SECRET", "OPENAI_CODEX_API_KEY", "HOME"]) {
      expect(RESERVED_SECRET_KEYS.has(k)).toBe(true);
      const r = validateSecretKey(k);
      expect(r.ok).toBe(false);
    }
  });
  test("accepts an ordinary app-secret name", () => {
    expect(validateSecretKey("CONVEX_DEPLOY_KEY")).toEqual({ ok: true });
    expect(validateSecretKey("STRIPE_SK")).toEqual({ ok: true });
  });
  test("malformed key reports a format reason", () => {
    const r = validateSecretKey("bad key");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/must match/);
  });
});

describe("parseSecretArgs — set", () => {
  test("single cell + key, default auto source", () => {
    expect(parseSecretArgs(["set", "adv1", "CONVEX_DEPLOY_KEY"])).toEqual({
      action: "set",
      cells: ["adv1"],
      key: "CONVEX_DEPLOY_KEY",
      source: { kind: "auto" },
    });
  });
  test("comma-list of cells → N cells", () => {
    const r = parseSecretArgs(["set", "adv1,adv2, spec-water", "KEY", "--from-env", "CONVEX_DEPLOY_KEY"]);
    expect(r).toEqual({
      action: "set",
      cells: ["adv1", "adv2", "spec-water"],
      key: "KEY",
      source: { kind: "env", name: "CONVEX_DEPLOY_KEY" },
    });
  });
  test("--from-file with = form", () => {
    const r = parseSecretArgs(["set", "c", "K", "--from-file=/tmp/k"]);
    expect(r).toEqual({ action: "set", cells: ["c"], key: "K", source: { kind: "file", path: "/tmp/k" } });
  });
  test("--stdin source", () => {
    const r = parseSecretArgs(["set", "c", "K", "--stdin"]);
    expect(r).toEqual({ action: "set", cells: ["c"], key: "K", source: { kind: "stdin" } });
  });
  test("flags before positionals still parse", () => {
    const r = parseSecretArgs(["set", "--from-env", "V", "c", "K"]);
    expect(r).toEqual({ action: "set", cells: ["c"], key: "K", source: { kind: "env", name: "V" } });
  });
  test("rejects inline KEY=VALUE footgun", () => {
    const r = parseSecretArgs(["set", "c", "K=secret"]);
    expect(r.action).toBe("usage");
    if (r.action === "usage") expect(r.error).toMatch(/never as KEY=VALUE/);
  });
  test("rejects reserved key", () => {
    const r = parseSecretArgs(["set", "c", "PATH", "--from-env", "V"]);
    expect(r.action).toBe("usage");
    if (r.action === "usage") expect(r.error).toMatch(/reserved/);
  });
  test("missing key → usage", () => {
    expect(parseSecretArgs(["set", "c"]).action).toBe("usage");
  });
  test("missing cell → usage", () => {
    expect(parseSecretArgs(["set"]).action).toBe("usage");
  });
});

describe("parseSecretArgs — list / rm", () => {
  test("list one cell", () => {
    expect(parseSecretArgs(["list", "adv1"])).toEqual({ action: "list", cells: ["adv1"] });
  });
  test("list rejects a value-source flag", () => {
    expect(parseSecretArgs(["list", "adv1", "--stdin"]).action).toBe("usage");
  });
  test("rm cell + key", () => {
    expect(parseSecretArgs(["rm", "adv1", "STRIPE_SK"])).toEqual({
      action: "rm",
      cells: ["adv1"],
      key: "STRIPE_SK",
    });
  });
  test("rm validates the key", () => {
    expect(parseSecretArgs(["rm", "c", "bad key"]).action).toBe("usage");
  });
  test("unknown action → usage with error", () => {
    const r = parseSecretArgs(["frobnicate", "c"]);
    expect(r.action).toBe("usage");
    if (r.action === "usage") expect(r.error).toMatch(/unknown secret action/);
  });
  test("no action → bare usage (no error)", () => {
    expect(parseSecretArgs([])).toEqual({ action: "usage" });
  });
});

describe("script builders", () => {
  test("set script reads stdin, writes 0600 under the secrets dir, never echoes value", () => {
    const s = buildSecretSetScript("CONVEX_DEPLOY_KEY");
    expect(s).toContain(`${SECRETS_DIR}/CONVEX_DEPLOY_KEY`);
    expect(s).toContain("v=$(cat)"); // value from stdin
    expect(s).toContain("chmod 600");
    expect(s).toContain("install -d -m 700");
    expect(s).toContain("echo SET");
    // The value never appears literally — only the keyed file path + a stdin read.
    expect(s).not.toContain("VALUE");
  });
  test("rm script removes the keyed file and reports REMOVED/ABSENT", () => {
    const s = buildSecretRmScript("STRIPE_SK");
    expect(s).toContain(`rm -f ${SECRETS_DIR}/STRIPE_SK`);
    expect(s).toContain("REMOVED");
    expect(s).toContain("ABSENT");
  });
  test("list script lists names only, tolerates a missing dir", () => {
    const s = buildSecretListScript();
    expect(s).toContain(`ls -1 ${SECRETS_DIR}`);
    expect(s).toContain("|| true");
  });
});

describe("parseSecretListOutput", () => {
  test("trims and drops blank lines", () => {
    expect(parseSecretListOutput("CONVEX_DEPLOY_KEY\nSTRIPE_SK\n\n  \n")).toEqual([
      "CONVEX_DEPLOY_KEY",
      "STRIPE_SK",
    ]);
  });
  test("empty output → no keys", () => {
    expect(parseSecretListOutput("")).toEqual([]);
    expect(parseSecretListOutput("\n")).toEqual([]);
  });
});
