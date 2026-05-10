#!/usr/bin/env bash
# birth-jury.sh — provision the Jury Pool on cells.
#
# Usage:
#   bash projects/jury/birth-jury.sh              # birth all 10
#   bash projects/jury/birth-jury.sh <name>       # one specific
#   bash projects/jury/birth-jury.sh --customize  # skip births, just (re)customize alive cells
#
# Idempotent — if a cell already exists in ~/.cells/cells.json we skip its
# birth and only re-run customization (SOUL injection, foreman extension push).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
JURY_DIR="$ROOT/projects/jury"
PERSONAS_DIR="$JURY_DIR/personas"
EXT_DIR="$JURY_DIR/extension/deliberate"
ARCHIVED_PERSONAS="$HOME/Projects/archived/jurypool/.pi/agents"

ALL_CELLS=(jesus buddha rumi marcus-aurelius lao-tzu confucius tesla fuller gandhi foreman)
JUROR_CELLS=(jesus buddha rumi marcus-aurelius lao-tzu confucius tesla fuller gandhi)

CUSTOMIZE_ONLY=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --customize) CUSTOMIZE_ONLY=1 ;;
    *) TARGET="$arg" ;;
  esac
done

cell_alive() {
  local name="$1"
  jq -e --arg n "$name" '.cells[] | select(.name == $n)' ~/.cells/cells.json >/dev/null 2>&1
}

birth_cell() {
  local name="$1"
  if cell_alive "$name"; then
    echo "[$name] already alive, skipping birth"
    return 0
  fi
  echo "[$name] birthing..."
  # All cells: pi harness, sonnet, with memory + dream for persona persistence
  cd "$ROOT" && bun run cli/cells.ts birth "$name" \
    --model=sonnet \
    --thinking=low \
    --extensions=memory,dream \
    --packages=pi-web-access
}

# Build a SOUL.md for a juror by combining the cells SOUL template with the
# philosopher's persona body (from archived/jurypool).
build_juror_soul() {
  local name="$1"
  local src="$ARCHIVED_PERSONAS/$name.md"
  if [[ ! -f "$src" ]]; then
    echo "ERROR: persona file missing: $src" >&2
    return 1
  fi
  # Strip frontmatter (everything between the first --- ... --- pair).
  local body
  body=$(awk 'BEGIN{fm=0} /^---$/{fm++; next} fm>=2{print}' "$src")

  cat <<EOF
---
name: $name
description: Jury Pool — a member of the Foreman's council
model: claude-sonnet-4-6
---

# Your name is $name

You are a member of the **Jury Pool** — a council of nine wise minds. The
Foreman convenes you when someone needs deliberation. Speak in your
authentic voice as described below.

When invoked via \`pi -p\` you'll receive a deliberation prompt. Reply with
your perspective and only your perspective — no preamble, no meta. The
Foreman will synthesize.

Your memory at \`state/memory/\` persists across deliberations. Over time,
build understanding of the people you advise. Yearnings (open questions)
sharpen your wisdom.

---

$body
EOF
}

build_foreman_soul() {
  local persona
  persona=$(cat "$PERSONAS_DIR/foreman.md")
  cat <<EOF
---
name: foreman
description: The Jury Pool Foreman — facilitates deliberation
model: claude-sonnet-4-6
---

# Your name is foreman

You preside over the Jury Pool — nine philosopher cells (jesus, buddha,
rumi, marcus-aurelius, lao-tzu, confucius, tesla, fuller, gandhi). You
have a special tool, \`deliberate\`, that convenes them in parallel.

Your memory at \`state/memory/\` persists across questions. Over time you
learn the patterns of each juror and the people you serve.

---

$persona
EOF
}

# Push a string as a file to a cell via well exec (avoids size limits of
# arg passing — write to /tmp first via stdin redirection).
push_string() {
  local name="$1"
  local remote="$2"
  local content="$3"
  # Use well exec with stdin
  printf '%s' "$content" | well exec -s "$name" -- bash -c "cat > $remote"
}

customize_juror() {
  local name="$1"
  ech{