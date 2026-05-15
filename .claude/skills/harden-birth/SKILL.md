---
description: "One iteration of the birth/kill hardening loop — plan, run, triage, log."
---

# /harden-birth

You are one iteration of an agentic hardening loop for the cells lifecycle (birth + kill). The user starts this loop with `/loop 1h /harden-birth`. Each fire is a fresh turn — you have no memory of prior fires except what is on disk in `~/.cells/logs/harden/`.

## Your job in one sentence

Read prior state, plan a small set of birth/kill experiments, run them via `scripts/harden-birth.ts`, attempt to fix anything that broke, then update `state.json` (machine state for the next iteration) and `REPORT.md` (human report Pete reads).

## Layout you own

- `~/.cells/logs/harden/state.json` — rolling machine state. You read it and rewrite it. Schema below.
- `~/.cells/logs/harden/REPORT.md` — rolling 1-page human report. You rewrite it from scratch each iteration. Schema below.
- `~/.cells/logs/harden/runs/<iso>.json` — per-run record written by the script. Append-only; prune entries older than 7 days.

## Step-by-step

### 1. Read prior state

- Read `~/.cells/logs/harden/state.json` if it exists. Schema:
  ```json
  {
    "schemaVersion": 1,
    "lastIterationAt": "2026-05-05T17:00:00Z",
    "agedCell": { "name": "harden-foo-1234", "bornAt": "iso", "killAt": "iso" } | null,
    "knownOrphans": ["harden-x-..."],
    "comboCoverage": { "<id>": { "lastPass": "iso"|null, "lastFail": "iso"|null, "passCount": N, "failCount": N } },
    "openFixAttempts": [{ "iterationAt": "iso", "summary": "...", "filesEdited": ["..."], "confirmed": false }],
    "iterations": [
      { "at": "iso", "ok": true, "births": 3, "birthsOk": 3, "kills": 3, "killsOk": 3, "recordPath": "..." }
    ]
  }
  ```
- If absent, treat all fields as empty defaults.

### 2. Discover orphans

- Run `cells list` (or read `~/.cells/cells.json` directly) and collect every cell whose name starts with `harden-`.
- Subtract this iteration's planned aged cell. Anything else is an orphan from a previous failed run — sweep it.

### 3. Plan this iteration

Decide:
- **How many combos**: 3 by default. Drop to 1 if the previous iteration hit failures and you're testing a fix.
- **Combo override**: if you edited code last iteration to fix a specific combo and that combo isn't already in the deterministic schedule, re-run it explicitly via `--combo=<id>`.
- **Aged cell to kill this iteration**: if `state.agedCell` is set and `now >= state.agedCell.killAt`, pass it to the script via `--age=<name>`. After the run, clear `state.agedCell` (or move to a new one — see below).
- **Whether to age a fresh cell**: if there is no current aged cell, pick one of this iteration's births to leave alive. Strategy: don't kill it during this script invocation. (Easiest implementation: omit it from the kill list — but the script currently kills *all* paired births. Implementation note: until the script grows an `--age-skip-kill` flag, age-by-rebirth: leave aging *off* for v1; just exercise paired + orphan kills. Add aged kills once the v1 paired+orphan flow is stable.)

### 4. Run the script

```bash
cd /Users/pete/Projects/cells
bun scripts/harden-birth.ts --combos=3 [--orphans=name1,name2] [--age=name]
```

Default `--combos=3` is sized for the hourly cron cadence — each combo takes ~5min serialized (mother concurrency=1), so 3 combos ≈ 15min/iteration with 45min headroom for triage and self-healing. Drop to `--combos=1` if you're confirming a recent fix.

The script writes a run record to `~/.cells/logs/harden/runs/<iso>.json` and exits 0 on completion (regardless of birth/kill outcomes).

### 5. Triage failures

Open the just-written run record. For each failure, attempt a fix and log what you tried. **You are permitted** to:

