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

# Search project node_modules (script's $PWD when run via bun postinstall
# is the project root), the user's global bun cache, AND the system npm
# global install paths (where wells's ubuntu-25.10-base ships pi as of
# 2026-05-09 — pi pre-installed via `npm install -g`, not bun -g).
SEARCH_ROOTS=(
  "./node_modules/@mariozechner"
  "$HOME/.bun/install/global/node_modules/@mariozechner"
  "/usr/lib/node_modules/@mariozechner"
  "/usr/local/lib/node_modules/@mariozechner"
)

patched_url=0
patched_codex=0
patched_anthropic_adaptive=0
patched_levels=0
patched_footer=0
patched_fallback=0

# 1. Anthropic baseUrl. Default: swap api.anthropic.com → proxy.cells.md so
# the cell reaches Anthropic via Pete's subscriptions proxy (Claude Max sub,
# home-IP egress). Exception: if /cell/.anthropic-direct exists, this cell
# runs Anthropic models on a direct ANTHROPIC_API_KEY — restore the pristine
# api.anthropic.com baseUrl so pi-ai talks to Anthropic directly, no proxy
# hop (pi-via-Max is fingerprint-blocked; a paid key is clean). The birthing
# ritual drops that flag for pi cells on anthropic models. The .bak is the
# pristine pre-patch file, so restoring from it is the clean revert.
# Bidirectionally idempotent — safe on every bun install.
ANTHROPIC_DIRECT=0
[ -f /cell/.anthropic-direct ] && ANTHROPIC_DIRECT=1
for F in $(find "${SEARCH_ROOTS[@]}" -name models.generated.js 2>/dev/null); do
  if [ "$ANTHROPIC_DIRECT" = "1" ]; then
    # direct mode: ensure api.anthropic.com — restore from the pristine .bak
    # if the file has been proxy-swapped (idempotent: skip if already direct)
    if ! grep -q 'api\.anthropic\.com' "$F" && [ -f "$F.bak" ]; then
      cp "$F.bak" "$F"
      patched_url=$((patched_url+1))
    fi
  else
    # proxy mode (default): swap api.anthropic.com / mother.cells.md → proxy
    if grep -qE 'api\.anthropic\.com|mother\.cells\.md' "$F"; then
      [ -f "$F.bak" ] || cp "$F" "$F.bak"
      "${SED_INPLACE[@]}" -e 's|https://api.anthropic.com|https://proxy.cells.md|g' \
                          -e 's|https://mother.cells.md|https://proxy.cells.md|g' "$F"
      patched_url=$((patched_url+1))
    fi
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
set +o pipefail
PI_PKG=$(find "${SEARCH_ROOTS[@]}" -path '*pi-coding-agent/package.json' 2>/dev/null | head -n 1)
set -o pipefail
PI_PKG=${PI_PKG:-}
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

# 6. pi-coding-agent: model fallback chain on retry-exhaustion. When
# `_handleRetryableError` exhausts its retry budget, check the cell's
# `modelChain` setting and, if there's a next-tier model, swap to it via
# `setModel()` and continue. The cell is genuinely on the new model after
# this — the footer rerenders to show the new model id.
for F in $(find "${SEARCH_ROOTS[@]}" -name agent-session.js -path '*core*' 2>/dev/null); do
  if grep -q '// === cells model fallback chain ===' "$F"; then continue; fi
  if ! grep -q 'if (this._retryAttempt > settings.maxRetries)' "$F"; then continue; fi
  [ -f "$F.bak" ] || cp "$F" "$F.bak"
  python3 - "$F" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
needle = 'if (this._retryAttempt > settings.maxRetries) {\n            // Max retries exceeded, emit final failure and reset'
inject = '''            // === cells model fallback chain ===
            // Project settings override global; check project first, fall
            // back to global. Mother carries the chain in her project-level
            // settings.json; cells inherit it via DNA push.
            const __chain = this.settingsManager.getProjectSettings()?.modelChain
                ?? this.settingsManager.getGlobalSettings()?.modelChain;
            if (Array.isArray(__chain) && __chain.length > 1 && this.model) {
                const __validLevels = ["off","minimal","low","medium","high","xhigh","adaptive"];
                const __parse = (e) => {
                    const sl = e.indexOf("/");
                    if (sl < 0) return null;
                    const provider = e.slice(0, sl);
                    const rest = e.slice(sl + 1);
                    const cl = rest.lastIndexOf(":");
                    if (cl > 0 && __validLevels.includes(rest.slice(cl + 1))) {
                        return { provider, modelId: rest.slice(0, cl), thinking: rest.slice(cl + 1) };
                    }
                    return { provider, modelId: rest, thinking: undefined };
                };
                const __currentIdx = __chain.findIndex((e) => {
                    const p = __parse(e);
                    return p && p.provider === this.model.provider && p.modelId === this.model.id;
                });
                if (__currentIdx !== -1 && __currentIdx < __chain.length - 1) {
                    const __next = __parse(__chain[__currentIdx + 1]);
                    if (__next) {
                        const __nextModel = (this._scopedModels || [])
                            .map((s) => s.model)
                            .find((m) => m.provider === __next.provider && m.id === __next.modelId);
                        if (__nextModel) {
                            const __msgs = this.agent.state.messages;
                            if (__msgs.length > 0 && __msgs[__msgs.length - 1].role === "assistant") {
                                this.agent.state.messages = __msgs.slice(0, -1);
                            }
                            this._emit({
                                type: "auto_retry_start",
                                attempt: 0,
                                maxAttempts: settings.maxRetries,
                                delayMs: 0,
                                errorMessage: "model_fallback: " + this.model.id + " -> " + __nextModel.id + " (" + (message.errorMessage || "exhausted retries") + ")",
                            });
                            try {
                                await this.setModel(__nextModel);
                                if (__next.thinking) {
                                    try { this.setThinkingLevel(__next.thinking); } catch (e) {}
                                }
                                this._retryAttempt = 0;
                                setTimeout(() => {
                                    this.agent.continue().catch(() => {});
                                }, 0);
                                return true;
                            } catch (e) {
                                // setModel can throw if no auth — fall through to normal failure
                            }
                        }
                    }
                }
            }
            // === end cells model fallback chain ===
'''
new = 'if (this._retryAttempt > settings.maxRetries) {\n' + inject + '            // Max retries exceeded, emit final failure and reset'
if needle not in src:
    sys.exit("fallback patch: needle not found in " + path)
if src.count(needle) > 1:
    sys.exit("fallback patch: needle ambiguous in " + path)
open(path, 'w').write(src.replace(needle, new, 1))
PY
  patched_fallback=$((patched_fallback+1))
done

echo "pi patches: url=$patched_url codex=$patched_codex anthropic-adaptive=$patched_anthropic_adaptive levels=$patched_levels footer=$patched_footer fallback=$patched_fallback"
