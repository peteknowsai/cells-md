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
    # Eggs bake pi as @mariozechner/pi-coding-agent (the last release before the
    # upstream rename) at /usr/bin/pi via npm --prefix /usr. This step makes
    # /usr/bin/pi the renamed @earendil-works build — WITHOUT removing the
    # @mariozechner package files.
    #
    # Why not `npm uninstall @mariozechner` (the old behavior): bundled pi
    # extensions (pi-web-access) import @mariozechner/pi-coding-agent, and
    # they're installed host-provided (NOT declared deps), so they resolve
    # @mariozechner by node parent-walk. When pi — now @earendil, living in
    # /usr/lib — resolves those imports from its OWN location, the only copy it
    # can reach is /usr/lib/node_modules/@mariozechner. The old uninstall
    # deleted exactly that, leaving a dangling
    # .../@mariozechner/pi-coding-agent/dist/cli/file-processor.js that
    # intermittently ENOENT'd ~23s into a multi-tool job (homezero, 2026-06-13).
    #
    # Both packages ship a `pi` bin, so a plain `npm install @earendil` EEXISTs
    # on /usr/bin/pi. Free just the bin symlink (not the package) and install
    # @earendil over it: @earendil owns the bin, @mariozechner's library files
    # stay put for the extensions to resolve. Verified on a fresh egg —
    # @mariozechner resolves from the /usr/lib pi anchor again post-swap.
    #
    # set -o pipefail in the REMOTE shell so a failed npm install isn't masked
    # by the `| tail` exit status (the outer pipefail doesn't reach inside
    # `bash -lc`). A masked failure would let postwork report OK with pi stale.
    echo "updating pi on $EGG_WELL (→ @earendil-works, keeping @mariozechner libs) ..."
    well exec -s "$EGG_WELL" -- bash -lc "set -o pipefail; sudo bash -c 'rm -f /usr/bin/pi; npm --prefix /usr install -g @earendil-works/pi-coding-agent' 2>&1 | tail -10"
    # The reinstall lands a PRISTINE pi-ai — the proxy baseUrl, fallback-chain,
    # codex, and adaptive-thinking patches are gone. Reapply them or an
    # Anthropic-on-Max cell silently reverts to direct api.anthropic.com (and,
    # with the paid key now stripped, breaks). apply-pi-patches.sh searches
    # both npm scopes, so it patches @earendil and the retained @mariozechner.
    echo "re-applying pi patches on $EGG_WELL ..."
    well exec -s "$EGG_WELL" -- bash -lc "set -o pipefail; sudo bash /root/scripts/apply-pi-patches.sh 2>&1 | tail -5"
    # Verify the exact failure mode is closed: the file that ENOENT'd
    # (@mariozechner/pi-coding-agent's file-processor.js) still resolves from
    # pi's own /usr/lib location after the swap. Deterministic — no model call,
    # no flakiness. Loud failure beats a silently-broken multi-tool path.
    echo "verifying bundled-extension package resolution on $EGG_WELL ..."
    well exec -s "$EGG_WELL" -- bash -lc "[ -f /usr/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli/file-processor.js ] && echo PI-PKG-OK" \
      || { echo "PI-PKG-FAIL: @mariozechner libs missing after swap — bundled extensions (pi-web-access) may ENOENT mid-job on $EGG_WELL" >&2; exit 1; }
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