- **Stuck cells** (kill failed, sprite still exists): re-run `cells kill <name> --yes`. If still stuck, call sprite_destroy directly via the sprites API (read `~/.cells/secrets.json` for `SPRITES_TOKEN`, DELETE `https://api.sprites.dev/v1/sprites/<name>`).
- **Worker leak** (kill verified clean except worker — can only check by trying to delete): re-run the kill, which is idempotent.
- **Slack channel still live**: archive via Slack API directly (POST `https://slack.com/api/conversations.archive`, token in `~/.cells/secrets.json` as `SLACK_BOT_TOKEN`).
- **Vault dir lingering**: `rm -rf ~/Obsidian/cells/<name>`.
- **Pulse cache lingering**: `rm ~/.cells/pulse-cache/<name>.json` and `~/.cells/pulse-inbox/[processed/]<name>-*.md`.
- **Code-level bug confidently localized in `cli/cells.ts` or `scripts/harden-birth.ts`**: edit the file, log the diff (file:line summary) into `state.openFixAttempts`. The next iteration confirms the fix.

You are **not** permitted to:
- Modify the birth skill (`dna/specials/mother/.pi/skills/birth/SKILL.md`) or destroy prompt — hardening exercises those, doesn't rewrite them.
- Push to remote.
- Touch unrelated files.
- Commit to `main` (per Pete's git rules — feature branch only).

### 6. Update state.json

Rewrite `~/.cells/logs/harden/state.json` with:
- `lastIterationAt` = now
- `iterations` — append this iteration's summary, keep last 24 entries
- `comboCoverage` — for each combo run, update `lastPass`/`lastFail` and counts
- `knownOrphans` — surviving harden-* cells in registry after this run
- `openFixAttempts` — append any code edits you made this iteration; mark prior open attempts `confirmed: true` if their target combo passed this run
- `agedCell` — set/clear per planning step

### 7. Rewrite REPORT.md

Rewrite `~/.cells/logs/harden/REPORT.md` from scratch. **Voice: field report, not dashboard.** Pete wants to read prose and bullets, not parse tables. Imagine you're the operator of this thing writing a short daily-standup-style update for someone who hasn't been watching. Plainspoken, opinionated where useful, narrative shape.

Target length: ~1 screen. No data tables unless one is genuinely the clearest way to show something (rare). Numbers belong inside sentences ("most births finished in around four and a half minutes; the slowest was just under seven"), not in cells.

Section shape (use these headings; fill with prose + bullets):

```markdown
# Cells birth/kill hardening — field report · <local time>

## Headline
One sentence answering: "If I birthed a cell right now, would it work?" Use words like "yes, mostly", "shaky on these specific combos", "broken — don't try until X is fixed". Concrete and direct.

## What happened this hour
Two-to-four sentences describing the runs that just fired. Which combos. How they went. What stood out — fast, slow, surprising, predictable. Mention any combo that did something different than expected (suddenly fast, suddenly slow, finally passed after flaking).

## How it's trending
A paragraph comparing the last 24h to the 7-day baseline. Did combo-clean rate go up or down? Did any combo flip from flaky to reliable, or reliable to flaky? Are births getting faster, slower, or the same? Frame as movement: "we're up six points on combo-clean rate this week," not "87% vs 71%."

If there isn't enough data yet for a real trend, say so plainly in one sentence. Don't fake it.

## What's broken right now
Bullets, one per active failure mode. Each bullet: what fails, the smallest reproducer (which combo, which step), the suspected cause if we have one, and whether we're already attempting a fix. Use plain English ("the wrangler deploy times out about half the time on Tuesday afternoons" beats "deployCellWorker error rate elevated").

If nothing is broken, write one line: "Nothing actively broken. <details>"

## Fixes in flight
Bullets for any code edits the loop attempted that haven't been confirmed yet. Each bullet: file (with line range), one-sentence what you changed, one-sentence why you think it'll help, what we'll see in the next iteration if it worked.

If no open fixes, omit the section entirely.

## Watching for
One or two bullets on what would change the picture. "If gpt55 birth fails the next two times, that's a real regression — we have one more sample to confirm." "Once we've seen sonnet-full pass three times in a row, we can stop sampling it daily." Forward-looking, not retrospective.

## Pointers
- Latest desktop snapshot: `~/Desktop/egg_report_<N>.md`
- Run records: `~/.cells/logs/harden/runs/`
- This report rewrites every hour at :07.
```

**Field-report rules of the road:**
- Plain English over jargon. "The mother agent timed out" beats "outcome was null on cell-destroy".
- Specific over vague. "Step 6c (proxy-wire) took 90 seconds, three times longer than usual" beats "step 6c was slow."
- Cite combos by name (`gpt55`, `sonnet-full`). They're proper nouns in this report.
- Cause and effect together. Don't list a failure without (at least a guess at) why.
- One sentence on next move when relevant. "We'll know in the next iteration whether the wrangler retry helps."
- Direction over magnitude when reading is more important than precision. "Up a few points" is fine; "+5.7pp from 71.2% to 76.9%" is over-precise.

Compute the underlying numbers from `runs/*.json` and `state.json` exactly as before — just write *about* them, don't paste them.

**Also write a sequenced copy to Pete's Desktop.** Each iteration appends a new file (do not overwrite). Numbering rule: find the highest existing `egg_report_<N>.md` in `~/Desktop/`, write `egg_report_<N+1>.md` with the same content as `REPORT.md`. If no egg_report files exist yet, start at `egg_report_1.md`. Add a small header line at the top of the desktop copy noting the iteration number and timestamp so Pete can read them in order without sorting.

```bash
# Compute next sequence number (works even when no files match):
NEXT=$(ls ~/Desktop/egg_report_*.md 2>/dev/null \
  | sed 's/.*egg_report_\([0-9]*\)\.md/\1/' \
  | sort -n | tail -1)
NEXT=$((${NEXT:-0} + 1))
# then write ~/Desktop/egg_report_${NEXT}.md
```

If everything is clean, the file should still be rewritten but the table can collapse to one line ("✓ all combos clean — N runs across M combos in 24h").

### 8. Alert on surviving failures

Only after fix attempts. If anything is still broken, post a one-line message to Slack channel `#cells-harden` (use `~/.cells/secrets.json` `SLACK_BOT_TOKEN`, `chat.postMessage`). The channel may not exist — if Slack returns `channel_not_found`, log it to stderr and continue. Don't let alerting failures hide the original failure.

### 9. Prune old run records

Delete `~/.cells/logs/harden/runs/*.json` whose mtime is more than 7 days old.

## What to print to the user

End every fire with a brief in-conversation update so Pete sees evolution without flipping to files. Target: 5–8 lines, terse, scannable. Always include:

1. **Iteration header**: `Run #N · <local time> · combos: a, b, c · result: M of N clean`
2. **One line per combo this fire**: `· min ✓ birth 4:30 / kill 16s` or `· gpt55 ✗ birth (step 6c timeout)`
3. **Trend pulse**: 24h combo-clean rate vs 7d baseline with arrow. One line. Skip if not enough data yet.
4. **What you tried to fix** (if anything): `Fix attempted: cli/cells.ts:1340 — wrangler retry on rate limit. Awaiting next iteration to confirm.`
5. **Pointer**: `Detail: ~/Desktop/egg_report_<N>.md`

Skip rules:
- All combos clean and no fix attempts → just lines 1, 2, 3, 5. Skip 4.
- Same failure mode as last 2+ iterations → don't restate the cause; one-line `(see prior — same failure)` and link the report.
- Loop is genuinely boring and clean for 6+ consecutive fires → drop to a single line: `Run #N · all clean · trend ↑/→/↓ · detail: <path>`.

The conversation update is the *quick read*; `REPORT.md` and the desktop snapshot are the deep read. Don't duplicate paragraphs of detail in chat.
