// Tests pin the probe parsing + classification against the real failure
// modes from the 2026-06-09/10 incident: mother's def-without-unit drift,
// her OOM-killed supervisor, bob's 18-day clock skew, and the healthy
// baselines (pulse, delta-market) that must stay green.

import { describe, expect, test } from "bun:test";
import { CLOCK_SKEW_WARN_S, classifyCellTransport, parseGuestProbe } from "./fleet-probe";

const MAC_EPOCH = 1_770_000_000;

function guest(over: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(), ...over };
}
function base() {
  return { unit_active: "active", unit_present: true, health: "ok", oom_48h: 0, epoch: MAC_EPOCH };
}

describe("parseGuestProbe", () => {
  test("finds the CELLPROBE line amid shell noise", () => {
    const raw = [
      "Warning: Permanently added '192.168.64.203' (ED25519) to the list of known hosts.",
      "motd junk",
      'CELLPROBE {"unit_active":"active","unit_present":true,"health":"ok","oom_48h":2,"epoch":123}',
    ].join("\n");
    expect(parseGuestProbe(raw)).toEqual({
      unit_active: "active",
      unit_present: true,
      health: "ok",
      oom_48h: 2,
      epoch: 123,
    });
  });
  test("no CELLPROBE line / bad JSON → null", () => {
    expect(parseGuestProbe("nothing here")).toBeNull();
    expect(parseGuestProbe("CELLPROBE {broken")).toBeNull();
  });
  test("missing fields degrade to defaults", () => {
    const p = parseGuestProbe('CELLPROBE {"unit_active":"active"}');
    expect(p).toEqual({ unit_active: "active", unit_present: false, health: "", oom_48h: 0, epoch: 0 });
  });
});

describe("classifyCellTransport", () => {
  test("healthy running cell (pulse baseline) → ok", () => {
    const v = classifyCellTransport({ defPresent: true, power: "running", guest: guest(), macEpochS: MAC_EPOCH });
    expect(v).toEqual({ status: "ok", reasons: [] });
  });

  test("no welld definition → fail even while hibernated", () => {
    const v = classifyCellTransport({ defPresent: false, power: "hibernated", guest: null, macEpochS: MAC_EPOCH });
    expect(v.status).toBe("fail");
    expect(v.reasons[0]).toContain("no `site` service definition");
  });

  test("mother-class drift: def present, unit missing in guest → fail", () => {
    const v = classifyCellTransport({
      defPresent: true,
      power: "running",
      guest: guest({ unit_present: false, unit_active: "", health: "" }),
      macEpochS: MAC_EPOCH,
    });
    expect(v.status).toBe("fail");
    expect(v.reasons[0]).toContain("unit missing in guest");
  });

  test("unit present but inactive → fail with state named", () => {
    const v = classifyCellTransport({
      defPresent: true,
      power: "running",
      guest: guest({ unit_active: "failed", health: "" }),
      macEpochS: MAC_EPOCH,
    });
    expect(v.status).toBe("fail");
    expect(v.reasons[0]).toContain("failed");
  });

  test("active unit, dead :8080 → fail", () => {
    const v = classifyCellTransport({
      defPresent: true,
      power: "running",
      guest: guest({ health: "" }),
      macEpochS: MAC_EPOCH,
    });
    expect(v.status).toBe("fail");
    expect(v.reasons[0]).toContain(":8080/health");
  });

  test("oom-kills surface as warn on an otherwise healthy cell", () => {
    const v = classifyCellTransport({
      defPresent: true,
      power: "running",
      guest: guest({ oom_48h: 1 }),
      macEpochS: MAC_EPOCH,
    });
    expect(v.status).toBe("warn");
    expect(v.reasons[0]).toContain("oom-kill");
  });

  test("bob-class clock skew → warn; small skew ignored", () => {
    const skewed = classifyCellTransport({
      defPresent: true,
      power: "running",
      guest: guest({ epoch: MAC_EPOCH - (18 * 24 * 3600) }),
      macEpochS: MAC_EPOCH,
    });
    expect(skewed.status).toBe("warn");
    expect(skewed.reasons[0]).toContain("clock skewed");

    const fine = classifyCellTransport({
      defPresent: true,
      power: "running",
      guest: guest({ epoch: MAC_EPOCH - CLOCK_SKEW_WARN_S + 10 }),
      macEpochS: MAC_EPOCH,
    });
    expect(fine.status).toBe("ok");
  });

  test("fail + warn stack: oom on a unit-missing cell stays fail with both reasons", () => {
    const v = classifyCellTransport({
      defPresent: true,
      power: "running",
      guest: guest({ unit_present: false, oom_48h: 3 }),
      macEpochS: MAC_EPOCH,
    });
    expect(v.status).toBe("fail");
    expect(v.reasons).toHaveLength(2);
  });

  test("hibernated with def → ok (not probed, not woken)", () => {
    const v = classifyCellTransport({ defPresent: true, power: "hibernated", guest: null, macEpochS: MAC_EPOCH });
    expect(v).toEqual({ status: "ok", reasons: [] });
  });

  test("running but exec failed → warn, not fail", () => {
    const v = classifyCellTransport({ defPresent: true, power: "running", guest: null, macEpochS: MAC_EPOCH });
    expect(v.status).toBe("warn");
  });
});
