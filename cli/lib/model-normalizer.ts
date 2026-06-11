// "opus means latest opus" — pure logic for the proxy's model normalizer.
//
// Pete's standing rule (2026-06-11): any opus-family model ID a cell sends is
// rewritten to the newest Opus before it reaches api.anthropic.com. Cells pin
// nothing; a cell baked months ago with claude-opus-4-7 in its settings rides
// the latest Opus the day it ships. The proxy is the chokepoint every
// Anthropic call already flows through, so the rewrite is structural — no
// per-cell config to keep fresh.
//
// Scope is deliberately opus-only: sonnet/haiku are left untouched (claude-code
// uses haiku for background chores; surprising those is not worth it).

export type ModelListEntry = { id: string; created_at?: string };

/** True for any opus-family ID or alias a cell might send. */
export function isOpusFamily(model: string): boolean {
  return model === "opus" || model === "claude-opus-latest" || model.startsWith("claude-opus-");
}

/**
 * Pick the newest Opus from a /v1/models response. Sorts by created_at when
 * present (the API provides it), falling back to list order (the API returns
 * newest first). Returns null when the list has no opus entries.
 */
export function latestOpusFrom(models: ModelListEntry[]): string | null {
  const opus = models.filter((m) => typeof m.id === "string" && m.id.startsWith("claude-opus-"));
  if (opus.length === 0) return null;
  const dated = opus.filter((m) => m.created_at);
  if (dated.length === opus.length) {
    dated.sort((a, b) => (a.created_at! < b.created_at! ? 1 : -1));
    return dated[0].id;
  }
  return opus[0].id;
}

/**
 * The rewrite: opus-family → latest. Anything else (sonnet, haiku, gpt-*,
 * unknown strings) passes through untouched. With no latest known (models
 * fetch never succeeded) the original is returned — the proxy never breaks a
 * request over a failed catalog lookup.
 */
export function normalizeAnthropicModel(model: string, latest: string | null): string {
  if (!latest) return model;
  if (!isOpusFamily(model)) return model;
  return latest;
}
