#!/usr/bin/env bash
# DEPRECATED for new /root cells. Retained for legacy /home/well/agent retrofit.
#
# Old (legacy /home/well/agent) flow this script implements:
#   - Drops three ~/.bashrc.d/* files with the shared secret.
#   - Runs cell-side apply-pi-patches.sh.
#
# New (/root) flow this script SKIPS:
#   - Secret lives in /etc/environment (set by `well create --env=...`).
#   - /etc/profile.d/cells-env.sh re-exports under pi-ai's expected names.
#   - pi-ai patches bake into cell-base; bun-install postinstall re-applies.
#   - Re-running this script on a /root cell creates orphan ~/.bashrc.d/ files
#     under the WELL user's home, which the cell user (HOME=/root) ignores —
#     a no-op-but-confusing outcome. Don't run it on /root cells.
#
# For secret rotation on a /root cell:
#   well exec -s <name> -- sudo tee /etc/environment <<<"CELLS_PROXY_SECRET=<new>"
#   well exec -s <name> -- sudo systemctl restart well-firstboot.service  # if needed
#
# Idempotent — safe to re-run any time on legacy cells.
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

"${WELL_BINARY:-well}" exec -s "$NAME" -- bash -lc "
set -euo pipefail

# 1a. Anthropic env file: route to subscriptions proxy.
mkdir -p ~/.bashrc.d
rm -f ~/.bashrc.d/anthropic_api_key  # legacy, would conflict
cat > ~/.bashrc.d/anthropic_proxy <<'EOF'
# Route Anthropic API calls through subscriptions proxy (cells.md fleet).
# Pi treats this as an OAuth token (Bearer auth) thanks to the sk-ant-oat prefix.
export ANTHROPIC_OAUTH_TOKEN=__SECRET__
export ANTHROPIC_AUTH_TOKEN=__SECRET__
unset ANTHROPIC_API_KEY
EOF
sed -i 's|__SECRET__|$SECRET|g' ~/.bashrc.d/anthropic_proxy
chmod 600 ~/.bashrc.d/anthropic_proxy

# 1b. Codex env file: read by the codex-proxy extension at pi startup.
cat > ~/.bashrc.d/codex_proxy <<'EOF'
# Route OpenAI Codex (ChatGPT sub) calls through subscriptions proxy.
# Pi-ai has no built-in env lookup for openai-codex; the codex-proxy
# extension reads this var and calls pi.registerProvider with it.
export OPENAI_CODEX_API_KEY=__SECRET__
EOF
sed -i 's|__SECRET__|$SECRET|g' ~/.bashrc.d/codex_proxy
chmod 600 ~/.bashrc.d/codex_proxy

# 1c. Site env file: read by ~/agent/site/server.ts and the heartbeat-watch
# extension. The site server gates the /agent WebSocket upgrade on
# Authorization: Bearer <CELLS_PROXY_SECRET>; the per-cell Cloudflare Worker
# carries this secret to establish the bridge. Static HTTP routes are public
# (the well URL is --auth=public).
cat > ~/.bashrc.d/site_proxy <<'EOF'
# Gates the /agent WS upgrade on the cell's site server (~/agent/site/) and
# is read by heartbeat-watch when posting to pulse. The per-cell Cloudflare
# Worker connects with Authorization: Bearer <this>.
export CELLS_PROXY_SECRET=__SECRET__
EOF
sed -i 's|__SECRET__|$SECRET|g' ~/.bashrc.d/site_proxy
chmod 600 ~/.bashrc.d/site_proxy

# 2. Run the cell's idempotent JS-patch script. It also fires automatically
# as bun-install's postinstall hook (see dna/cells/base/package.json), so this
# direct call is mainly for retrofits and re-runs after rotating secrets.
if [ -x ~/agent/scripts/apply-pi-patches.sh ]; then
  bash ~/agent/scripts/apply-pi-patches.sh
else
  echo 'warning: ~/agent/scripts/apply-pi-patches.sh missing — pi patches not applied'
fi

echo \"proxy configured on $NAME\"
"
