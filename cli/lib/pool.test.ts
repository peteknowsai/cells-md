import { test, expect } from "bun:test";
import { parsePoolFile, parseLegacyEggs, countOpen, V1_POOL_VARIANT_SIGNATURE, type PoolMember } from "./pool";

function member(over: Partial<PoolMember>): PoolMember {
  return {
    id: "abc123",
    well_name: "egg-abc123",
    variant_signature: V1_POOL_VARIANT_SIGNATURE,
    state: "open",
    born_at: "2026-05-30T00:00:00Z",
    claimed_at: null,
    claimed_by: null,
    max_age_at: "2026-06-06T00:00:00Z",
    tier: 2,
    ...over,
  };
}

// ── parsePoolFile ──────────────────────────────────────────────────────

test("parsePoolFile accepts a well-formed pool document", () => {
  const raw = JSON.stringify({ version: 1, members: [member({})] });
  const f = parsePoolFile(raw);
  expect(f.version).toBe(1);
  expect(f.members.length).toBe(1);
  expect(f.members[0]!.well_name).toBe("egg-abc123");
});

test("parsePoolFile accepts an empty member list", () => {
  expect(parsePoolFile(JSON.stringify({ version: 1, members: [] })).members).toEqual([]);
});

test("parsePoolFile throws on a wrong version", () => {
  expect(() => parsePoolFile(JSON.stringify({ version: 2, members: [] }))).toThrow(/malformed/);
});

test("parsePoolFile throws when members is not an array", () => {
  expect(() => parsePoolFile(JSON.stringify({ version: 1, members: {} }))).toThrow(/malformed/);
});

test("parsePoolFile throws on invalid JSON", () => {
  // A corrupt pool.json must surface, not silently read as empty — that
  // would look like "the pool got wiped" to every downstream consumer.
  expect(() => parsePoolFile("{not json")).toThrow();
});

test("parsePoolFile normalizes legacy 'warm' state to 'open'", () => {
  // Nothing else reaps legacy-state members (claim/refill/reconcile/drain
  // all filter for "open", max_age_at isn't enforced), so a stray warm
  // would linger forever and trigger perpetual replacement bakes.
  // Normalizing on parse is the only cleanup path.
  const raw = JSON.stringify({ version: 1, members: [member({ state: "warm" as any })] });
  expect(parsePoolFile(raw).members[0]!.state).toBe("open");
});

// ── parseLegacyEggs (the eggs.json → pool.json migration step) ─────────

test("parseLegacyEggs reshapes the legacy {eggs:[...]} envelope to members", () => {
  const raw = JSON.stringify({ eggs: [member({ id: "leg1" }), member({ id: "leg2" })] });
  const file = parseLegacyEggs(raw);
  expect(file.version).toBe(1);
  expect(file.members.map((m) => m.id)).toEqual(["leg1", "leg2"]);
});

test("parseLegacyEggs normalizes 'warm' → 'open' while migrating", () => {
  // Regression pin: the migration branch once reshaped eggs→members but
  // skipped the warm→open pass, so a migrated egg stayed invisibly "warm"
  // (claim/refill/reconcile/drain all filter for "open") — it would never
  // be claimed and refill would bake replacements past it forever.
  const raw = JSON.stringify({ eggs: [member({ id: "leg", state: "warm" as any })] });
  expect(parseLegacyEggs(raw).members[0]!.state).toBe("open");
});

test("parseLegacyEggs degrades a missing/!array eggs key to an empty pool", () => {
  expect(parseLegacyEggs(JSON.stringify({})).members).toEqual([]);
  expect(parseLegacyEggs(JSON.stringify({ eggs: null })).members).toEqual([]);
  expect(parseLegacyEggs(JSON.stringify({ eggs: "nope" })).members).toEqual([]);
});

test("parseLegacyEggs throws on invalid JSON", () => {
  expect(() => parseLegacyEggs("{not json")).toThrow();
});

// ── countOpen ──────────────────────────────────────────────────────────

test("countOpen counts only open members with the V1 signature", () => {
  const members = [
    member({ id: "1", state: "open" }),
    member({ id: "2", state: "open" }),
    member({ id: "3", state: "claimed" }),     // not open
    member({ id: "4", state: "live" }),         // not open
    member({ id: "5", state: "open", variant_signature: "v2-something" }), // wrong sig
  ];
  expect(countOpen(members)).toBe(2);
});

test("countOpen returns 0 for an empty pool", () => {
  expect(countOpen([])).toBe(0);
});

test("countOpen ignores open members from a different variant pool", () => {
  const members = [member({ state: "open", variant_signature: "v2-foo" })];
  expect(countOpen(members)).toBe(0);
});
