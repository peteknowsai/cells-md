#!/usr/bin/env bash
# Deploy a per-cell Worker on Cloudflare. Renders the cell-Worker
# template (cli/worker/cell/wrangler.toml) with CELL=<name>, then runs
# `wrangler deploy` against the rendered config. Also pipes the shared
# CELLS_PROXY_SECRET in as a Worker secret.
#
# Pre-reqs (one-time):
#   bunx wrangler login
#   bunx wrangler kv namespace create CHANNELS
#   # paste the returned id into both wrangler.toml files
#
# Usage: scripts/deploy-cell-worker.sh <cell-name> [well-name]
#
# For slow-birth cells, well name == cell name (omit the second arg).
# For hatched cells, the well name is the eggs permanent well
# (e.g. egg-sonnet-67706a) — different from the cell name. Pass it
# explicitly so the Worker's WELL_HOST binding points at the right
# host.
set -euo pipefail

NAME="${1:?usage: $0 <cell-name> [well-name]}"
SPRITE_NAME="${2:-$NAME}"
[[ "$NAME" =~ ^[a-z0-9-]+$ ]] || { echo "bad cell name: $NAME"; exit 1; }
[[ "$SPRITE_NAME" =~ ^[a-z0-9-]+$ ]] || { echo "bad well name: $SPRITE_NAME"; exit 1; }

SECRETS="$HOME/.cells/secrets.json"
[ -f "$SECRETS" ] || { echo "missing $SECRETS"; exit 1; }
SECRET=$(jq -r '.CELLS_PROXY_SECRET // empty' "$SECRETS")
[ -n "$SECRET" ] || { echo "no CELLS_PROXY_SECRET in $SECRETS"; exit 1; }

# Cloudflare account for the Worker's /image/upload → Cloudflare Images
# relay. The account id is rendered into wrangler.toml [vars]; the API
# token is pushed as a Worker secret below. The token is optional — if
# absent the Worker still deploys and /image/upload returns a 503.
CF_ACCOUNT_ID=$(jq -r '.CLOUDFLARE_ACCOUNT_ID // empty' "$SECRETS")
[ -n "$CF_ACCOUNT_ID" ] || { echo "no CLOUDFLARE_ACCOUNT_ID in $SECRETS"; exit 1; }
CF_API_TOKEN=$(jq -r '.CLOUDFLARE_API_TOKEN // empty' "$SECRETS")

# -P resolves symlinks physically. Mother invokes this script through
# dna/proto/mother/scripts (a symlink to the repo's scripts/); a logical
# `cd` would collapse `scripts/..` back to mother's dir, not the repo root.
REPO_ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO_ROOT/cli/worker/cell/wrangler.toml"
[ -f "$TEMPLATE" ] || { echo "missing template $TEMPLATE"; exit 1; }

# Construct the Worker→Well hostname from cells's control-panel config
# (~/.cells/config.json {well_public_base}). Don't lean on `well info`'s
# URL field — that's wells's view, which only renders when welld was
# launched with WELL_PUBLIC_BASE in env. We're the operator; we own the
# convention. Resolution order: process env > config file > default.
CELLS_CONFIG="$HOME/.cells/config.json"
DEFAULT_BASE="cells.md"
if [ -n "${WELL_PUBLIC_BASE:-}" ]; then
  WELL_BASE="$WELL_PUBLIC_BASE"
elif [ -f "$CELLS_CONFIG" ]; then
  WELL_BASE=$(jq -r '.well_public_base // empty' "$CELLS_CONFIG" 2>/dev/null)
  [ -n "$WELL_BASE" ] || WELL_BASE="$DEFAULT_BASE"
else
  WELL_BASE="$DEFAULT_BASE"
fi
WELL_HOST="${SPRITE_NAME}.${WELL_BASE}"

# Render alongside index.ts so wrangler resolves main = "index.ts"
# correctly (it's relative to the config file, not cwd).
RENDERED="$REPO_ROOT/cli/worker/cell/.wrangler.${NAME}.toml"
LOG="$(mktemp -t deploy-cell-${NAME}.XXXXXX)"
trap 'rm -f "$RENDERED" "$LOG"' EXIT
sed -e "s/{{CELL}}/${NAME}/g" -e "s/{{WELL_HOST}}/${WELL_HOST}/g" \
    -e "s/{{CF_ACCOUNT_ID}}/${CF_ACCOUNT_ID}/g" "$TEMPLATE" > "$RENDERED"

cd "$REPO_ROOT/cli/worker/cell"

# Run wrangler quietly. On failure, dump captured output so the user
# has something to debug with; on success, stay silent — the caller
# prints the summary line.
if ! bunx wrangler deploy --config "$RENDERED" >>"$LOG" 2>&1; then
  echo "✗ wrangler deploy failed:"
  cat "$LOG"
  exit 1
fi
if ! echo "$SECRET" | bunx wrangler --config "$RENDERED" secret put CELLS_PROXY_SECRET >>"$LOG" 2>&1; then
  echo "✗ wrangler secret put failed:"
  cat "$LOG"
  exit 1
fi
if [ -n "$CF_API_TOKEN" ]; then
  if ! echo "$CF_API_TOKEN" | bunx wrangler --config "$RENDERED" secret put CLOUDFLARE_API_TOKEN >>"$LOG" 2>&1; then
    echo "✗ wrangler secret put CLOUDFLARE_API_TOKEN failed:"
    cat "$LOG"
    exit 1
  fi
else
  echo "⚠ no CLOUDFLARE_API_TOKEN in $SECRETS — /image/upload returns 503 until one is set"
fi
