#!/usr/bin/env bash
# Imprint a generic egg with the new cell's identity + model config in one
# shot. Replaces ~5 small SSH-and-sed calls with one Mac-side script that
# handles the escaping correctly.
#
# Usage:
#   bake-egg.sh <egg-well> <name> <blob-json>
#
# The blob is the same JSON object birth orchestrator builds (harness,
# model, provider, thinking, extensions, chain). We parse it here so the
# LLM caller doesn't need any jq.
#
# After this script exits 0, the egg is ready for the end-test (pi --print).
set -euo pipefail

EGG_WELL="${1:?egg-well required}"
NAME="${2:?cell name required}"
BLOB="${3:?blob JSON required}"

HARNESS=$(echo "$BLOB" | jq -r '.harness // "pi"')
MODEL=$(echo "$BLOB" | jq -r '.model // empty')
PROVIDER=$(echo "$BLOB" | jq -r '.provider // empty')
THINKING=$(echo "$BLOB" | jq -r '.thinking // "high"')
CHAIN_JSON=$(echo "$BLOB" | jq -c '.chain // []')
EXTENSIONS=$(echo "$BLOB" | jq -r '.extensions[]? // empty')
PACKAGES=$(echo "$BLOB" | jq -r '.packages[]? // empty')
# Runtime-DNA rev (cli/lib/dna-rev.ts), computed Mac-side from the same DNA
# tree the overlay below tars in. Stamped onto /root/.dna-rev so a cell born
# from a stale egg reads CURRENT — the re-overlay made it current. Empty if
# an older caller didn't supply it; the stamp is then skipped (cell reads as
# "unknown", which the doctor/steward treat as don't-touch, not stale).
DNA_REV=$(echo "$BLOB" | jq -r '.dna_rev // empty')

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Compute color chip (cell-color.sh prints "BG FG" on one line).
read -r CBG CFG < <(bash "$REPO_ROOT/scripts/cell-color.sh" "$NAME")

# Build the substituted .pi/settings.json on the Mac, then push it via SSH.
# Cleaner than escaping JSON through three quote levels.
if [ "$HARNESS" = "pi" ]; then
  SETTINGS_PI=$(jq --arg m "$MODEL" --arg p "$PROVIDER" --arg t "$THINKING" --argjson c "$CHAIN_JSON" \
    '.defaultModel=$m | .defaultProvider=$p | .defaultThinkingLevel=$t | .modelChain=$c' \
    "$REPO_ROOT/dna/cells/base/.pi/settings.json")

  # Add requested extensions (filter to those not already present).
  if [ -n "$EXTENSIONS" ]; then
    for ext in $EXTENSIONS; do
      SETTINGS_PI=$(echo "$SETTINGS_PI" | jq --arg p ".pi/extensions/$ext/index.ts" \
        'if (.extensions | index($p)) then . else .extensions += [$p] end')
    done
  fi

  # Add requested packages (npm:<name> entries). Same idempotency.
  if [ -n "$PACKAGES" ]; then
    for pkg in $PACKAGES; do
      SETTINGS_PI=$(echo "$SETTINGS_PI" | jq --arg p "npm:$pkg" \
        'if (.packages | index($p)) then . else .packages += [$p] end')
    done
  fi
fi

# Re-overlay current DNA onto the egg before imprinting it. A pool egg
# carries the DNA snapshot from when it was baked; by the time it's claimed
# that snapshot can be stale — the agent-comms code (bin/cells, lib/,
# site/server.ts), harness configs and skills all move faster than the pool
# cycles, so a cell hatched from an old egg inherits old DNA. Re-pushing
# dna/cells/base makes every cell born current regardless of its egg's age.
# tar-extract is overlay-only (it overwrites and adds, never deletes), and
# the fresh files still carry their __NAME__/__MODEL__/__THINKING__
# placeholders — the SSH block below does the substitution on these copies.
# --no-same-owner: the tarball is built on the Mac, so its entries carry the
# Mac uid (501). Without this, root's tar restores 501:staff on every
# extracted file — invisible inside the VM and inconsistent with /root. The
# flag makes tar assign extracted files to the extracting user (root).
tar czf - -C "$REPO_ROOT/dna/cells/base" . \
  | well exec -s "$EGG_WELL" -- bash -c 'sudo bash -c "cd /root && tar --no-same-owner -xzf -"'

