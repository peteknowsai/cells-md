#!/usr/bin/env bash
# Update the cell's harness binary to the latest version. Eggs are baked
# periodically with the harness pre-installed, but versions drift between
# bakes — a fresh egg can be days/weeks behind. Run as the last post-birth
# step so the cell starts its life on the current release.
#
# Usage: update-cell-harness.sh <egg-well> <blob-json>
#
# Per-harness update command:
#   pi          → pi update pi
#   claude-code → claude install latest
#   codex       → codex update

set -euo pipefail
EGG_WELL="${1:?egg-well required}"
BLOB="${2:?blob JSON required}"

HARNESS=$(echo "$BLOB" | jq -r '.harness // "pi"')

case "$HARNESS" in
  pi)
    # Eggs install pi as root at /usr/bin/pi via npm --prefix /usr.
    # `pi update pi` fails for that path ("install path is not writable")
    # because pi itself runs unprivileged. Use sudo + the exact command pi
    # suggested. The package name was renamed @mariozechner → @earendil-works.
    echo "updating pi on $EGG_WELL ..."
    # set -o pipefail in the REMOTE shell so a failed npm install isn't masked
    # by the `| tail` exit status (the outer script's pipefail doesn't reach
    # inside `bash -lc`). A masked failure would let postwork report OK with pi
    # missing or stale.
    well exec -s "$EGG_WELL" -- bash -lc "set -o pipefail; sudo bash -c 'npm --prefix /usr uninstall -g @mariozechner/pi-coding-agent 2>/dev/null; npm --prefix /usr install -g @earendil-works/pi-coding-agent' 2>&1 | tail -10"
    # The reinstall lands a PRISTINE pi-ai — the proxy baseUrl, fallback-chain,
    # codex, and adaptive-thinking patches are gone. Reapply them or an
    # Anthropic-on-Max cell silently reverts to direct api.anthropic.com (and,
    # with the paid key now stripped, breaks). apply-pi-patches.sh searches
    # both npm scopes, so it finds the freshly-installed @earendil-works copy.
    echo "re-applying pi patches on $EGG_WELL ..."
    # set -o pipefail so a failed re-patch propagates instead of being masked
    # by `| tail` — otherwise postwork reports OK while the freshly installed
    # @earendil-works pi stays pristine (direct api.anthropic.com), breaking an
    # Anthropic-on-Max cell after a green smoke test. (codex review, round 2.)
    well exec -s "$EGG_WELL" -- bash -lc "set -o pipefail; sudo bash /root/scripts/apply-pi-patches.sh 2>&1 | tail -5"
    ;;
  claude-code)
    echo "updating claude-code on $EGG_WELL ..."
    well exec -s "$EGG_WELL" -- bash -lc "sudo claude install latest 2>&1 | tail -10"
    ;;
  codex)
    echo "updating codex on $EGG_WELL ..."
    well exec -s "$EGG_WELL" -- bash -lc "sudo codex update 2>&1 | tail -10"
    ;;
  *)
    echo "unknown harness '$HARNESS' — skipping update"
    exit 0
    ;;
esac
