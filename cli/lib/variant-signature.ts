// Variant signature — canonical string identity for an egg/cell config.
//
// Format: v1:model=<m>,thinking=<t>,extensions=<a>|<b>,packages=<p>,channels=<c>
//   - field order is fixed (model, thinking, extensions, packages, channels)
//   - multi-value fields are pipe-joined and sorted alphabetically
//   - empty multi-values are written as `key=` (no values after the equals)
//
// The signature is the join key between hatch requests (computed from
// `cells birth` flags) and pool stock (eggs.json variant_signature).
// Two variants with the same canonical signature SHOULD be hatch-
// interchangeable; the egg-birth process bakes (model, extensions,
// packages) into the egg, so those have to match exactly. Thinking and
// channels are cheap to apply at hatch and are part of the signature only
// to make the lookup space simpler — Phase 2 may relax those into
// closest-match-and-tweak.
//
// Pure functions. No IO. Unit-testable.

import { createHash } from "node:crypto";

export type Variant = {
  model: string;
  thinking: string;
  extensions: string[];
  packages: string[];
  channels: string[];
};

const VERSION = "v1";

// Canonical formatter. Stable across calls — sort multi-values, fixed field order.
export function formatVariant(v: Variant): string {
  const ext = [...v.extensions].sort().join("|");
  const pkg = [...v.packages].sort().join("|");
  const ch = [...v.channels].sort().join("|");
  return `${VERSION}:model=${v.model},thinking=${v.thinking},extensions=${ext},packages=${pkg},channels=${ch}`;
}

// Inverse of formatVariant. Throws on malformed input — variant signatures
// are produced by us, so anything that doesn't parse is a bug we want loud.
export function parseVariant(sig: string): Variant {
  const [version, body] = sig.split(":", 2);
  if (version !== VERSION) {
    throw new Error(`unsupported variant signature version: ${version} (expected ${VERSION})`);
  }
  if (!body) throw new Error(`empty variant signature body`);
  const fields: Record<string, string> = {};
  for (const part of body.split(",")) {
    const idx = part.indexOf("=");
    if (idx < 0) throw new Error(`malformed field in variant signature: ${part}`);
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    fields[key] = value;
  }
  const required = ["model", "thinking", "extensions", "packages", "channels"];
  for (const r of required) {
    if (!(r in fields)) throw new Error(`variant signature missing required field: ${r}`);
  }
  const splitMulti = (s: string) => (s ? s.split("|").filter(Boolean) : []);
  return {
    model: fields.model,
    thinking: fields.thinking,
    extensions: splitMulti(fields.extensions).sort(),
    packages: splitMulti(fields.packages).sort(),
    channels: splitMulti(fields.channels).sort(),
  };
}

// Stable 6-hex prefix of sha256(canonical signature). Used as the egg id
// suffix and as the sprite-name suffix for collision-free pool naming.
export function variantHash(v: Variant): string {
  const canonical = formatVariant(v);
  const h = createHash("sha256").update(canonical).digest("hex");
  return h.slice(0, 6);
}

// Sprite-friendly egg sprite name. Sprites only allow [a-z0-9-]. Tokens
// drop everything non-alphanumeric so e.g. "gpt-5.5" → "gpt55", "claude-
// opus-4-7" would become "claudeopus47" (we use short keys like "opus"
// from MODEL_IDS so this stays compact).
export function eggSpriteName(v: Variant): string {
  const modelTok = v.model.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return `egg-${modelTok}-${variantHash(v)}`;
}

// Equality on canonical form. Always use this rather than ===
// — clients may construct variants with extensions in different orders
// and we want them to compare equal.
export function variantsEqual(a: Variant, b: Variant): boolean {
  return formatVariant(a) === formatVariant(b);
}

// Pool key — the canonical signature with thinking and channels zeroed
// out. These dimensions are NOT baked into the egg (thinking is a
// substitution at hatch; channels are deferred to async post-hatch
// wiring), so an egg should match a request that differs only in those
// fields. Use poolKey() when storing the egg's signature in eggs.json
// and when comparing a hatch request to in-stock eggs.
export function poolKey(v: Variant): string {
  return formatVariant({ ...v, thinking: "", channels: [] });
}

// Convenience: do these two variants share the same pool key?
export function poolKeyMatches(a: Variant, b: Variant): boolean {
  return poolKey(a) === poolKey(b);
}
