#!/usr/bin/env bash
# Wire a cell to the mother proxy at https://mother.cells.md.
#
# Anthropic side:
# - Drops ~/.bashrc.d/anthropic_proxy with the shared secret as OAuth token.
# - Patches pi-ai's hardcoded api.anthropic.com → mother.cells.md (both copies).
# - Removes any legacy ~/.bashrc.d/anthropic_api_key (would conflict).
#
# Codex side:
# - Drops ~/.bashrc.d/codex_proxy with the shared secret as OPENAI_CODEX_API_KEY,
#   read by the mother-codex extension (pi-ai has no codex env-var fallback).
# - Patches pi-ai's openai-codex-responses.js to neutralize JWT-based
#   extractAccountId: cells ship the proxy secret, not a JWT, and mother
#   injects chatgpt-account-id server-side.
#
# Idempotent — safe to re-run after `bun install` clobbers pi-ai files.
#
# Reads CELLS_PROXY_SECRET from ~/.cells/secrets.json (host side, before exec).
#
# Usage: scripts/configure-cell-proxy.sh <cell-name>
set -euo pipefail

NAME="${1:?usage: $0 <cell-name>}"
SECRETS="$HOME/.cells/secrets.json"
[ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }
SECRET=$(jq -r '.CELLS_PROXY_SECRET // empty' "$SECRETS")
[ -n "$SECRET" ] || { echo "no CELLS_PROXY_SECRET in $SECRETS"; exit 1; }
case "$SECRET" in
  sk-ant-oat*) ;;
  *) echo "CELLS_PROXY_SECRET must start with 'sk-ant-oat' (pi auth dispatch); refusing"; exit 1 ;;
esac

# Push a small remote script that does the work, then run it on the cell.
sprite exec -s "$NAME" -- bash -lc "
set -euo pipefail

# 1a. Anthropic env file: route to mother proxy.
mkdir -p ~/.bashrc.d
rm -f ~/.bashrc.d/anthropic_api_key  # legacy, would conflict
cat > ~/.bashrc.d/anthropic_proxy <<'EOF'
# Route Anthropic API calls through mother proxy (cells.md fleet).
# Pi treats this as an OAuth token (Bearer auth) thanks to the sk-ant-oat prefix.
export ANTHROPIC_OAUTH_TOKEN=__SECRET__
export ANTHROPIC_AUTH_TOKEN=__SECRET__
unset ANTHROPIC_API_KEY
EOF
sed -i 's|__SECRET__|$SECRET|g' ~/.bashrc.d/anthropic_proxy
chmod 600 ~/.bashrc.d/anthropic_proxy

# 1b. Codex env file: read by the mother-codex extension at pi startup.
cat > ~/.bashrc.d/codex_proxy <<'EOF'
# Route OpenAI Codex (ChatGPT sub) calls through mother proxy.
# Pi-ai has no built-in env lookup for openai-codex; the mother-codex
# extension reads this var and calls pi.registerProvider with it.
export OPENAI_CODEX_API_KEY=__SECRET__
EOF
sed -i 's|__SECRET__|$SECRET|g' ~/.bashrc.d/codex_proxy
chmod 600 ~/.bashrc.d/codex_proxy

# 2. Patch pi-ai models registry: api.anthropic.com -> mother.cells.md
patched_anthropic=0
for F in \\
  /home/sprite/agent/node_modules/@mariozechner/pi-ai/dist/models.generated.js \\
  /home/sprite/.bun/install/global/node_modules/@mariozechner/pi-ai/dist/models.generated.js
do
  [ -f \"\$F\" ] || continue
  if grep -q 'api.anthropic.com' \"\$F\"; then
    [ -f \"\$F.bak\" ] || cp \"\$F\" \"\$F.bak\"
    sed -i 's|https://api.anthropic.com|https://mother.cells.md|g' \"\$F\"
    patched_anthropic=\$((patched_anthropic+1))
  fi
done

# 3. Patch pi-ai anthropic provider: route thinking='adaptive' to pure
# adaptive mode (no effort hint). Stock pi-ai always sends an effort
# string for opus, which makes 'adaptive' meaningless. With this patch,
# 'adaptive' returns undefined from mapThinkingLevelToEffort, so the
# provider sends {thinking:{type:'adaptive'}} without output_config.effort
# — the model fully decides per-turn.
patched_anthropic_adaptive=0
for F in \$(find /home/sprite/agent/node_modules/@mariozechner /home/sprite/.bun/install/global/node_modules/@mariozechner -name anthropic.js -path '*providers*' 2>/dev/null); do
  [ -f \"\$F\" ] || continue
  if grep -q 'level === \"adaptive\"' \"\$F\"; then
    continue
  fi
  if ! grep -q 'function mapThinkingLevelToEffort' \"\$F\"; then
    continue
  fi
  [ -f \"\$F.bak\" ] || cp \"\$F\" \"\$F.bak\"
  sed -i 's|function mapThinkingLevelToEffort(level, modelId) {|&\\n    if (level === \"adaptive\") return undefined;|' \"\$F\"
  patched_anthropic_adaptive=\$((patched_anthropic_adaptive+1))
done

# 4. Patch pi-ai codex provider: neutralize JWT-based extractAccountId.
# Cells ship the proxy secret as the codex apiKey; it isn't a JWT, so the
# original extractAccountId would throw. Mother adds the real
# chatgpt-account-id header server-side regardless of what the cell sends.
patched_codex=0
for F in \$(find /home/sprite/agent/node_modules/@mariozechner /home/sprite/.bun/install/global/node_modules/@mariozechner -name openai-codex-responses.js 2>/dev/null); do
  [ -f \"\$F\" ] || continue
  # Skip if already patched (the stub form contains 'return \"\"; }' on the trigger line).
  if grep -q 'function extractAccountId(token) { return \"\"' \"\$F\"; then
    continue
  fi
  if ! grep -q 'function extractAccountId' \"\$F\"; then
    continue
  fi
  [ -f \"\$F.bak\" ] || cp \"\$F\" \"\$F.bak\"
  awk '
    BEGIN { skip=0 }
    /function extractAccountId\\(token\\) \\{/ {
      print \"function extractAccountId(token) { return \\\"\\\"; }\"
      skip=1; depth=1; next
    }
    skip {
      n_open  = gsub(/\\{/, \"{\")
      n_close = gsub(/\\}/, \"}\")
      depth += n_open - n_close
      if (depth <= 0) { skip=0 }
      next
    }
    { print }
  ' \"\$F\" > \"\$F.tmp\" && mv \"\$F.tmp\" \"\$F\"
  patched_codex=\$((patched_codex+1))
done

echo \"proxy configured on $NAME (anthropic url patches: \$patched_anthropic, anthropic adaptive patches: \$patched_anthropic_adaptive, codex patches: \$patched_codex)\"
"
