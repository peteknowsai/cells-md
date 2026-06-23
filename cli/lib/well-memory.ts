// Per-cell VM memory policy.
//
// claude-code cells run a full interactive `claude` — a warm session pool plus
// a dedicated tmux session per job — whose RSS grows over a long conversation.
// A 1GB box OOMs on a ~60-turn Opus game (kdice-opus, 2026-06-22: free showed
// 913/947Mi used, swap exhausted). pi/codex cells just stream a model call
// through the proxy and stay light, so they keep welld's default (1GB).
//
// The substrate (wells) sizes a well from the `memory` field on create; passing
// nothing inherits welld's ~/.wells/defaults.json default. So returning
// undefined here means "no override — take the welld default". An explicit
// --memory=<size> at birth overrides this policy entirely.
//
// VZ.framework pins memorySize at boot (no live grow), so a cell that outgrows
// its size is resized with `cells resize <name> --memory=<size>` (stop → patch
// → start; disk + identity preserved).

export function defaultMemoryForBirth(
  harness: string | undefined,
  model: string | undefined,
): string | undefined {
  // pi/codex/hermes stay light — welld default (1GB).
  if (harness !== "claude-code") return undefined;
  // Opus sessions grow the most context/RSS — give them the most headroom.
  if (model && /opus/i.test(model)) return "4GB";
  // Other claude-code models (sonnet/haiku) — 2x the default is plenty for a
  // single interactive session.
  return "2GB";
}
