#!/usr/bin/env bash
# Birth end-test — prove a freshly-imprinted cell's brain answers through the
# proxy. The one synchronous gate after imprint: birth is not "alive" until
# the cell's own CLI responds.
#
# Usage: end-test.sh <well> '<blob-json>'
#   <well>  — the cell's well (cells-<name>)
#   <blob>  — the config blob; the harness is read from it (.harness)
#
# Runs Mac-side. mother calls it via mac_exec during /cell-create; it's the
# same per-harness smoke the claude-code birth skill runs inline, lifted into
# a script so the in-cell (pi) mother doesn't have to construct 4-deep nested
# quotes in a tool call. Echoes the harness's success marker
# (PI-OK / CLAUDE-OK / CODEX-OK / HERMES-OK) on success; exits non-zero otherwise.
#
# sudo + HOME=/root is load-bearing: a bare `well exec` lands as the `well`
# user (HOME=/home/well) and would smoke-test the wrong config tree, not the
# /root/.{pi,claude,codex,hermes} the live cell actually runs from.
set -uo pipefail

WELL="${1:?usage: end-test.sh <well> <blob-json>}"
BLOB="${2:?usage: end-test.sh <well> <blob-json>}"
# Accept `@/path/to/blob.json` as well as raw JSON (see imprint-cell.sh).
[[ "$BLOB" == @* ]] && BLOB="$(cat "${BLOB#@}")"
HARNESS="$(printf '%s' "$BLOB" | jq -r '.harness // "pi"')"

case "$HARNESS" in
  pi)
    well exec -s "$WELL" -- bash -lc "sudo bash -lc 'export HOME=/root; cd /root && source /etc/profile.d/cells-env.sh && timeout 60 pi --print \"say ok\"' && echo PI-OK"
    ;;
  claude-code)
    well exec -s "$WELL" -- bash -lc "sudo bash -lc 'export HOME=/root; cd /root && source /etc/profile.d/cells-env.sh && timeout 60 claude --print \"say ok\"' && echo CLAUDE-OK"
    ;;
  codex)
    well exec -s "$WELL" -- bash -lc "sudo bash -lc 'export HOME=/root; cd /root && source /etc/profile.d/cells-env.sh && timeout 120 codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \"say ok\" < /dev/null' && echo CODEX-OK"
    ;;
  hermes)
    well exec -s "$WELL" -- bash -lc "sudo bash -lc 'export HOME=/root; cd /root && source /etc/profile.d/cells-env.sh && timeout 120 hermes -z \"say ok\"' && echo HERMES-OK"
    ;;
  *)
    echo "end-test: unknown harness '$HARNESS'" >&2
    exit 2
    ;;
esac
