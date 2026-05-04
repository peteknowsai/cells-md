#!/usr/bin/env bash
# Re-apply pi-ai / pi-coding-agent patches.
#
# These keep four behaviors working that stock pi packages don't give us:
#
#   1. Anthropic baseUrl → mother.cells.md (so cells use Pete's Claude Max sub
#      via the mother proxy on Pete's laptop, home-IP egress).
#   2. Codex extractAccountId neutralized (cells ship the proxy secret as
#      bearer; mother adds the real chatgpt-account-id server-side).
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

# 1. Anthropic baseUrl swap. Handles both fresh installs (api.anthropic.com)
# and cells transiently routed via proxy.cells.md (the pass-4 cutover that
# was rolled back when chatgpt.com's CF anti-loop made egress-IP detection
# a real concern for both vendors).
for F in $(find "${SEARCH_ROOTS[@]}" -name models.generated.js 2>/dev/null); do
  if grep -qE 'api\.anthropic\.com|proxy\.cells\.md' "$F"; then
    [ -f "$F.bak" ] || cp "$F" "$F.bak"
    "${SED_INPLACE[@]}" -e 's|https://api.anthropic.com|https://mother.cells.md|g' \
                        -e 's|https://proxy.cells.md|https://mother.cells.md|g' "$F"
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

echo "pi patches: url=$patched_url codex=$patched_codex anthropic-adaptive=$patched_anthropic_adaptive levels=$patched_levels"