# Single SSH session for everything on the egg.
{
  echo "# ===clock sync ==="
  # chrony defaults to step-only-at-startup. Hibernated wells wake with a
  # stale RTC; chrony sees a multi-minute offset but falls back to slewing,
  # which never catches up. `makestep 1.0 -1` tells it to step whenever the
  # offset exceeds 1s, regardless of measurement count. Without this, fresh
  # envelopes generated on a recently-woken cell appear "expired" to the
  # worker (Phase 0 of agent-comms hit this on cells-narrator at 49 min behind).
  #
  # REPLACE the stock line, don't append-if-absent: Ubuntu's chrony.conf
  # ships `makestep 1 3` (step only in the first 3 measurements), so the
  # old `if ! grep makestep` guard never fired and every egg baked through
  # 2026-06-11 shipped with stock stepping — the advisor-pete CLI-talk
  # outage (envelopes expired-on-arrival at the DO, 356s skew) was this.
  echo "if sudo grep -q '^makestep' /etc/chrony/chrony.conf 2>/dev/null; then"
  echo "  sudo sed -i 's/^makestep.*/makestep 1.0 -1/' /etc/chrony/chrony.conf"
  echo "else"
  echo "  echo 'makestep 1.0 -1' | sudo tee -a /etc/chrony/chrony.conf > /dev/null"
  echo "fi"
  echo "sudo systemctl restart chrony 2>/dev/null || true"
  echo "sudo chronyc makestep > /dev/null 2>&1 || true"

  # Harness drift guard: post-birth update-cell-harness.sh runs ONCE; without
  # an ongoing mechanism every cell freezes at its birth version (found
  # 2026-06-12: whole fleet was 2.1.148-160 vs 2.1.176). The claude binary
  # self-updates only in interactive sessions, never under --print. A daily
  # timer covers it; Persistent=true catches up after hibernation. Claude
  # only — pi updates need patch reapplication and stay deliberate.
  echo "# ===claude auto-update timer ==="
  echo "sudo tee /etc/systemd/system/claude-update.service > /dev/null <<'UNIT'"
  echo "[Unit]"
  echo "Description=Update the Claude Code binary (harness drift guard)"
  echo "After=network-online.target"
  echo "Wants=network-online.target"
  echo ""
  echo "[Service]"
  echo "Type=oneshot"
  echo "Environment=HOME=/root"
  echo "ExecStart=/bin/bash -lc 'claude update'"
  echo "UNIT"
  echo "sudo tee /etc/systemd/system/claude-update.timer > /dev/null <<'UNIT'"
  echo "[Unit]"
  echo "Description=Daily Claude Code update"
  echo ""
  echo "[Timer]"
  echo "OnCalendar=daily"
  echo "RandomizedDelaySec=3600"
  echo "Persistent=true"
  echo ""
  echo "[Install]"
  echo "WantedBy=timers.target"
  echo "UNIT"
  echo "sudo systemctl daemon-reload"
  echo "sudo systemctl enable --now claude-update.timer > /dev/null 2>&1 || true"

  echo "# ===dna perms ==="
  # The DNA overlay carries each file's mode from the repo; make sure the
  # bin/ entries are executable regardless of how the working copy was
  # checked out (git mode bits don't always survive every clone/zip path).
  echo "sudo chmod +x /root/bin/* 2>/dev/null || true"

  # ===dna rev stamp ===
  # Record the runtime-DNA rev the overlay above landed at. The doctor
  # compares this against the repo's current rev; the steward refreshes a
  # cell whose stamp falls behind. Skipped (left absent → "unknown") when no
  # rev was supplied, so this never breaks an older birth path.
  if [ -n "$DNA_REV" ]; then
    echo "echo '$DNA_REV' | sudo tee /root/.dna-rev > /dev/null"
  fi

  echo "# ===identity ==="
  echo "sudo sed -i 's/__NAME__/$NAME/g' /root/AGENTS.md /root/CLAUDE.md /root/SOUL.md /root/IDENTITY.md /root/CELLS.md /root/CONTACTS.md /root/HEARTBEAT.md /root/package.json 2>/dev/null || true"
  echo "sudo sed -i 's|__CELL_BG__|$CBG|g; s|__CELL_FG__|$CFG|g; s|__NAME__|$NAME|g' /root/.tmux.conf"
  # Canonical cell name in /etc/environment — the one identity source every
  # shell sees (cells-env.sh sources it). The anatomy-heading heuristic is a
  # fragile fallback: a cell cloned off another (e.g. cellA off cellB)
  # carries the wrong name in AGENTS.md/CLAUDE.md. `cells talk` builds
  # reply_to from CELL_NAME — get it wrong and replies route to the wrong
  # cell (or 404). No quotes: PAM's /etc/environment parser is not a shell.
  echo "sudo sed -i '/^CELL_NAME=/d' /etc/environment 2>/dev/null || true"
  echo "echo 'CELL_NAME=$NAME' | sudo tee -a /etc/environment > /dev/null"

  # .claude/settings.json is imprinted for EVERY harness, not just
  # claude-code: the deep-research extension shells out to the claude
  # binary from pi cells, and that call rides this file's proxy base URL +
  # x-cell-name header. An unimprinted header (`x-cell-name: __NAME__`)
  # 403s at the proxy gate (codex review, 2026-06-11). Non-claude-code
  # harnesses get the deep-lane defaults (opus/high) — chat config lives
  # in their own harness tree; deep_research passes --model opus anyway.
  echo "# ===claude settings (all harnesses — deep-research rides them) ==="
  if [ "$HARNESS" = "claude-code" ]; then
    echo "sudo sed -i \"s/__MODEL__/$MODEL/g; s/__THINKING__/$THINKING/g; s/__NAME__/$NAME/g\" /root/.claude/settings.json"
  else
    echo "sudo sed -i \"s/__MODEL__/opus/g; s/__THINKING__/high/g; s/__NAME__/$NAME/g\" /root/.claude/settings.json"
  fi
  echo "jq . /root/.claude/settings.json > /dev/null"

  if [ "$HARNESS" = "pi" ]; then
    echo "# ===pi settings ==="
    echo "sudo tee /root/.pi/settings.json > /dev/null <<'PI_SETTINGS_EOF'"
    echo "$SETTINGS_PI"
    echo "PI_SETTINGS_EOF"
    echo "jq . /root/.pi/settings.json > /dev/null"

    # pi + Anthropic runs on the Max sub via proxy.cells.md (the egg's pi-ai
    # already has its Anthropic baseUrl swapped to the proxy by the
    # apply-pi-patches.sh postinstall hook). No /root/.anthropic-direct flag:
    # that flag would restore the direct api.anthropic.com baseUrl, which only
    # works with a paid key — the opposite of what we want.
  elif [ "$HARNESS" = "claude-code" ]; then
    # (.claude/settings.json already imprinted above, for all harnesses.)
    # Birth-time session capture: warm up claude once and cache the session
    # id. Runtime supervisor always --resumes; no capture branch in the hot
    # path. The agent-comms primitive forks main rather than maintaining a
    # parallel talk-session, so we don't pre-warm a talk id (was used by
    # the now-retired Mac-side `cells talk` scratch path). ~5-8s.
    echo "# ===claude session capture ==="
    echo "sudo mkdir -p /root/.cell"
    echo "MAIN_ID=\$(sudo bash -lc 'export HOME=/root IS_SANDBOX=1; cd /root && claude --print ping --output-format stream-json --verbose --permission-mode bypassPermissions 2>/dev/null' < /dev/null | jq -rs 'map(select(.type==\"system\" and .subtype==\"init\")) | .[0].session_id // \"\"')"
    echo "[ -n \"\$MAIN_ID\" ] || { echo 'claude-main-session capture FAILED'; exit 1; }"
    echo "echo \"\$MAIN_ID\" | sudo tee /root/.cell/claude-main-session > /dev/null"
    echo "echo \"  claude main: \$MAIN_ID\""
  elif [ "$HARNESS" = "codex" ]; then
    echo "# ===codex settings ==="
    echo "sudo sed -i \"s/__MODEL__/$MODEL/g; s/__THINKING__/$THINKING/g; s/__NAME__/$NAME/g\" /root/.codex/config.toml"
    echo "! grep -q __ /root/.codex/config.toml"
    # Birth-time thread capture: warm up codex once. codex's thread id
    # rides the first thread.started event. The agent-comms primitive forks
    # main rather than maintaining a parallel talk-thread, so we don't
    # pre-warm a talk id (was used by the now-retired Mac-side scratch
    # path). ~10-15s (codex per-turn model warms cold each call).
    echo "# ===codex thread capture ==="
    echo "sudo mkdir -p /root/.cell"
    echo "MAIN_TID=\$(sudo bash -lc 'export HOME=/root; cd /root && codex exec ping --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox 2>/dev/null' < /dev/null | jq -rs 'map(select(.type==\"thread.started\")) | .[0].thread_id // \"\"')"
    echo "[ -n \"\$MAIN_TID\" ] || { echo 'codex-main-thread capture FAILED'; exit 1; }"
    echo "echo \"\$MAIN_TID\" | sudo tee /root/.cell/codex-main-thread > /dev/null"
    echo "echo \"  codex main: \$MAIN_TID\""
  elif [ "$HARNESS" = "hermes" ]; then
    echo "# ===hermes settings ==="
    # Self-heal a stale egg. The egg pool predates the hermes harness, so
    # pre-merge eggs ship pi/claude/codex but no hermes binary. Install it
    # on demand; fresh eggs (baked post-merge by bakePoolMember, step 5c)
    # already have it, so this is a no-op there. Version tag is kept in
    # sync with that recipe in cli/cells.ts.
    echo "if ! command -v hermes >/dev/null 2>&1; then"
    echo "  echo '  hermes binary missing on this egg — installing…'"
    echo "  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/v2026.5.16/scripts/install.sh | sudo bash -s -- --skip-setup --skip-browser --branch v2026.5.16"
    echo "fi"
    echo "command -v hermes >/dev/null 2>&1 || { echo 'hermes binary still missing after install'; exit 1; }"
    # The DNA overlay above landed a fresh /root/.hermes/config.yaml — still
    # carrying its __MODEL__/__THINKING__ placeholders. Substitute them now.
    echo "sudo sed -i \"s/__MODEL__/$MODEL/g; s/__THINKING__/$THINKING/g\" /root/.hermes/config.yaml"
    echo "! grep -q __ /root/.hermes/config.yaml"
    # hermes loads its persona from \$HERMES_HOME/SOUL.md (= /root/.hermes/SOUL.md);
    # the cell's SOUL.md lives at /root/SOUL.md. Symlink so hermes finds it and
    # edits track. No birth-time session capture — the host-bridge adapter
    # resumes the latest session (session.most_recent) or creates one at connect.
    echo "sudo ln -sf /root/SOUL.md /root/.hermes/SOUL.md"
  fi

  echo "# ===supervisor refresh ==="
  # The DNA overlay replaced site/server.ts + lib/ on disk. If well-site is
  # already running on this egg it's still holding the pre-overlay code in
  # memory — try-restart picks up the fresh supervisor. No-op if it isn't
  # running (it'll start fresh on the next boot regardless).
  echo "sudo systemctl try-restart well-site.service 2>/dev/null || true"

  echo "# ===status ==="
  echo "sudo mkdir -p /root/.pi"
  echo "echo '{\"harness\":\"$HARNESS\",\"channels\":[]}' | sudo tee /root/.pi/status.json > /dev/null"
  echo "echo BAKE-OK"
} | well exec -s "$EGG_WELL" -- bash -lc 'bash -es' 2>&1
