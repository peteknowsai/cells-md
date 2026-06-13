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
# The optional [well-name] is accepted for backward compatibility (mother's
# birth ritual still passes it) but no longer used: post-bridge-direction-flip
# the Worker has no WELL_HOST binding — the well's supervisor dials the
# bridge out to <cell>.cells.md, so the Worker never needs the well's host.
set -euo pipefail

NAME="${1:?usage: $0 <cell-name> [well-name]}"
[[ "$NAME" =~ ^[a-z0-9-]+$ ]] || { echo "bad cell name: $NAME"; exit 1; }

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
# dna/specials/mother/scripts (a symlink to the repo's scripts/); a logical
# `cd` would collapse `scripts/..` back to mother's dir, not the repo root.
REPO_ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO_ROOT/cli/worker/cell/wrangler.toml"
[ -f "$TEMPLATE" ] || { echo "missing template $TEMPLATE"; exit 1; }

# Render alongside index.ts so wrangler resolves main = "index.ts" correctly
# (it's relative to the config file, not cwd). Unique per-invocation ($$ = this
# process's pid) so two concurrent deploys of the SAME cell — e.g. a self-healing
# `cells run` and a still-running birth-postwork worker_deploy — don't share one
# rendered file and have one's EXIT-trap `rm` yank it out from under the other
# mid-`wrangler secret put`. Concurrent processes always have distinct pids, so
# this is collision-free where it matters.
RENDERED="$REPO_ROOT/cli/worker/cell/.wrangler.${NAME}.$$.toml"
LOG="$(mktemp -t deploy-cell-${NAME}.XXXXXX)"
trap 'rm -f "$RENDERED" "$LOG"' EXIT
sed -e "s/{{CELL}}/${NAME}/g" \
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

# Clerk auth — one app across all cells, cookie domain `.cells.md` so a
# single sign-in covers every cell. Both keys are optional; if either is
# missing, the Worker just skips the auth path and the site behaves
# exactly as it did pre-Clerk. That makes the rollout safe: deploy code
# first, drop the keys into ~/.cells/secrets.json + redeploy when ready.
CLERK_PK=$(jq -r '.CLERK_PUBLISHABLE_KEY // empty' "$SECRETS")
CLERK_JWT=$(jq -r '.CLERK_JWT_KEY // empty' "$SECRETS")
if [ -n "$CLERK_PK" ]; then
  if ! echo "$CLERK_PK" | bunx wrangler --config "$RENDERED" secret put CLERK_PUBLISHABLE_KEY >>"$LOG" 2>&1; then
    echo "✗ wrangler secret put CLERK_PUBLISHABLE_KEY failed:"
    cat "$LOG"
    exit 1
  fi
fi
if [ -n "$CLERK_JWT" ]; then
  if ! printf '%s' "$CLERK_JWT" | bunx wrangler --config "$RENDERED" secret put CLERK_JWT_KEY >>"$LOG" 2>&1; then
    echo "✗ wrangler secret put CLERK_JWT_KEY failed:"
    cat "$LOG"
    exit 1
  fi
fi
if [ -z "$CLERK_PK" ] || [ -z "$CLERK_JWT" ]; then
  echo "⚠ Clerk keys missing in $SECRETS — site stays public-only until both CLERK_PUBLISHABLE_KEY + CLERK_JWT_KEY are set"
fi
