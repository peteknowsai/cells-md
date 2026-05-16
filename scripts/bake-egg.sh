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

# Single SSH session for everything on the egg.
{
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
    # Birth-time session capture: warm up claude twice (main + talk) and
    # cache the session ids. Runtime supervisor always --resumes; no
    # capture branch in the hot path. ~5-8s per warm-up.
    echo "# ===claude session capture ==="
    echo "sudo mkdir -p /root/.cell"
    echo "MAIN_ID=\$(sudo bash -lc 'export HOME=/root IS_SANDBOX=1; cd /root && claude --print ping --output-format stream-json --verbose --permission-mode bypassPermissions 2>/dev/null' | jq -rs 'map(select(.type==\"system\" and .subtype==\"init\")) | .[0].session_id // \"\"')"
    echo "[ -n \"\$MAIN_ID\" ] || { echo 'claude-main-session capture FAILED'; exit 1; }"
    echo "echo \"\$MAIN_ID\" | sudo tee /root/.cell/claude-main-session > /dev/null"
    echo "echo \"  claude main: \$MAIN_ID\""
    echo "TALK_ID=\$(sudo bash -lc 'export HOME=/root IS_SANDBOX=1; cd /root && claude --print ping --output-format stream-json --verbose --permission-mode bypassPermissions 2>/dev/null' | jq -rs 'map(select(.type==\"system\" and .subtype==\"init\")) | .[0].session_id // \"\"')"
    echo "[ -n \"\$TALK_ID\" ] || { echo 'claude-talk-session capture FAILED'; exit 1; }"
    echo "echo \"\$TALK_ID\" | sudo tee /root/.cell/claude-talk-session > /dev/null"
    echo "echo \"  claude talk: \$TALK_ID\""
  elif [ "$HARNESS" = "codex" ]; then
    echo "# ===codex settings ==="
    echo "sudo sed -i \"s/__MODEL__/$MODEL/g; s/__THINKING__/$THINKING/g; s/__NAME__/$NAME/g\" /root/.codex/config.toml"
    echo "! grep -q __ /root/.codex/config.toml"
    # Birth-time thread capture: warm up codex twice (main + talk). codex's
    # thread id rides the first thread.started event. ~10-15s per warm-up
    # (codex is slower than claude — its per-turn model warms cold each call).
    echo "# ===codex thread capture ==="
    echo "sudo mkdir -p /root/.cell"
    echo "MAIN_TID=\$(sudo bash -lc 'export HOME=/root; cd /root && codex exec ping --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox 2>/dev/null' < /dev/null | jq -rs 'map(select(.type==\"thread.started\")) | .[0].thread_id // \"\"')"
    echo "[ -n \"\$MAIN_TID\" ] || { echo 'codex-main-thread capture FAILED'; exit 1; }"
    echo "echo \"\$MAIN_TID\" | sudo tee /root/.cell/codex-main-thread > /dev/null"
    echo "echo \"  codex main: \$MAIN_TID\""
    echo "TALK_TID=\$(sudo bash -lc 'export HOME=/root; cd /root && codex exec ping --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox 2>/dev/null' < /dev/null | jq -rs 'map(select(.type==\"thread.started\")) | .[0].thread_id // \"\"')"
    echo "[ -n \"\$TALK_TID\" ] || { echo 'codex-talk-thread capture FAILED'; exit 1; }"
    echo "echo \"\$TALK_TID\" | sudo tee /root/.cell/codex-talk-thread > /dev/null"
    echo "echo \"  codex talk: \$TALK_TID\""
  fi

  echo "# ===status ==="
  echo "sudo mkdir -p /root/.pi"
  echo "echo '{\"harness\":\"$HARNESS\",\"channels\":[]}' | sudo tee /root/.pi/status.json > /dev/null"
  echo "echo BAKE-OK"
} | well exec -s "$EGG_WELL" -- bash -lc 'bash -es' 2>&1
