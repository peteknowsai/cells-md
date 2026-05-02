#!/usr/bin/env bash
# Wire a cell to the mother proxy at https://mother.cells.md.
#
# Drops two ~/.bashrc.d/ env files (the only piece that needs the shared
# secret), then triggers the cell-side apply-pi-patches.sh which does the
# JS-file surgery on pi-ai / pi-coding-agent. The patches script is also
# wired as the cell's bun-install postinstall hook, so future `bun install`
# runs in ~/agent re-apply automatically — adding a dep doesn't silently
# break anthropic/codex/adaptive routing.
#
# Idempotent — safe to re-run any time.
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

# 1c. Site env file: read by ~/agent/site/server.ts. The site server gates
# on x-mother-secret matching MOTHER_SECRET, so even though the sprite URL
# is set to --auth=public (so mother can reach it without org-token auth),
# only requests carrying the shared secret reach the cell.
cat > ~/.bashrc.d/site_proxy <<'EOF'
# Authenticates incoming requests to the cell's site server (~/agent/site/).
# Mother proxy attaches x-mother-secret = this value when forwarding
# <cell>.cells.md → <sprite-host>.
export MOTHER_SECRET=__SECRET__
EOF
sed -i 's|__SECRET__|$SECRET|g' ~/.bashrc.d/site_proxy
chmod 600 ~/.bashrc.d/site_proxy

# 2. Run the cell's idempotent JS-patch script. It also fires automatically
# as bun-install's postinstall hook (see proto/mother/dna/package.json), so this
# direct call is mainly for retrofits and re-runs after rotating secrets.
if [ -x ~/agent/scripts/apply-pi-patches.sh ]; then
  bash ~/agent/scripts/apply-pi-patches.sh
else
  echo 'warning: ~/agent/scripts/apply-pi-patches.sh missing — pi patches not applied'
fi

echo \"proxy configured on $NAME\"
"
