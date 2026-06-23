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
      # cell-base now bakes @earendil-works/pi-coding-agent directly (the upstream
      # @mariozechner → @earendil-works rename, settled 2026-05-07). A freshly-
      # forked cell therefore already has a current /usr/bin/pi at fork. This step
      # only (a) keeps a LIVE cell current between bakes, and (b) migrates any
      # pre-rename cell (still baked @mariozechner) onto @earendil-works.
      #
      # NON-DESTRUCTIVE — the load-bearing change (Zero, 2026-06-22): never
      # `rm -f /usr/bin/pi`. The old approach removed the bin first, then ran a
      # multi-minute `npm install` (node-gyp native build), leaving /usr/bin/pi
      # ABSENT for 9-16 min and racing birth's Phase B to `exit 127 / pi: command
      # not found`. Instead install with `--force`: npm overwrites the `pi` bin in
      # place (atomic symlink swap) whether the incumbent is @mariozechner or
      # @earendil — there is no absent window.
      #
      # IDEMPOTENT + skip-if-current: if /usr/bin/pi already resolves into
      # @earendil-works at the registry-latest version, skip the reinstall so a
      # just-baked cell (and every 30-min steward sweep) doesn't redo the node-gyp
      # compile. We never `npm uninstall @mariozechner` — on an old cell its libs
      # stay put for any bundled extension that parent-walk-resolves them; a clean
      # @earendil cell simply has none, so there is nothing to keep.
      #
      # set -o pipefail in the REMOTE shell so a failed npm install isn't masked
      # by the `| tail` exit status; the `|| return 1` propagates it (the dormant
      # loop runs without set -e, so the function's status would otherwise be the
      # last command's).
      echo "updating pi on $CELL_WELL (→ @earendil-works, non-destructive) ..."
      well exec -s "$CELL_WELL" -- bash -lc '
        set -o pipefail
        want=$(npm view @earendil-works/pi-coding-agent version 2>/dev/null || true)
        real=$(readlink -f "$(command -v pi)" 2>/dev/null || true)
        have=$(pi --version 2>/dev/null | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1 || true)
        if printf "%s" "$real" | grep -q "@earendil-works/pi-coding-agent" && [ -n "$want" ] && [ "$have" = "$want" ]; then
          echo "PI-SKIP: /usr/bin/pi already @earendil-works $have (latest) — no reinstall"
        else
          echo "PI-UPGRADE: have=${have:-none} via=${real:-none} -> @earendil-works@${want:-latest}"
          sudo npm --prefix /usr install -g --force @earendil-works/pi-coding-agent@latest 2>&1 | tail -15
        fi' \
        || { echo "PI-INSTALL-FAIL: @earendil-works install failed on $CELL_WELL — pi may be stale" >&2; return 1; }
      # Confirm a runnable pi (install could report ok yet leave no usable binary).
      well exec -s "$CELL_WELL" -- bash -lc "command -v pi >/dev/null && pi --version >/dev/null 2>&1 && echo PI-BIN-OK" \
        || { echo "PI-BIN-FAIL: /usr/bin/pi not runnable after install on $CELL_WELL" >&2; return 1; }
      # pi 0.79+ (the @earendil rename) gates project .pi/settings.json behind a
      # workspace-trust decision; a non-interactive cell path (pi --print / jobs /
      # talk / heartbeat) resolves UNTRUSTED by default, so pi would silently
      # IGNORE the cell's own extensions/modelChain/provider/thinking. Set the
      # GLOBAL defaultProjectTrust=always (merge-preserving). New cells bake this
      # in via DNA's .pi/agent/settings.json, but `cells refresh` deliberately
      # never rewrites .pi/agent/ (NEVER_PATHS), so the steward sweep must plant
      # it on pre-rename cells. base64-piped to dodge nested-quoting; idempotent.
      echo "ensuring pi project-trust (defaultProjectTrust=always) on $CELL_WELL ..."
      PI_TRUST_B64=$(printf '%s' 'set -e
d="${PI_CODING_AGENT_DIR:-/root/.pi/agent}"
f="$d/settings.json"
mkdir -p "$d"
if [ -s "$f" ] && jq -e . "$f" >/dev/null 2>&1; then
  jq ". + {defaultProjectTrust: \"always\"}" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
else
  printf "%s\n" "{\"defaultProjectTrust\": \"always\"}" > "$f"
fi
chown root:root "$f"' | base64 | tr -d '\n')
      well exec -s "$CELL_WELL" -- bash -lc "echo $PI_TRUST_B64 | base64 -d | sudo bash" \
        || { echo "PI-TRUST-FAIL: could not set defaultProjectTrust on $CELL_WELL" >&2; return 1; }
      # A fresh install lands a PRISTINE pi-ai — the proxy baseUrl, codex, and
      # adaptive-thinking patches are gone. Reapply or an Anthropic-on-Max cell
      # silently reverts to direct api.anthropic.com. apply-pi-patches.sh searches
      # both scopes, so it patches @earendil (and any retained @mariozechner libs);
      # idempotent, so it is a cheap no-op on the PI-SKIP path.
      echo "re-applying pi patches on $CELL_WELL ..."
      well exec -s "$CELL_WELL" -- bash -lc "set -o pipefail; sudo bash /root/scripts/apply-pi-patches.sh 2>&1 | tail -5" \
        || { echo "PI-PATCH-FAIL: apply-pi-patches.sh failed on $CELL_WELL — pi may revert to direct api.anthropic.com" >&2; return 1; }
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
