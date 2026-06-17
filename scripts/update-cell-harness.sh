#!/usr/bin/env bash
# Update the cell's harness binaries to the latest version. cell-base is baked
# periodically with the harnesses pre-installed, but versions drift between
# bakes — a freshly-forked cell can be days/weeks behind. Run as the last
# post-birth step so the cell starts its life on current releases.
#
# UNIFORM CELL (docs/proposals/uniform-multi-harness-cell.html): a cell can run
# ANY harness per-session (pi buyer + claude staff on one VM), so ALL the
# installed binaries — not just the baked primary — must be current, or
# activating a dormant harness would run a weeks-stale binary. So this updates
# pi + claude-code + codex: the blob's harness is the PRIMARY (strict — its
# failure fails the step), the others are best-effort (a transient npm hiccup on
# a dormant harness must not fail a birth). hermes is only conditionally
# installed, so it's updated only if its binary is present.
#
# Usage: update-cell-harness.sh <well> <blob-json>
#
# Per-harness update command:
#   pi          → npm install -g @earendil-works/pi-coding-agent + reapply patches
#   claude-code → claude install latest
#   codex       → codex update

set -uo pipefail
CELL_WELL="${1:?well required}"
BLOB="${2:?blob JSON required}"

PRIMARY=$(echo "$BLOB" | jq -r '.harness // "pi"')
# STRICT=1 (default, birth): the primary harness update failing fails the step.
# STRICT=0 (steward maintenance sweep on a live cell): everything is best-effort
# — attempt all three, never fail the caller (a binary update on a live cell is
# non-disruptive; it only affects the NEXT spawn, so a flake just retries later).
STRICT="${HARNESS_UPDATE_STRICT:-1}"

# Update one harness binary on the cell's well. Returns non-zero on failure so the
# caller can decide strict (primary) vs best-effort (dormant).
update_one() {
  local h="$1"
  case "$h" in
    pi)
      # cell-base bakes pi as @mariozechner/pi-coding-agent (the last release before the
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
      # stay put for the extensions to resolve. Verified on a fresh cell —
      # @mariozechner resolves from the /usr/lib pi anchor again post-swap.
      #
      # set -o pipefail in the REMOTE shell so a failed npm install isn't masked
      # by the `| tail` exit status (the outer pipefail doesn't reach inside
      # `bash -lc`). A masked failure would let postwork report OK with pi stale.
      # Each well-exec failure MUST propagate via `|| return 1` — with `set -e`
      # dropped (so the best-effort dormant loop can continue past a flake), the
      # function's exit status would otherwise be whatever its LAST command
      # returned. The `rm -f /usr/bin/pi` here makes a masked npm failure
      # actively dangerous (binary removed, not replaced), so guard it explicitly.
      echo "updating pi on $CELL_WELL (→ @earendil-works, keeping @mariozechner libs) ..."
      well exec -s "$CELL_WELL" -- bash -lc "set -o pipefail; sudo bash -c 'rm -f /usr/bin/pi; npm --prefix /usr install -g @earendil-works/pi-coding-agent' 2>&1 | tail -10" \
        || { echo "PI-INSTALL-FAIL: @earendil install failed on $CELL_WELL — /usr/bin/pi may be missing" >&2; return 1; }
      # Confirm the install actually produced a runnable pi (the rm+install could
      # report ok yet leave no usable binary) — the @mariozechner check below is
      # NOT a proxy for this (it tests the RETAINED lib, present regardless).
      well exec -s "$CELL_WELL" -- bash -lc "command -v pi >/dev/null && pi --version >/dev/null 2>&1 && echo PI-BIN-OK" \
        || { echo "PI-BIN-FAIL: /usr/bin/pi not runnable after install on $CELL_WELL" >&2; return 1; }
      # The reinstall lands a PRISTINE pi-ai — the proxy baseUrl, fallback-chain,
      # codex, and adaptive-thinking patches are gone. Reapply them or an
      # Anthropic-on-Max cell silently reverts to direct api.anthropic.com (and,
      # with the paid key now stripped, breaks). apply-pi-patches.sh searches
      # both npm scopes, so it patches @earendil and the retained @mariozechner.
      echo "re-applying pi patches on $CELL_WELL ..."
      well exec -s "$CELL_WELL" -- bash -lc "set -o pipefail; sudo bash /root/scripts/apply-pi-patches.sh 2>&1 | tail -5" \
        || { echo "PI-PATCH-FAIL: apply-pi-patches.sh failed on $CELL_WELL — pi may revert to direct api.anthropic.com" >&2; return 1; }
      # Verify the exact failure mode is closed: the file that ENOENT'd
      # (@mariozechner/pi-coding-agent's file-processor.js) still resolves from
      # pi's own /usr/lib location after the swap. Deterministic — no model call,
      # no flakiness. Loud failure beats a silently-broken multi-tool path.
      echo "verifying bundled-extension package resolution on $CELL_WELL ..."
      well exec -s "$CELL_WELL" -- bash -lc "[ -f /usr/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli/file-processor.js ] && echo PI-PKG-OK" \
        || { echo "PI-PKG-FAIL: @mariozechner libs missing after swap — bundled extensions (pi-web-access) may ENOENT mid-job on $CELL_WELL" >&2; return 1; }
      ;;
    claude-code)
      echo "updating claude-code on $CELL_WELL ..."
      well exec -s "$CELL_WELL" -- bash -lc "sudo claude install latest 2>&1 | tail -10"
      ;;
    codex)
      echo "updating codex on $CELL_WELL ..."
      well exec -s "$CELL_WELL" -- bash -lc "sudo codex update 2>&1 | tail -10"
      ;;
    hermes)
      # Only conditionally installed (imprint-cell.sh) — skip unless present.
      if well exec -s "$CELL_WELL" -- bash -lc "command -v hermes >/dev/null 2>&1"; then
        echo "updating hermes on $CELL_WELL ..."
        well exec -s "$CELL_WELL" -- bash -lc "command -v hermes >/dev/null && hermes --version 2>&1 | tail -2 || true"
      fi
      ;;
    *)
      echo "unknown harness '$h' — skipping" >&2
      return 0
      ;;
  esac
}

# Primary harness (the blob's) is strict at birth — its failure fails the step.
# Under STRICT=0 (steward sweep) it's best-effort like the rest.
echo "=== updating primary harness '$PRIMARY' (strict=$STRICT) ==="
if ! update_one "$PRIMARY"; then
  if [ "$STRICT" = "1" ]; then
    echo "primary harness '$PRIMARY' update FAILED on $CELL_WELL" >&2
    exit 1
  fi
  echo "WARN: primary harness '$PRIMARY' update failed (best-effort, STRICT=0)" >&2
fi

# The other uniform-cell harnesses (pi, claude-code, codex) are best-effort: a
# dormant binary should be current, but a transient hiccup must not fail birth.
for h in pi claude-code codex; do
  [ "$h" = "$PRIMARY" ] && continue
  echo "=== updating dormant harness '$h' (best-effort) ==="
  if update_one "$h"; then
    echo "  $h updated"
  else
    echo "WARN: dormant harness '$h' update failed on $CELL_WELL — it will be retried by the steward sweep; activating it before then risks a stale binary" >&2
  fi
done

echo "=== harness currency done (primary=$PRIMARY, all uniform harnesses swept) ==="
