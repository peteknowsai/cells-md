#!/usr/bin/env bash
# Deploy the cells-front-proxy Worker (proxy.cells.md). Pipes
# CELLS_PROXY_SECRET (cells use, same value as everywhere else) and
# MOTHER_REFRESH_SECRET (mother uses to PUT tokens) from
# ~/.cells/secrets.json as Worker secrets.
#
# Pre-reqs (one-time):
#   bunx wrangler login
#   - Add MOTHER_REFRESH_SECRET to ~/.cells/secrets.json
#     (e.g. `openssl rand -hex 32`)
set -euo pipefail

SECRETS="$HOME/.cells/secrets.json"
[ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }
PROXY_SECRET=$(jq -r '.CELLS_PROXY_SECRET // empty' "$SECRETS")
REFRESH_SECRET=$(jq -r '.MOTHER_REFRESH_SECRET // empty' "$SECRETS")
[ -n "$PROXY_SECRET" ] || { echo "no CELLS_PROXY_SECRET in $SECRETS"; exit 1; }
[ -n "$REFRESH_SECRET" ] || { echo "no MOTHER_REFRESH_SECRET in $SECRETS"; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/cli/worker/proxy"

LOG="$(mktemp -t deploy-proxy-worker.XXXXXX)"
trap 'rm -f "$LOG"' EXIT

if ! bunx wrangler deploy >>"$LOG" 2>&1; then
  echo "✗ wrangler deploy failed:"
  cat "$LOG"
  exit 1
fi
if ! echo "$PROXY_SECRET" | bunx wrangler secret put CELLS_PROXY_SECRET >>"$LOG" 2>&1; then
  echo "✗ wrangler secret put CELLS_PROXY_SECRET failed:"
  cat "$LOG"
  exit 1
fi
if ! echo "$REFRESH_SECRET" | bunx wrangler secret put MOTHER_REFRESH_SECRET >>"$LOG" 2>&1; then
  echo "✗ wrangler secret put MOTHER_REFRESH_SECRET failed:"
  cat "$LOG"
  exit 1
fi

echo "✓ deployed cells-front-proxy"
