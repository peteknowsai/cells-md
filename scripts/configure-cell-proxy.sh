#!/usr/bin/env bash
# Wire a cell to the mother proxy at https://mother.cells.md.
# - Drops ~/.bashrc.d/anthropic_proxy with the shared secret as OAuth token.
# - Patches pi-ai's hardcoded api.anthropic.com → mother.cells.md (both copies).
# - Removes any legacy ~/.bashrc.d/anthropic_api_key (would conflict).
# Idempotent — safe to re-run after `bun install` clobbers the model registry.
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

# 1. Env file: route to mother proxy.
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

# 2. Patch pi-ai models registry: api.anthropic.com -> mother.cells.md
patched=0
for F in \\
  /home/sprite/agent/node_modules/@mariozechner/pi-ai/dist/models.generated.js \\
  /home/sprite/.bun/install/global/node_modules/@mariozechner/pi-ai/dist/models.generated.js
do
  [ -f \"\$F\" ] || continue
  if grep -q 'api.anthropic.com' \"\$F\"; then
    [ -f \"\$F.bak\" ] || cp \"\$F\" \"\$F.bak\"
    sed -i 's|https://api.anthropic.com|https://mother.cells.md|g' \"\$F\"
    patched=\$((patched+1))
  fi
done
echo \"proxy configured on $NAME (patched \$patched model file(s) → mother.cells.md)\"
"
