#!/usr/bin/env bash
# Re-apply pi-ai / pi-coding-agent patches.
#
# These keep four behaviors working that stock pi packages don't give us:
#
#   1. Anthropic baseUrl → proxy.cells.md (so cells use Pete's Claude Max sub
#      via the subscriptions proxy running on Pete's laptop, home-IP egress).
#   2. Codex extractAccountId neutralized (cells ship the proxy secret as
#      bearer; the proxy adds the real chatgpt-account-id server-side).
#   3. Anthropic mapThinkingLevelToEffort returns undefined for "adaptive"
#      (so the model fully decides per-turn — no effort hint).
#   4. pi-coding-agent THINKING_LEVELS arrays include "adaptive" (so
#      setThinkingLevel("adaptive") doesn't get clamped to "off").
#
# Wired as the cell's `bun install` postinstall hook — runs on first
# install at birth AND on every subsequent bun install, so adding a dep
# doesn't silently break anthropic/codex/adaptive routing.
#
# Idempotent. Cross-platform (macOS + Linux). Patches both project
# node_modules and the global install (where the `pi` binary lives).
set -euo pipefail

# BSD sed (macOS) requires a backup-suffix arg with -i; GNU sed (Linux) does
# not accept one. Detect once and use the right form.
if sed --version >/dev/null 2>&1; then
  SED_INPLACE=(sed -i)
else
  SED_INPLACE=(sed -i "")
fi

# Search both the project node_modules (this script's $PWD when run via
# bun postinstall is the project root) and the user's global bun cache.
SEARCH_ROOTS=(
  "./node_modules/@mariozechner"
  "$HOME/.bun/install/global/node_modules/@mariozechner"
)

patched_url=0
patched_codex=0
patched_anthropic_adaptive=0
patched_levels=0
patched_footer=0

# 1. Anthropic baseUrl swap. Handles both fresh installs (api.anthropic.com)
# and cells previously pointed at mother.cells.md (the pre-split routing,
# when the proxy was bundled into mother).
for F in $(find "${SEARCH_ROOTS[@]}" -name models.generated.js 2>/dev/null); do
  if grep -qE 'api\.anthropic\.com|mother\.cells\.md' "$F"; then
    [ -f "$F.bak" ] || cp "$F" "$F.bak"
    "${SED_INPLACE[@]}" -e 's|https://api.anthropic.com|https://proxy.cells.md|g' \
                        -e 's|https://mother.cells.md|https://proxy.cells.md|g' "$F"
    patched_url=$((patched_url+1))
  fi
done

