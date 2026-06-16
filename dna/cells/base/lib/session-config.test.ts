import { describe, expect, test } from "bun:test";
import {
  SESSION_CONFIG_DIR,
  ROLES_DIR,
  isSessionHarness,
  sessionConfigPath,
  rolePath,
  validateModelSpec,
  parseSessionConfig,
  effectiveHarness,
  effectiveRole,
} from "./session-config";

describe("isSessionHarness", () => {
  test("accepts the uniform trio", () => {
    expect(isSessionHarness("pi")).toBe(true);
    expect(isSessionHarness("claude-code")).toBe(true);
    expect(isSessionHarness("codex")).toBe(true);
  });
  test("rejects hermes (no durable named-session primitive) and junk", () => {
    expect(isSessionHarness("hermes")).toBe(false);
    expect(isSessionHarness("")).toBe(false);
    expect(isSessionHarness(undefined)).toBe(false);
    expect(isSessionHarness("PI")).toBe(false);
  });
});

describe("sessionConfigPath", () => {
  test("resolves a valid name under the config dir", () => {
    expect(sessionConfigPath("staff")).toBe(`${SESSION_CONFIG_DIR}/staff.json`);
    expect(sessionConfigPath("buyer")).toBe(`${SESSION_CONFIG_DIR}/buyer.json`);
  });
  test("rejects traversal / invalid names", () => {
    for (const bad of ["../escape", "a/b", "Staff", "", "has space", "a".repeat(40), "a;b", "."]) {
      expect(sessionConfigPath(bad)).toBeNull();
    }
  });
});

describe("rolePath", () => {
  test("resolves a valid role under the roles dir", () => {
    expect(rolePath("staff")).toBe(`${ROLES_DIR}/staff.md`);
  });
  test("rejects traversal / invalid names", () => {
    for (const bad of ["../../etc/passwd", "a/b", "", "Bad"]) {
      expect(rolePath(bad)).toBeNull();
    }
  });
});

describe("validateModelSpec", () => {
  test("accepts real provider/model[:effort] specs", () => {
    expect(validateModelSpec("anthropic/opus-4-8:medium")).toBe("anthropic/opus-4-8:medium");
    expect(validateModelSpec("gpt-5.5:low")).toBe("gpt-5.5:low");
    expect(validateModelSpec("claude-code:anthropic/opus-4-8:xhigh")).toBe("claude-code:anthropic/opus-4-8:xhigh");
  });
  test("rejects shell-injection / junk", () => {
    for (const bad of ["", "opus; rm -rf /", "model with space", "$(whoami)", "a`b`", "-flag", "a".repeat(90)]) {
      expect(validateModelSpec(bad)).toBeNull();
    }
  });
});

describe("parseSessionConfig", () => {
  test("full valid config passes through", () => {
    expect(parseSessionConfig({ harness: "claude-code", model: "anthropic/opus-4-8:medium", role: "staff" }))
      .toEqual({ harness: "claude-code", model: "anthropic/opus-4-8:medium", role: "staff" });
  });
  test("drops invalid fields rather than throwing (degrade to cell default)", () => {
    // unknown harness, junk model, escaping role → all dropped, {} returned
    expect(parseSessionConfig({ harness: "hermes", model: "a b", role: "../x" })).toEqual({});
    expect(parseSessionConfig({ harness: "pi", model: "bad;tok", role: "ok" })).toEqual({ harness: "pi", role: "ok" });
  });
  test("non-objects → {}", () => {
    expect(parseSessionConfig(null)).toEqual({});
    expect(parseSessionConfig("string")).toEqual({});
    expect(parseSessionConfig(["array"])).toEqual({});
    expect(parseSessionConfig(42)).toEqual({});
  });
});

describe("effectiveHarness", () => {
  test("config override wins; absent falls to cell default", () => {
    expect(effectiveHarness({ harness: "claude-code" }, "pi")).toBe("claude-code");
    expect(effectiveHarness({}, "pi")).toBe("pi");
    expect(effectiveHarness(null, "codex")).toBe("codex");
  });
});

describe("effectiveRole", () => {
  test("config override wins; absent falls to the session name", () => {
    expect(effectiveRole({ role: "operator" }, "staff")).toBe("operator");
    expect(effectiveRole({}, "staff")).toBe("staff");
    expect(effectiveRole(null, "buyer")).toBe("buyer");
  });
});
