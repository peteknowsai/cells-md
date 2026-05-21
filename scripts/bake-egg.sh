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

# hermes DNA — config.yaml + the provider plugin — postdates the current
# egg pool: eggs baked before the hermes harness merged have no
# /root/.hermes at all. Push it fresh from the Mac so a hermes birth works
# on any egg regardless of when its pool was baked; the SSH block below then
# substitutes __MODEL__/__THINKING__ into the config it lands.
if [ "$HARNESS" = "hermes" ]; then
  tar czf - -C "$REPO_ROOT/dna/cells/base" .hermes \
    | well exec -s "$EGG_WELL" -- bash -c 'sudo bash -c "cd /root && tar xzf -"'
fi

# Single SSH session for everything on the egg.
{
  echo "# ===clock sync ==="
  # chrony defaults to step-only-at-startup. Hibernated wells wake with a
  # stale RTC; chrony sees a multi-minute offset but falls back to slewing,
  # which never catches up. `makestep 1.0 -1` tells it to step whenever the
  # offset exceeds 1s, regardless of measurement count. Without this, fresh
  # envelopes generated on a recently-woken cell appear "expired" to the
  # worker (Phase 0 of agent-comms hit this on cells-narrator at 49 min behind).
  echo "if ! sudo grep -q '^makestep' /etc/chrony/chrony.conf 2>/dev/null; then"
  echo "  echo 'makestep 1.0 -1' | sudo tee -a /etc/chrony/chrony.conf > /dev/null"
  echo "  sudo systemctl restart chrony 2>/dev/null || true"
  echo "  sudo chronyc makestep > /dev/null 2>&1 || true"
  echo "fi"

  echo "# ===identity ==="
  echo "sudo sed -i 's/__NAME__/$NAME/g' /root/AGENTS.md /root/CLAUDE.md /root/SOUL.md /root/IDENTITY.md /root/CELLS.md /root/CONTACTS.md /root/HEARTBEAT.md /root/package.json 2>/dev/null || true"
  echo "sudo sed -i 's|__CELL_BG__|$CBG|g; s|__CELL_FG__|$CFG|g; s|__NAME__|$NAME|g' /root/.tmux.conf"

  if [ "$HARNESS" = "pi" ]; then
    echo "# ===pi settings ==="
    echo "sudo tee /root/.pi/settings.json > /dev/null <<'PI_SETTINGS_EOF'"
    echo "$SETTINGS_PI"
    echo "PI_SETTINGS_EOF"
    echo "jq . /root/.pi/settings.json > /dev/null"

    # Anthropic-direct flag for paid pi cells on Anthropic.
    if [ "$PROVIDER" = "anthropic" ]; then
      echo "sudo touch /root/.anthropic-direct"
      echo "sudo bash /root/scripts/apply-pi-patches.sh"
    fi
  elif [ "$HARNESS" = "claude-code" ]; then
    echo "# ===claude settings ==="
    echo "sudo sed -i \"s/__MODEL__/$MODEL/g; s/__THINKING__/$THINKING/g; s/__NAME__/$NAME/g\" /root/.claude/settings.json"
    echo "jq . /root/.claude/settings.json > /dev/null"
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
    # .hermes/ was pushed fresh from the Mac above (it postdates the egg
    # pool), so config.yaml is guaranteed present here.
    echo "sudo sed -i \"s/__MODEL__/$MODEL/g; s/__THINKING__/$THINKING/g\" /root/.hermes/config.yaml"
    echo "! grep -q __ /root/.hermes/config.yaml"
    # hermes loads its persona from \$HERMES_HOME/SOUL.md (= /root/.hermes/SOUL.md);
    # the cell's SOUL.md lives at /root/SOUL.md. Symlink so hermes finds it and
    # edits track. No birth-time session capture — the host-bridge adapter
    # resumes the latest session (session.most_recent) or creates one at connect.
    echo "sudo ln -sf /root/SOUL.md /root/.hermes/SOUL.md"
  fi

  echo "# ===status ==="
  echo "sudo mkdir -p /root/.pi"
  echo "echo '{\"harness\":\"$HARNESS\",\"channels\":[]}' | sudo tee /root/.pi/status.json > /dev/null"
  echo "echo BAKE-OK"
} | well exec -s "$EGG_WELL" -- bash -lc 'bash -es' 2>&1