# 2. Codex extractAccountId stub.
for F in $(find "${SEARCH_ROOTS[@]}" -name openai-codex-responses.js 2>/dev/null); do
  if grep -q 'function extractAccountId(token) { return ""' "$F"; then continue; fi
  if ! grep -q 'function extractAccountId' "$F"; then continue; fi
  [ -f "$F.bak" ] || cp "$F" "$F.bak"
  awk '
    BEGIN { skip=0 }
    /function extractAccountId\(token\) \{/ {
      print "function extractAccountId(token) { return \"\"; }"
      skip=1; depth=1; next
    }
    skip {
      n_open  = gsub(/\{/, "{")
      n_close = gsub(/\}/, "}")
      depth += n_open - n_close
      if (depth <= 0) { skip=0 }
      next
    }
    { print }
  ' "$F" > "$F.tmp" && mv "$F.tmp" "$F"
  patched_codex=$((patched_codex+1))
done

# 3. Anthropic adaptive thinking → effort: undefined.
for F in $(find "${SEARCH_ROOTS[@]}" -name anthropic.js -path '*providers*' 2>/dev/null); do
  if grep -q 'level === "adaptive"' "$F"; then continue; fi
  if ! grep -q 'function mapThinkingLevelToEffort' "$F"; then continue; fi
  [ -f "$F.bak" ] || cp "$F" "$F.bak"
  "${SED_INPLACE[@]}" 's|function mapThinkingLevelToEffort(level, modelId) {|&\
    if (level === "adaptive") return undefined;|' "$F"
  patched_anthropic_adaptive=$((patched_anthropic_adaptive+1))
done

# 4. pi-coding-agent THINKING_LEVELS arrays include "adaptive". 0.72
# dropped THINKING_LEVELS_WITH_XHIGH; patch whichever array(s) exist.
for F in $(find "${SEARCH_ROOTS[@]}" -name agent-session.js -path '*core*' 2>/dev/null); do
  if grep -q 'THINKING_LEVELS.*"adaptive"' "$F"; then continue; fi
  if ! grep -q 'const THINKING_LEVELS' "$F"; then continue; fi
  [ -f "$F.bak" ] || cp "$F" "$F.bak"
  "${SED_INPLACE[@]}" \
    -e 's|const THINKING_LEVELS = \["off", "minimal", "low", "medium", "high"\];|const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "adaptive"];|' \
    -e 's|const THINKING_LEVELS_WITH_XHIGH = \["off", "minimal", "low", "medium", "high", "xhigh"\];|const THINKING_LEVELS_WITH_XHIGH = ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"];|' \
    "$F"
  patched_levels=$((patched_levels+1))
done

# 5. pi-coding-agent footer: replace the stats line with a minimal
# four-segment format that matches the cell's tmux bar aesthetic:
#
#   🧠 <context%>   🤖 <pretty model name [(ctx-window if not 1M)]>   💪 <thinking>   📟 v<pi version>
#
# Drops everything else: pwd/branch line (cell name lives in tmux bar),
# up/down tokens, cache R/W, $ cost, "(auto)" suffix. This is replacement
# of the entire `const lines = [...]` array — supersedes the old "drop
# pwd line" patch.
PI_PKG=$(find "${SEARCH_ROOTS[@]}" -path '*pi-coding-agent/package.json' 2>/dev/null | head -1)
PI_VER=$(jq -r .version "$PI_PKG" 2>/dev/null || echo "?")
for F in $(find "${SEARCH_ROOTS[@]}" -name footer.js -path '*interactive/components*' 2>/dev/null); do
  if grep -q '// === cells custom footer ===' "$F"; then continue; fi
  if ! grep -q 'const lines = \[' "$F"; then continue; fi
  [ -f "$F.bak" ] || cp "$F" "$F.bak"
  PI_VER="$PI_VER" python3 - "$F" <<'PY'
import os, re, sys
path = sys.argv[1]
ver = os.environ["PI_VER"]
src = open(path).read()
new = '''// === cells custom footer ===
        const __PI_VER = ''' + repr(ver) + ''';
        const __PRETTY_MODEL = {
            "claude-opus-4-7": "Opus 4.7",
            "claude-opus-4-6": "Opus 4.6",
            "claude-sonnet-4-6": "Sonnet 4.6",
            "claude-sonnet-4-5": "Sonnet 4.5",
            "claude-haiku-4-5": "Haiku 4.5",
            "deepseek-v4-flash": "DeepSeek v4 Flash",
            "deepseek-v4-pro": "DeepSeek v4 Pro",
            "gpt-5.5": "GPT-5.5",
            "gpt-5.5-pro": "GPT-5.5 Pro",
        };
        const __ctxStr = `\\u{1F9E0} ${contextPercent}%`;
        const __modelId = state.model?.id ?? "no-model";
        const __modelName = __PRETTY_MODEL[__modelId] ?? __modelId;
        const __cwSuffix = (contextWindow && contextWindow !== 1000000) ? ` (${formatTokens(contextWindow)})` : "";
        const __modelStr = `\\u{1F916} ${__modelName}${__cwSuffix}`;
        const __thinking = state.thinkingLevel ?? "off";
        const __thinkStr = `\\u{1F4AA} ${__thinking}`;
        const __verStr = `\\u{1F4DF} v${__PI_VER}`;
        const __cellsLine = theme.fg("dim", `${__ctxStr}   ${__modelStr}   ${__thinkStr}   ${__verStr}`);
        const lines = [__cellsLine];'''
# lambda replacement to avoid re.sub interpreting backslash-escapes in
# `new` (the unicode escapes for the emojis trip Python's regex engine).
src = re.sub(r'const lines = \[[^\]]*\];', lambda m: new, src, count=1)
open(path, 'w').write(src)
PY
  patched_footer=$((patched_footer+1))
done

echo "pi patches: url=$patched_url codex=$patched_codex anthropic-adaptive=$patched_anthropic_adaptive levels=$patched_levels footer=$patched_footer"
