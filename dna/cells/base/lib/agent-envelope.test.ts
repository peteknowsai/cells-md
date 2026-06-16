/**
 * agent-envelope — the session field (named durable sessions). The rest of the
 * envelope (ulid, target, ttl) is exercised through the talk path; these pin
 * the session passthrough that routes a turn to a named pool session.
 */

import { describe, expect, test } from "bun:test";
import { makeOutgoing, validateEnvelope } from "./agent-envelope";

describe("envelope session field", () => {
  test("makeOutgoing carries a named session", () => {
    const env = makeOutgoing({ from: "a", to: "b", text: "hi", session: "buyer" });
    expect(env.session).toBe("buyer");
  });
  test("makeOutgoing omits session when absent (not a literal undefined key)", () => {
    const env = makeOutgoing({ from: "a", to: "b", text: "hi" });
    expect("session" in env).toBe(false);
  });
  test("validateEnvelope passes a non-empty session through", () => {
    const r = validateEnvelope({ kind: "agent", from: "a", to: "b", corr_id: "X", text: "hi", session: "staff" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.session).toBe("staff");
  });
  test("validateEnvelope drops an empty/non-string session", () => {
    for (const bad of ["", 42, null]) {
      const r = validateEnvelope({ kind: "agent", from: "a", to: "b", corr_id: "X", text: "hi", session: bad });
      expect(r.ok).toBe(true);
      if (r.ok) expect("session" in r.env).toBe(false);
    }
  });
});
