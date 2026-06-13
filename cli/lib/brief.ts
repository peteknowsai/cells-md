// Compile a freeform birth brief into config hints + the seed purpose.
//
// A brief does double duty: it seeds the cell's purpose AND can carry config.
// The rule is deterministic and predictable: config hints are COMMA-SEPARATED
// tokens the compiler recognizes — a model key, a thinking level (bare or
// "<level> thinking" / "thinking <level>" / "<level> effort"), or a harness
// (bare or "<harness> harness"). Every segment the compiler does NOT recognize
// stays as the purpose — the cell's first instruction. So:
//
//   "national parcel resolver, opus, medium thinking"
//     → { model: "opus", thinking: "medium", purpose: "national parcel resolver" }
//   "fast chat cell for answering buyer questions"
//     → { purpose: "fast chat cell for answering buyer questions" }   (config via flags/defaults)
//
// Why comma-delimited rather than free NL parsing: it's deterministic, has no
// false positives mid-sentence ("an opus-grade summary" is purpose, not model),
// and the compiled hints flow through cmdCreate's existing validators so the
// previewed blob is already proven legal. An LLM-assisted resolver can later
// replace this extractor behind the same (brief, vocab) → CompiledBrief shape.
//
// Precedence (applied by the caller, not here): an explicit --flag PINS a field;
// otherwise the brief fills it; otherwise the project/global default fills it.
// So this compiler only proposes — it never overrides a flag.

export type BriefVocab = {
  models: string[]; // MODEL_IDS keys, lowercase (opus, sonnet, gpt-5.5, …)
  harnesses: string[]; // pi, claude-code, codex, hermes
  thinkingLevels: string[]; // minimal, low, medium, high, xhigh, max, adaptive
};

export type CompiledBrief = {
  harness?: string;
  model?: string;
  thinking?: string;
  purpose: string; // the brief minus the recognized config tokens
};

// A thinking segment: "<level>", "<level> thinking", "thinking <level>",
// "<level> effort", "effort <level>".
function matchThinking(words: string[], levels: string[]): string | null {
  if (words.length === 1 && levels.includes(words[0]!)) return words[0]!;
  if (words.length === 2) {
    const [a, b] = words as [string, string];
    if ((b === "thinking" || b === "effort") && levels.includes(a)) return a;
    if ((a === "thinking" || a === "effort") && levels.includes(b)) return b;
  }
  return null;
}

// A harness segment: "<harness>" or "<harness> harness".
function matchHarness(words: string[], harnesses: string[]): string | null {
  if (words.length === 1 && harnesses.includes(words[0]!)) return words[0]!;
  if (words.length === 2 && words[1] === "harness" && harnesses.includes(words[0]!)) return words[0]!;
  return null;
}

export function compileBrief(brief: string, vocab: BriefVocab): CompiledBrief {
  const out: CompiledBrief = { purpose: "" };
  const segments = brief.split(",").map((s) => s.trim()).filter(Boolean);
  // Config hints are a TRAILING run of recognized tokens — config trails the
  // purpose (as in "national parcel resolver, opus, medium thinking"). Walk
  // from the end consuming config segments; stop at the first segment that is
  // NOT config. This way a config-like word INSIDE the purpose ("keep it low,
  // friendly") is never silently consumed — only a trailing run is. Within the
  // run, the first-from-the-end value of each kind wins; a repeat of an
  // already-filled kind is still consumed (dropped) rather than left in purpose.
  let cut = segments.length;
  for (let i = segments.length - 1; i >= 0; i--) {
    const words = segments[i]!.toLowerCase().split(/\s+/);
    const lvl = matchThinking(words, vocab.thinkingLevels);
    const harn = matchHarness(words, vocab.harnesses);
    const isModel = words.length === 1 && vocab.models.includes(words[0]!);
    if (!lvl && !harn && !isModel) break; // first non-config → purpose boundary
    if (lvl && out.thinking === undefined) out.thinking = lvl;
    else if (harn && out.harness === undefined) out.harness = harn;
    else if (isModel && out.model === undefined) out.model = words[0]!;
    cut = i;
  }
  out.purpose = segments.slice(0, cut).join(", "); // original casing preserved
  return out;
}
